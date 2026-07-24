import crypto from 'node:crypto';
import { mapVerificationTokenRow } from '../util/row-mappers.js';

const DELETE_ON_CONSUME_KINDS = new Set(['email_verification', 'magic_link']);

/** @implements {import('@okeav/idp-core/src/storage/interfaces.js').VerificationTokenRepository} */
export class PgVerificationTokenRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async create(kind, input) {
        await this.pool.query(
            `INSERT INTO idp_verification_tokens (id, kind, user_id, token_hash, verification_code, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [crypto.randomUUID(), kind, input.user, input.tokenHash, input.verificationCode || null, input.expiresAt]
        );
    }

    /**
     * `userId`, when given, scopes the consume to the claimed identity
     * (password reset). email_verification/magic_link are single-use-by-
     * deletion (matching idp-core's Mongo adapter — a clicked verification
     * link or magic link should behave the same way: one link, one use,
     * gone afterward); password_reset instead flags `used_at`, keeping the
     * row.
     */
    async consumeByHash(kind, hash, userId) {
        const params = [kind, hash];
        let userClause = '';
        if (userId) { params.push(userId); userClause = `AND user_id = $${params.length}`; }

        if (DELETE_ON_CONSUME_KINDS.has(kind)) {
            const { rows: [row] } = await this.pool.query(
                `DELETE FROM idp_verification_tokens WHERE kind = $1 AND token_hash = $2 AND used_at IS NULL AND expires_at > now() ${userClause} RETURNING *`,
                params
            );
            return mapVerificationTokenRow(row);
        }

        const { rows: [row] } = await this.pool.query(
            `UPDATE idp_verification_tokens SET used_at = now(), updated_at = now()
             WHERE kind = $1 AND token_hash = $2 AND used_at IS NULL AND expires_at > now() ${userClause}
             RETURNING *`,
            params
        );
        return mapVerificationTokenRow(row);
    }

    async consumeByCode(kind, code, userId) {
        const { rows: [row] } = await this.pool.query(
            `DELETE FROM idp_verification_tokens WHERE kind = $1 AND verification_code = $2 AND user_id = $3 AND expires_at > now() RETURNING *`,
            [kind, code, userId]
        );
        return mapVerificationTokenRow(row);
    }

    async deleteAllForUser(kind, userId) {
        await this.pool.query(`DELETE FROM idp_verification_tokens WHERE kind = $1 AND user_id = $2`, [kind, userId]);
    }

    /** No native TTL in Postgres — a real delete, not a no-op. Schedule it yourself. */
    async pruneExpired() {
        const { rowCount } = await this.pool.query(`DELETE FROM idp_verification_tokens WHERE expires_at < now()`);
        return { deletedCount: rowCount };
    }
}
