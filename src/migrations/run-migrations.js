import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SQL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sql');

/**
 * Applies every not-yet-applied `NNNN_description.sql` file in `dir` (default:
 * this package's own bundled migrations) against `pool`, in filename order,
 * each inside its own transaction, tracked in `idp_schema_migrations`.
 *
 * Deliberately NOT called automatically by `createPostgresStorage()` — the
 * consuming app calls this explicitly at its own deploy/startup step, same
 * as Prisma/Knex/node-pg-migrate all separate "migrate" from "connect."
 * Running DDL implicitly on every process boot risks concurrent-migration
 * races in a multi-instance deployment.
 *
 * @param {import('pg').Pool} pool
 * @param {{ dir?: string }} [opts]
 * @returns {Promise<string[]>} filenames newly applied this run
 */
export async function runMigrations(pool, { dir = DEFAULT_SQL_DIR } = {}) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS idp_schema_migrations (
            filename TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);

    const { rows } = await pool.query('SELECT filename FROM idp_schema_migrations');
    const applied = new Set(rows.map((r) => r.filename));

    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const newlyApplied = [];

    for (const filename of files) {
        if (applied.has(filename)) continue;

        const sql = await fs.readFile(path.join(dir, filename), 'utf8');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('INSERT INTO idp_schema_migrations (filename) VALUES ($1)', [filename]);
            await client.query('COMMIT');
            newlyApplied.push(filename);
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw new Error(`Migration ${filename} failed: ${err.message}`, { cause: err });
        } finally {
            client.release();
        }
    }

    return newlyApplied;
}

/** Names of every migration file bundled with this package version — used by createPostgresStorage's startup check. */
export async function expectedMigrationFilenames({ dir = DEFAULT_SQL_DIR } = {}) {
    return (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
}
