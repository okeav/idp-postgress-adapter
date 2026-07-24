import crypto from 'node:crypto';
import { mapConsentRow } from '../util/row-mappers.js';

/** @implements {import('@okeav/idp-core/src/storage/interfaces.js').ConsentRepository} */
export class PgConsentRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async upsert(userId, clientId, scopes) {
        const { rows: [row] } = await this.pool.query(
            `INSERT INTO idp_consents (id, user_id, client_id, scopes, granted_at, is_revoked, revoked_at)
             VALUES ($1,$2,$3,$4,now(),false,NULL)
             ON CONFLICT (user_id, client_id) DO UPDATE SET
                scopes = EXCLUDED.scopes, granted_at = now(), is_revoked = false, revoked_at = NULL, updated_at = now()
             RETURNING *`,
            [crypto.randomUUID(), userId, clientId, scopes || []]
        );
        return mapConsentRow(row);
    }

    async find(userId, clientId) {
        const { rows: [row] } = await this.pool.query(
            `SELECT * FROM idp_consents WHERE user_id = $1 AND client_id = $2 AND is_revoked = false`,
            [userId, clientId]
        );
        return mapConsentRow(row);
    }

    async listForUser(userId) {
        const { rows } = await this.pool.query(`SELECT * FROM idp_consents WHERE user_id = $1 AND is_revoked = false`, [userId]);
        return rows.map(mapConsentRow);
    }

    async revoke(userId, clientId) {
        await this.pool.query(
            `UPDATE idp_consents SET is_revoked = true, revoked_at = now(), updated_at = now() WHERE user_id = $1 AND client_id = $2`,
            [userId, clientId]
        );
    }
}
