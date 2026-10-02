import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { buildTestDb } from './helpers/build-test-db.js';
import { runMigrations, expectedMigrationFilenames, MIGRATION_LOCK_KEY } from '../src/migrations/run-migrations.js';

/**
 * Why the concurrency tests emulate the advisory lock: pglite-socket
 * multiplexes every TCP connection onto PGlite's single backend session, and
 * Postgres advisory locks are per-session and re-entrant — so against pglite
 * a second connection's pg_advisory_lock() succeeds immediately and proves
 * nothing. `withEmulatedAdvisoryLocks` gives each checked-out client its own
 * "session" for pg_advisory_lock/unlock (same semantics as Postgres: blocking,
 * re-entrant per session, released on disconnect) while every other
 * statement still runs as real SQL against pglite.
 *
 * The last test in this file runs the same scenario against a real Postgres
 * when IDP_PG_TEST_URL is set.
 */
function withEmulatedAdvisoryLocks(pool) {
    const locks = new Map(); // key -> { owner, depth, waiters: [{ owner, resolve }] }
    const events = [];
    let nextSession = 1;

    async function lock(key, owner) {
        const held = locks.get(key);
        if (!held) {
            locks.set(key, { owner, depth: 1, waiters: [] });
        } else if (held.owner === owner) {
            held.depth++;
        } else {
            events.push({ type: 'wait', owner });
            await new Promise((resolve) => held.waiters.push({ owner, resolve }));
        }
        events.push({ type: 'lock', owner });
    }

    function unlock(key, owner, all = false) {
        const held = locks.get(key);
        if (!held || held.owner !== owner) return false;
        held.depth = all ? 0 : held.depth - 1;
        if (held.depth > 0) return true;
        events.push({ type: 'unlock', owner });
        const next = held.waiters.shift();
        if (next) {
            held.owner = next.owner;
            held.depth = 1;
            next.resolve();
        } else {
            locks.delete(key);
        }
        return true;
    }

    return {
        events,
        heldLockCount: () => locks.size,
        async connect() {
            const client = await pool.connect();
            const session = nextSession++;
            return {
                async query(text, params) {
                    if (/pg_advisory_lock\(/.test(text)) {
                        await lock(params[0], session);
                        return { rows: [{ pg_advisory_lock: '' }] };
                    }
                    if (/pg_advisory_unlock\(/.test(text)) {
                        return { rows: [{ pg_advisory_unlock: unlock(params[0], session) }] };
                    }
                    return client.query(text, params);
                },
                release(err) {
                    for (const key of [...locks.keys()]) unlock(key, session, true);
                    client.release(err);
                },
            };
        },
    };
}

async function makeMigrationDir(files) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idp-pg-migrations-'));
    for (const [name, sql] of Object.entries(files)) await fs.writeFile(path.join(dir, name), sql);
    return dir;
}

// Deliberately non-idempotent: applying 0002 twice would leave two rows.
const PROBE_MIGRATIONS = {
    '0001_create_probe.sql': 'CREATE TABLE mig_probe (id SERIAL PRIMARY KEY, note TEXT NOT NULL);',
    '0002_insert_probe.sql': "INSERT INTO mig_probe (note) VALUES ('applied');",
};

test('runMigrations: two concurrent calls both resolve and apply each migration exactly once', async () => {
    const db = await buildTestDb({ migrate: false });
    const dir = await makeMigrationDir(PROBE_MIGRATIONS);
    try {
        const pool = withEmulatedAdvisoryLocks(db.pool);

        const [a, b] = await Promise.all([runMigrations(pool, { dir }), runMigrations(pool, { dir })]);

        // One caller applied everything, the other waited and found nothing left.
        assert.deepEqual([...a, ...b].sort(), Object.keys(PROBE_MIGRATIONS));
        assert.ok(a.length === 0 || b.length === 0, `work was split across callers: ${JSON.stringify({ a, b })}`);

        const { rows: probe } = await db.pool.query('SELECT note FROM mig_probe');
        assert.equal(probe.length, 1, '0002 ran exactly once');
        const { rows: tracked } = await db.pool.query('SELECT filename FROM idp_schema_migrations ORDER BY filename');
        assert.deepEqual(tracked.map((r) => r.filename), Object.keys(PROBE_MIGRATIONS));

        // The second caller really did block on the lock until the first released it.
        const types = pool.events.map((e) => e.type);
        assert.ok(types.includes('wait'), 'second caller waited for the lock');
        assert.deepEqual(types.filter((t) => t !== 'wait'), ['lock', 'unlock', 'lock', 'unlock']);
        assert.equal(pool.heldLockCount(), 0);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
        await db.stop();
    }
});

test('runMigrations: concurrent calls with the bundled migrations leave a usable schema', async () => {
    const db = await buildTestDb({ migrate: false });
    try {
        const pool = withEmulatedAdvisoryLocks(db.pool);

        const results = await Promise.all([runMigrations(pool), runMigrations(pool), runMigrations(pool)]);

        const expected = await expectedMigrationFilenames();
        assert.deepEqual(results.flat().sort(), expected);
        const { rows } = await db.pool.query('SELECT filename FROM idp_schema_migrations ORDER BY filename');
        assert.deepEqual(rows.map((r) => r.filename), expected);
    } finally {
        await db.stop();
    }
});

test('runMigrations: a failing migration still releases the lock', async () => {
    const db = await buildTestDb({ migrate: false });
    const badDir = await makeMigrationDir({ '0001_bad.sql': 'THIS IS NOT SQL;' });
    const goodDir = await makeMigrationDir(PROBE_MIGRATIONS);
    try {
        const pool = withEmulatedAdvisoryLocks(db.pool);

        await assert.rejects(runMigrations(pool, { dir: badDir }), /Migration 0001_bad\.sql failed/);
        assert.equal(pool.heldLockCount(), 0);

        // A later run isn't blocked by a lock left behind.
        assert.deepEqual(await runMigrations(pool, { dir: goodDir }), Object.keys(PROBE_MIGRATIONS));
    } finally {
        await fs.rm(badDir, { recursive: true, force: true });
        await fs.rm(goodDir, { recursive: true, force: true });
        await db.stop();
    }
});

test('runMigrations: takes and releases the real advisory lock (no emulation)', async () => {
    const db = await buildTestDb({ migrate: false });
    try {
        const seen = [];
        const spyPool = {
            async connect() {
                const client = await db.pool.connect();
                return {
                    query(text, params) {
                        if (text.includes('pg_advisory')) seen.push([text, params]);
                        return client.query(text, params);
                    },
                    release: (err) => client.release(err),
                };
            },
        };

        await runMigrations(spyPool);

        assert.deepEqual(seen, [
            ['SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]],
            ['SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]],
        ]);
        const { rows } = await db.pool.query(`SELECT COUNT(*)::int AS count FROM pg_locks WHERE locktype = 'advisory'`);
        assert.equal(rows[0].count, 0, 'no advisory lock left behind');
        assert.deepEqual(await runMigrations(db.pool), [], 'second run is a no-op');
    } finally {
        await db.stop();
    }
});

test('runMigrations: concurrent calls against a real Postgres (set IDP_PG_TEST_URL)', { skip: !process.env.IDP_PG_TEST_URL && 'IDP_PG_TEST_URL not set' }, async () => {
    const schema = `idp_mig_test_${crypto.randomBytes(4).toString('hex')}`;
    const admin = new pg.Pool({ connectionString: process.env.IDP_PG_TEST_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const dir = await makeMigrationDir(PROBE_MIGRATIONS);
    // Separate pools stand in for separate app instances.
    const pools = [1, 2, 3].map(() => new pg.Pool({
        connectionString: process.env.IDP_PG_TEST_URL,
        options: `-c search_path=${schema}`,
    }));
    try {
        const results = await Promise.all(pools.map((pool) => runMigrations(pool, { dir })));

        assert.deepEqual(results.flat().sort(), Object.keys(PROBE_MIGRATIONS));
        const { rows } = await pools[0].query('SELECT note FROM mig_probe');
        assert.equal(rows.length, 1, '0002 ran exactly once');
    } finally {
        await Promise.all(pools.map((pool) => pool.end()));
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
        await fs.rm(dir, { recursive: true, force: true });
    }
});
