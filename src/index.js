import { createPool } from './pool.js';
import { expectedMigrationFilenames } from './migrations/run-migrations.js';
import { PgUserRepository } from './repositories/pg-user.repository.js';
import { PgSessionRepository } from './repositories/pg-session.repository.js';
import { PgAuthorizationCodeRepository } from './repositories/pg-authorization-code.repository.js';
import { PgConsentRepository } from './repositories/pg-consent.repository.js';
import { PgOAuthClientRepository } from './repositories/pg-oauth-client.repository.js';
import { PgVerificationTokenRepository } from './repositories/pg-verification-token.repository.js';
import { PgServiceKeyRepository } from './repositories/pg-service-key.repository.js';
import { PgCredentialRepository } from './repositories/pg-credential.repository.js';

export { runMigrations } from './migrations/run-migrations.js';

/**
 * Postgres storage adapter for @okeav/idp-core. Wire it in via
 * `config.storage.factory` — see README.md.
 *
 * Does NOT run migrations itself (call `runMigrations()` explicitly at your
 * own deploy/startup step — see README.md for why) but DOES do a cheap
 * read-only check that the migrations this package version expects have
 * actually been applied, failing loudly with an actionable error if not,
 * mirroring idp-core's own `assertTransactionsSupported` fail-fast pattern.
 * Set `config.skipMigrationCheck: true` to skip this (e.g. a CI job reusing
 * a known-good database) and shave the round trip off startup.
 *
 * @param {{ pool: import('pg').PoolConfig | { connectionString: string }, skipMigrationCheck?: boolean }} config
 * @param {{ hashEmail: (email: string) => string, normalizeEmail: (email: string) => string }} emailDeps
 */
export async function createPostgresStorage(config, emailDeps) {
    const pool = createPool(config.pool);

    if (!config.skipMigrationCheck) {
        await assertMigrationsApplied(pool);
    }

    return {
        pool,
        close: () => pool.end(),
        userRepository: new PgUserRepository(pool, emailDeps),
        sessionRepository: new PgSessionRepository(pool),
        authorizationCodeRepository: new PgAuthorizationCodeRepository(pool),
        consentRepository: new PgConsentRepository(pool),
        oauthClientRepository: new PgOAuthClientRepository(pool),
        verificationTokenRepository: new PgVerificationTokenRepository(pool),
        serviceKeyRepository: new PgServiceKeyRepository(pool),
        credentialRepository: new PgCredentialRepository(pool),
    };
}

async function assertMigrationsApplied(pool) {
    const expected = await expectedMigrationFilenames();
    let appliedRows;
    try {
        ({ rows: appliedRows } = await pool.query('SELECT filename FROM idp_schema_migrations'));
    } catch (err) {
        throw new Error(
            'idp-core-postgres: idp_schema_migrations table not found — have you run runMigrations() against this ' +
            'database yet? See README.md "Migrations". Set config.skipMigrationCheck:true to skip this check.',
            { cause: err }
        );
    }
    const applied = new Set(appliedRows.map((r) => r.filename));
    const missing = expected.filter((f) => !applied.has(f));
    if (missing.length > 0) {
        throw new Error(
            `idp-core-postgres: this database is missing migration(s) this package version expects: ${missing.join(', ')}. ` +
            'Run runMigrations() against it first. Set config.skipMigrationCheck:true to skip this check.'
        );
    }
}
