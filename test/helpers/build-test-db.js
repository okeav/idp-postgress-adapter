import net from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';
import { runMigrations } from '../../src/migrations/run-migrations.js';

const { Pool } = pg;

// PGLiteSocketServer's bound port isn't publicly exposed when started with
// port:0 (the underlying net.Server is a private field) — so a free port is
// found ourselves first, the same standard "probe and close" pattern most
// test suites use, and handed to it explicitly.
function getFreePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

const TABLES = [
    'idp_credentials', 'idp_service_keys', 'idp_verification_tokens', 'idp_oauth_clients',
    'idp_consents', 'idp_authorization_codes', 'idp_access_token_audit', 'idp_sessions',
    'idp_user_recovery_codes', 'idp_user_external_providers', 'idp_users',
];

/**
 * Boots a real, in-process Postgres (PGlite) exposed over a genuine
 * TCP/wire-protocol socket, so repository code under test uses an entirely
 * unmodified `pg.Pool` — the same driver/code path as production — with no
 * Docker/container dependency. Mirrors why idp-core's own tests use
 * mongodb-memory-server instead of a real Mongo deployment.
 *
 * One instance is meant to be shared across an entire test file via
 * `before`/`after`; call `truncateAll()` between tests for isolation.
 */
export async function buildTestDb() {
    const db = await PGlite.create();
    const port = await getFreePort();
    // maxConnections defaults to 1 in pglite-socket (PGlite itself is a
    // single-connection database, multiplexed by the socket server) — the
    // real pg.Pool used against it opens several concurrent connections
    // whenever repository code fires parallel queries (e.g. Promise.all),
    // which needs the multiplexer's limit raised accordingly. Real Postgres
    // has no such limit; this is purely a test-infrastructure concern.
    const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 });
    await server.start();

    const pool = new Pool({ host: '127.0.0.1', port, database: 'postgres', user: 'postgres' });
    await runMigrations(pool);

    return {
        pool,
        host: '127.0.0.1',
        port,
        poolConfig: { host: '127.0.0.1', port, database: 'postgres', user: 'postgres' },
        async truncateAll() {
            await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
        },
        async stop() {
            await pool.end();
            await server.stop();
            await db.close();
        },
    };
}
