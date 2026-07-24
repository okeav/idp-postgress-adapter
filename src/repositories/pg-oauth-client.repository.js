import crypto from 'node:crypto';
import { mapOAuthClientRow, OAUTH_CLIENT_PUBLIC_COLUMNS } from '../util/row-mappers.js';

/**
 * `client_secret_hash` has no DB-level "hide by default" the way Mongo's
 * `select:false` does — it's an application-level convention enforced here:
 * every SELECT lists the public columns explicitly, and `client_secret_hash`
 * is only included when `{ includeSecret: true }` is passed. Do not change
 * any of these queries to `SELECT *` — that would silently leak the secret
 * hash into every client-list/lookup response.
 *
 * @implements {import('@okeav/idp-core/src/storage/interfaces.js').OAuthClientRepository}
 */
export class PgOAuthClientRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async create(input) {
        const { rows: [row] } = await this.pool.query(
            `INSERT INTO idp_oauth_clients (
                id, name, slug, client_id, client_secret_hash, client_type, redirect_uris,
                allowed_scopes, allowed_grants, status, metadata
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING ${OAUTH_CLIENT_PUBLIC_COLUMNS}`,
            [
                crypto.randomUUID(), input.name, input.slug, input.clientId, input.clientSecretHash,
                input.clientType, input.redirectUris || [], input.allowedScopes || [], input.allowedGrants || [],
                input.status, JSON.stringify(input.metadata || {}),
            ]
        );
        return mapOAuthClientRow(row);
    }

    async findByClientId(clientId, { includeSecret = false } = {}) {
        const columns = includeSecret ? `${OAUTH_CLIENT_PUBLIC_COLUMNS}, client_secret_hash` : OAUTH_CLIENT_PUBLIC_COLUMNS;
        const { rows: [row] } = await this.pool.query(`SELECT ${columns} FROM idp_oauth_clients WHERE client_id = $1`, [clientId]);
        return mapOAuthClientRow(row);
    }

    async findBySlug(slug) {
        const { rows: [row] } = await this.pool.query(`SELECT ${OAUTH_CLIENT_PUBLIC_COLUMNS} FROM idp_oauth_clients WHERE slug = $1`, [slug]);
        return mapOAuthClientRow(row);
    }

    async updateByClientId(clientId, patch) {
        const columns = [];
        const values = [];
        let i = 1;
        const columnFor = { name: 'name', redirectUris: 'redirect_uris', allowedScopes: 'allowed_scopes', allowedGrants: 'allowed_grants', clientType: 'client_type', accessTokenTTL: 'access_token_ttl', refreshTokenTTL: 'refresh_token_ttl', idTokenTTL: 'id_token_ttl', logoUrl: 'logo_url', websiteUrl: 'website_url', privacyPolicyUrl: 'privacy_policy_url', termsOfServiceUrl: 'terms_of_service_url', supportEmail: 'support_email', metadata: 'metadata', status: 'status', clientSecretHash: 'client_secret_hash' };

        for (const [key, value] of Object.entries(patch)) {
            const column = columnFor[key];
            if (!column) continue;
            columns.push(`${column} = $${i}`);
            values.push(key === 'metadata' ? JSON.stringify(value) : value);
            i += 1;
        }
        columns.push('updated_at = now()');
        values.push(clientId);

        const { rows: [row] } = await this.pool.query(
            `UPDATE idp_oauth_clients SET ${columns.join(', ')} WHERE client_id = $${i} RETURNING ${OAUTH_CLIENT_PUBLIC_COLUMNS}`,
            values
        );
        return mapOAuthClientRow(row);
    }

    async listMany({ skip = 0, limit = 20 } = {}) {
        const { rows } = await this.pool.query(
            `SELECT ${OAUTH_CLIENT_PUBLIC_COLUMNS} FROM idp_oauth_clients ORDER BY created_at DESC OFFSET $1 LIMIT $2`,
            [skip, limit]
        );
        return rows.map(mapOAuthClientRow);
    }

    async countAll() {
        const { rows: [{ count }] } = await this.pool.query(`SELECT COUNT(*)::int AS count FROM idp_oauth_clients`);
        return count;
    }
}
