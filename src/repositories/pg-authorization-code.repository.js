import crypto from 'node:crypto';
import { mapAuthorizationCodeRow } from '../util/row-mappers.js';

/** @implements {import('@okeav/idp-core/src/storage/interfaces.js').AuthorizationCodeRepository} */
export class PgAuthorizationCodeRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async create(input) {
        await this.pool.query(
            `INSERT INTO idp_authorization_codes (id, code, client_id, user_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at, used)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
                crypto.randomUUID(), input.code, input.clientId, input.userId, input.redirectUri,
                input.scopes || [], input.codeChallenge || null, input.codeChallengeMethod || null,
                input.expiresAt, input.used ?? false,
            ]
        );
    }

    /** Atomic find+mark-used — the OAuth2 spec requires a code be exchangeable exactly once. */
    async consumeByCodeHash(hash) {
        const { rows: [row] } = await this.pool.query(
            `UPDATE idp_authorization_codes SET used = true, used_at = now(), updated_at = now()
             WHERE code = $1 AND used = false AND expires_at > now()
             RETURNING *`,
            [hash]
        );
        return mapAuthorizationCodeRow(row);
    }

    /** No native TTL in Postgres (unlike Mongo) — this is a real delete, not a no-op. Schedule it yourself (cron/interval); idp-core never calls it automatically. */
    async pruneExpired() {
        const { rowCount } = await this.pool.query(`DELETE FROM idp_authorization_codes WHERE expires_at < now()`);
        return { deletedCount: rowCount };
    }
}
