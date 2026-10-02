import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SQL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sql');

/**
 * Session-level advisory lock key held for the whole of `runMigrations`.
 * Fixed, so every instance of every version of this package contends on the
 * same lock: the ASCII bytes of "okeavidp" read as a signed 64-bit integer.
 * Kept as a string — it doesn't fit in a JS number.
 */
export const MIGRATION_LOCK_KEY = '8028622229990892656';

/**
 * Applies every not-yet-applied `NNNN_description.sql` file in `dir` (default:
 * this package's own bundled migrations) against `pool`, in filename order,
 * each inside its own transaction, tracked in `idp_schema_migrations`.
 *
 * Deliberately NOT called automatically by `createPostgresStorage()` — the
 * consuming app calls this explicitly at its own deploy/startup step, same
 * as Prisma/Knex/node-pg-migrate all separate "migrate" from "connect."
 *
 * Safe to run concurrently (e.g. several instances each calling it at boot):
 * all work happens on one dedicated client holding a Postgres advisory lock
 * (`pg_advisory_lock(MIGRATION_LOCK_KEY)`), so a second caller blocks until
 * the first finishes, then re-reads `idp_schema_migrations` and finds
 * nothing left to do. The lock is session-scoped, so Postgres also releases
 * it if the process dies mid-migration.
 *
 * @param {import('pg').Pool} pool
 * @param {{ dir?: string }} [opts]
 * @returns {Promise<string[]>} filenames newly applied this run
 */
export async function runMigrations(pool, { dir = DEFAULT_SQL_DIR } = {}) {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

    const client = await pool.connect();
    let lockHeld = false;
    let brokenErr;
    try {
        await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
        lockHeld = true;
        return await applyPending(client, dir, files);
    } catch (err) {
        if (!lockHeld) brokenErr = err;
        throw err;
    } finally {
        if (lockHeld) {
            await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]).catch((err) => {
                brokenErr = err;
            });
        }
        // Passing an error destroys the connection instead of returning it to
        // the pool — if unlocking failed, closing the session releases the lock.
        client.release(brokenErr);
    }
}

async function applyPending(client, dir, files) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS idp_schema_migrations (
            filename TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    // Read only once the lock is held: another instance may have just applied
    // some or all of these while we waited for it.
    const { rows } = await client.query('SELECT filename FROM idp_schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));
    const newlyApplied = [];

    for (const filename of files) {
        if (applied.has(filename)) continue;

        const sql = await fs.readFile(path.join(dir, filename), 'utf8');
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('INSERT INTO idp_schema_migrations (filename) VALUES ($1)', [filename]);
            await client.query('COMMIT');
            newlyApplied.push(filename);
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw new Error(`Migration ${filename} failed: ${err.message}`, { cause: err });
        }
    }

    return newlyApplied;
}

/** Names of every migration file bundled with this package version — used by createPostgresStorage's startup check. */
export async function expectedMigrationFilenames({ dir = DEFAULT_SQL_DIR } = {}) {
    return (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
}
