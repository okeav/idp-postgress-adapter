import crypto from 'node:crypto';
import { mapSessionRow } from '../util/row-mappers.js';

const LIST_COLUMNS = 'id, user_id, ip_address, device_info, device_fingerprint, created_at, expires_at, revoked_at, token_hash';

function mapListRow(row) {
    if (!row) return null;
    return {
        id: row.id, user: row.user_id, ipAddress: row.ip_address, deviceInfo: row.device_info,
        deviceFingerprint: row.device_fingerprint, createdAt: row.created_at, expiresAt: row.expires_at,
        revokedAt: row.revoked_at, tokenHash: row.token_hash,
    };
}

/** @implements {import('@okeav/idp-core/src/storage/interfaces.js').SessionRepository} */
export class PgSessionRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async createSession(input) {
        const { rows: [row] } = await this.pool.query(
            `INSERT INTO idp_sessions (id, user_id, token_hash, expires_at, kid, jti, ip_address, device_info, device_fingerprint, claims)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING *`,
            [
                crypto.randomUUID(), input.user, input.tokenHash, input.expiresAt, input.kid, input.jti,
                input.ipAddress || null, input.deviceInfo || null, input.deviceFingerprint || null,
                JSON.stringify(input.claims || {}),
            ]
        );
        return mapSessionRow(row);
    }

    async findByRefreshTokenHash(hash) {
        const { rows: [row] } = await this.pool.query('SELECT * FROM idp_sessions WHERE token_hash = $1', [hash]);
        return mapSessionRow(row);
    }

    /** Atomic find+revoke — a single UPDATE...RETURNING means only one concurrent caller can successfully consume a given refresh token. Returns the PRE-revocation row (Mongo's returnDocument:'before' equivalent) — the WHERE clause required revoked_at IS NULL to match, so it's known to have been null going in. */
    async revokeByRefreshTokenHash(hash, { onlyIfActive = true } = {}) {
        const expiryClause = onlyIfActive ? 'AND expires_at > now()' : '';
        const { rows: [row] } = await this.pool.query(
            `UPDATE idp_sessions SET revoked_at = now(), updated_at = now()
             WHERE token_hash = $1 AND revoked_at IS NULL ${expiryClause}
             RETURNING *`,
            [hash]
        );
        if (!row) return null;
        return mapSessionRow({ ...row, revoked_at: null });
    }

    async revokeById(id, userId) {
        const { rows: [row] } = await this.pool.query(
            `UPDATE idp_sessions SET revoked_at = now(), updated_at = now()
             WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
             RETURNING *`,
            [id, userId]
        );
        return mapSessionRow(row);
    }

    async revokeAllForUser(userId, { exceptTokenHash } = {}) {
        const params = [userId];
        let exceptClause = '';
        if (exceptTokenHash) { params.push(exceptTokenHash); exceptClause = `AND token_hash != $${params.length}`; }
        const { rowCount } = await this.pool.query(
            `UPDATE idp_sessions SET revoked_at = now(), updated_at = now() WHERE user_id = $1 AND revoked_at IS NULL ${exceptClause}`,
            params
        );
        return { revokedCount: rowCount };
    }

    async listActiveForUser(userId) {
        const { rows } = await this.pool.query(
            `SELECT ${LIST_COLUMNS} FROM idp_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
            [userId]
        );
        return rows.map(mapListRow);
    }

    async listHistoryForUser(userId, { limit = 20 } = {}) {
        const clamped = Math.min(Math.max(limit, 1), 100);
        const { rows } = await this.pool.query(
            `SELECT ${LIST_COLUMNS} FROM idp_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
            [userId, clamped]
        );
        return rows.map(mapListRow);
    }

    async existsForDevice(userId, fingerprint, rawDeviceInfo) {
        const { rowCount } = await this.pool.query(
            fingerprint
                ? `SELECT 1 FROM idp_sessions WHERE user_id = $1 AND (device_fingerprint = $2 OR device_info = $3) LIMIT 1`
                : `SELECT 1 FROM idp_sessions WHERE user_id = $1 AND device_info = $2 LIMIT 1`,
            fingerprint ? [userId, fingerprint, rawDeviceInfo] : [userId, rawDeviceInfo]
        );
        return rowCount > 0;
    }

    /** Optional — write-only audit trail. */
    async recordIssuedAccessToken(entry) {
        await this.pool.query(
            `INSERT INTO idp_access_token_audit (id, user_id, token_hash, expires_at, kid, jti, ip_address, device_info)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [crypto.randomUUID(), entry.user, entry.tokenHash, entry.expiresAt, entry.kid, entry.jti, entry.ipAddress || null, entry.deviceInfo || null]
        );
    }

    /**
     * Composite, atomic "create a login session" operation — the 3-row write
     * (access-token audit + session + user.lastLoginAt/lockout-reset) that
     * password/MFA-verify/SSO/magic-link/WebAuthn login flows each need,
     * wrapped in a real Postgres transaction. Must use a single checked-out
     * client via pool.connect() — pool.query() per statement would silently
     * grab a (possibly different) connection per call and auto-commit each
     * one, defeating atomicity entirely. No deployment-topology gate is
     * needed here (unlike Mongo's assertTransactionsSupported) — plain
     * Postgres supports BEGIN/COMMIT unconditionally.
     */
    async createSessionForLogin({ accessTokenAudit, session, userId, lastLoginAt }) {
        const client = await this.pool.connect();
        let began = false;
        try {
            await client.query('BEGIN');
            began = true;

            if (accessTokenAudit) {
                await client.query(
                    `INSERT INTO idp_access_token_audit (id, user_id, token_hash, expires_at, kid, jti, ip_address, device_info)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                    [
                        crypto.randomUUID(), accessTokenAudit.user, accessTokenAudit.tokenHash, accessTokenAudit.expiresAt,
                        accessTokenAudit.kid, accessTokenAudit.jti, accessTokenAudit.ipAddress || null, accessTokenAudit.deviceInfo || null,
                    ]
                );
            }

            const { rows: [sessionRow] } = await client.query(
                `INSERT INTO idp_sessions (id, user_id, token_hash, expires_at, kid, jti, ip_address, device_info, device_fingerprint, claims)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                 RETURNING *`,
                [
                    crypto.randomUUID(), session.user, session.tokenHash, session.expiresAt, session.kid, session.jti,
                    session.ipAddress || null, session.deviceInfo || null, session.deviceFingerprint || null,
                    JSON.stringify(session.claims || {}),
                ]
            );

            await client.query(
                `UPDATE idp_users SET last_login_at = $2, failed_login_attempts = 0, lock_until = NULL, updated_at = now() WHERE id = $1`,
                [userId, lastLoginAt]
            );

            await client.query('COMMIT');
            return mapSessionRow(sessionRow);
        } catch (err) {
            if (began) await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    /** No native TTL in Postgres (unlike Mongo) — a real delete, not a no-op. Schedule it yourself. */
    async pruneExpired() {
        const { rowCount } = await this.pool.query('DELETE FROM idp_sessions WHERE expires_at < now()');
        return { deletedCount: rowCount };
    }
}
