import crypto from 'node:crypto';
import { resolveUserSelect, applyUserSelect, splitUserPatch, assembleUser } from '../util/user-mapping.js';

/** @implements {import('@okeav/idp-core/src/storage/interfaces.js').UserRepository} */
export class PgUserRepository {
    constructor(pool, { hashEmail, normalizeEmail }) {
        this.pool = pool;
        this.hashEmail = hashEmail;
        this.normalizeEmail = normalizeEmail;
    }

    async _loadFull(id, client = this.pool) {
        const { rows: [userRow] } = await client.query('SELECT * FROM idp_users WHERE id = $1', [id]);
        if (!userRow) return null;
        const [{ rows: externalProviders }, { rows: recoveryCodes }] = await Promise.all([
            client.query('SELECT * FROM idp_user_external_providers WHERE user_id = $1', [id]),
            client.query('SELECT * FROM idp_user_recovery_codes WHERE user_id = $1 ORDER BY position ASC', [id]),
        ]);
        return assembleUser(userRow, { externalProviders, recoveryCodes });
    }

    async create(data) {
        const id = crypto.randomUUID();
        const normalizedEmail = this.normalizeEmail(data.email);
        const emailHash = this.hashEmail(data.email);
        const profile = data.profile || {};

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO idp_users (
                    id, email, email_hash, password_hash, status,
                    profile_first_name, profile_last_name, profile_display_name, profile_avatar_url, profile_locale, profile_zoneinfo,
                    metadata
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                [
                    id, normalizedEmail, emailHash, data.passwordHash || null, data.status || 'PENDING_VERIFICATION',
                    profile.firstName || null, profile.lastName || null, profile.displayName || null, profile.avatarUrl || null,
                    profile.locale || 'en', profile.zoneinfo || null, JSON.stringify(data.metadata || {}),
                ]
            );
            for (const ep of data.externalProviders || []) {
                await client.query(
                    `INSERT INTO idp_user_external_providers (user_id, provider, provider_id, email, connected_at) VALUES ($1,$2,$3,$4,$5)`,
                    [id, ep.provider, ep.providerId, ep.email || null, ep.connectedAt || new Date()]
                );
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }

        return this._loadFull(id);
    }

    async findById(id, opts = {}) {
        const user = await this._loadFull(id);
        return applyUserSelect(user, resolveUserSelect(opts.select));
    }

    async findByEmail(email, opts = {}) {
        const normalizedEmail = this.normalizeEmail(email);
        const emailHash = this.hashEmail(email);
        const { rows: [userRow] } = await this.pool.query(
            'SELECT id FROM idp_users WHERE email_hash = $1 OR email = $2',
            [emailHash, normalizedEmail]
        );
        if (!userRow) return null;
        const user = await this._loadFull(userRow.id);
        return applyUserSelect(user, resolveUserSelect(opts.select));
    }

    async findByExternalProvider(provider, providerId) {
        const { rows: [row] } = await this.pool.query(
            `SELECT user_id FROM idp_user_external_providers WHERE provider = $1 AND provider_id = $2`,
            [provider, providerId]
        );
        if (!row) return null;
        return this._loadFull(row.user_id);
    }

    async updateById(id, patch, opts = {}) {
        const { columnSets, recoveryCodesReplace, recoveryCodeConsume } = splitUserPatch(patch);

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            if (columnSets.length > 0) {
                const setClauses = columnSets.map((c, i) => `${c.column} = $${i + 2}`);
                setClauses.push('updated_at = now()');
                await client.query(
                    `UPDATE idp_users SET ${setClauses.join(', ')} WHERE id = $1`,
                    [id, ...columnSets.map((c) => c.value)]
                );
            } else {
                // Nothing on the users table itself changed (e.g. a pure
                // recovery-codes replace), but Mongo's timestamps:true bumps
                // updatedAt on ANY findByIdAndUpdate — mirror that.
                await client.query('UPDATE idp_users SET updated_at = now() WHERE id = $1', [id]);
            }

            if (recoveryCodesReplace) {
                await client.query('DELETE FROM idp_user_recovery_codes WHERE user_id = $1', [id]);
                for (let position = 0; position < recoveryCodesReplace.length; position += 1) {
                    const entry = recoveryCodesReplace[position];
                    await client.query(
                        `INSERT INTO idp_user_recovery_codes (user_id, position, code_hash, used_at) VALUES ($1,$2,$3,$4)`,
                        [id, position, entry.codeHash, entry.usedAt || null]
                    );
                }
            }

            for (const { position, usedAt } of recoveryCodeConsume) {
                await client.query(
                    'UPDATE idp_user_recovery_codes SET used_at = $3 WHERE user_id = $1 AND position = $2',
                    [id, position, usedAt]
                );
            }

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }

        const user = await this._loadFull(id);
        return applyUserSelect(user, resolveUserSelect(opts.select));
    }

    /** Atomic $inc equivalent — a single UPDATE...RETURNING is already atomic per-row against concurrent callers, no transaction needed. */
    async incrementFailedLoginAttempts(id) {
        const { rowCount } = await this.pool.query(
            'UPDATE idp_users SET failed_login_attempts = failed_login_attempts + 1, updated_at = now() WHERE id = $1',
            [id]
        );
        if (rowCount === 0) return null;
        return this._loadFull(id);
    }

    async linkExternalProvider(id, link) {
        await this.pool.query(
            `INSERT INTO idp_user_external_providers (user_id, provider, provider_id, email, connected_at) VALUES ($1,$2,$3,$4,$5)`,
            [id, link.provider, link.providerId, link.email || null, link.connectedAt || new Date()]
        );
        await this.pool.query('UPDATE idp_users SET updated_at = now() WHERE id = $1', [id]);
        return this._loadFull(id);
    }

    async deleteById(id) {
        await this.pool.query('DELETE FROM idp_users WHERE id = $1', [id]);
    }

    async countAll() {
        const { rows: [{ count }] } = await this.pool.query('SELECT COUNT(*)::int AS count FROM idp_users');
        return count;
    }

    async findMany({ skip = 0, limit = 20 } = {}) {
        const { rows } = await this.pool.query(
            'SELECT id FROM idp_users ORDER BY created_at DESC OFFSET $1 LIMIT $2',
            [skip, limit]
        );
        const users = await Promise.all(rows.map((r) => this._loadFull(r.id)));
        // Mirrors Mongo's `.select('-passwordHash -mfaSecret')` on this one method.
        return users.map((u) => applyUserSelect(u, resolveUserSelect(null)));
    }
}
