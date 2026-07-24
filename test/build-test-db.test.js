import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestDb } from './helpers/build-test-db.js';

test('buildTestDb: migrations apply and the pool can query real Postgres (via pglite-socket)', async () => {
    const db = await buildTestDb();
    try {
        const { rows } = await db.pool.query('SELECT COUNT(*)::int AS count FROM idp_schema_migrations');
        assert.equal(rows[0].count, 1);

        const tables = await db.pool.query(`
            SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name
        `);
        const names = tables.rows.map((r) => r.table_name);
        assert.ok(names.includes('idp_users'));
        assert.ok(names.includes('idp_sessions'));
        assert.ok(names.includes('idp_credentials'));

        await db.pool.query(`INSERT INTO idp_users (id, email, email_hash) VALUES ($1, $2, $3)`, ['11111111-1111-1111-1111-111111111111', 'a@example.com', 'hash1']);
        const { rows: users } = await db.pool.query('SELECT * FROM idp_users');
        assert.equal(users.length, 1);
        assert.equal(users[0].email, 'a@example.com');

        await db.truncateAll();
        const { rows: afterTruncate } = await db.pool.query('SELECT * FROM idp_users');
        assert.equal(afterTruncate.length, 0);
    } finally {
        await db.stop();
    }
});
