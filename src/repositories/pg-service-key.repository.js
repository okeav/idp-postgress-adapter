import crypto from 'node:crypto';
import { mapServiceKeyRow } from '../util/row-mappers.js';

const PUBLISHABLE_STATUSES = ['ACTIVE', 'ROTATING'];

/** @implements {import('@okeav/idp-core/src/storage/interfaces.js').ServiceKeyRepository} */
export class PgServiceKeyRepository {
    constructor(pool) {
        this.pool = pool;
    }

    /** Idempotent upsert by kid — re-registering the same (name, publicKey) just bumps last_seen_at. registered_at is excluded from the DO UPDATE SET so it's preserved from the original insert (Postgres equivalent of Mongo's $setOnInsert). */
    async upsertByKid({ kid, name, publicKey, region }) {
        const { rows: [row] } = await this.pool.query(
            `INSERT INTO idp_service_keys (id, kid, name, public_key, status, region)
             VALUES ($1, $2, $3, $4, 'ACTIVE', $5)
             ON CONFLICT (kid) DO UPDATE SET
                name = EXCLUDED.name, public_key = EXCLUDED.public_key,
                status = 'ACTIVE', region = EXCLUDED.region, last_seen_at = now()
             RETURNING *`,
            [crypto.randomUUID(), kid, name, publicKey, region || 'global']
        );
        return mapServiceKeyRow(row);
    }

    async listPublishable() {
        const { rows } = await this.pool.query(
            `SELECT * FROM idp_service_keys WHERE status = ANY($1)`,
            [PUBLISHABLE_STATUSES]
        );
        return rows.map(mapServiceKeyRow);
    }
}
