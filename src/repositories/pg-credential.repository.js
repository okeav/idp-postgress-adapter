import crypto from 'node:crypto';
import { mapCredentialRow } from '../util/row-mappers.js';

/** @implements {import('@okeav/idp-core/src/storage/interfaces.js').CredentialRepository} */
export class PgCredentialRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async create({ userId, credentialId, publicKey, counter, transports, deviceType, backedUp, name }) {
        const { rows: [row] } = await this.pool.query(
            `INSERT INTO idp_credentials (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up, name)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             RETURNING *`,
            [crypto.randomUUID(), userId, credentialId, publicKey, counter ?? 0, transports || [], deviceType || 'singleDevice', backedUp ?? false, name ?? null]
        );
        return mapCredentialRow(row);
    }

    async findByCredentialId(credentialId) {
        const { rows: [row] } = await this.pool.query(`SELECT * FROM idp_credentials WHERE credential_id = $1`, [credentialId]);
        return mapCredentialRow(row);
    }

    async findByUserId(userId) {
        const { rows } = await this.pool.query(`SELECT * FROM idp_credentials WHERE user_id = $1`, [userId]);
        return rows.map(mapCredentialRow);
    }

    async updateCounter(credentialId, newCounter) {
        await this.pool.query(
            `UPDATE idp_credentials SET counter = $2, last_used_at = now(), updated_at = now() WHERE credential_id = $1`,
            [credentialId, newCounter]
        );
    }

    async deleteByCredentialId(credentialId, userId) {
        await this.pool.query(`DELETE FROM idp_credentials WHERE credential_id = $1 AND user_id = $2`, [credentialId, userId]);
    }

    async countForUser(userId) {
        const { rows: [{ count }] } = await this.pool.query(`SELECT COUNT(*)::int AS count FROM idp_credentials WHERE user_id = $1`, [userId]);
        return count;
    }
}
