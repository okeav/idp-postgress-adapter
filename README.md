# @okeav/idp-core-postgres

A PostgreSQL storage adapter for [`@okeav/idp-core`](../identity) — implements all 8 storage repository interfaces (users, sessions, OAuth2 authorization codes/clients/consents, verification tokens, service keys, WebAuthn credentials) against a plain relational schema, using nothing but [`pg`](https://node-postgres.com/) (no ORM).

## Install

```bash
npm install @okeav/idp-core @okeav/idp-core-postgres pg
```

`@okeav/idp-core` is a peer dependency (`^0.2.1`), so npm flags an incompatible core version at install time.

## Usage

`@okeav/idp-core` doesn't know this package exists — you wire it in yourself via `config.storage.factory`, a small seam idp-core exposes specifically so non-Mongo adapters can plug in without idp-core ever importing them:

```js
import { initIdentityProvider } from '@okeav/idp-core';
import { createPostgresStorage, runMigrations } from '@okeav/idp-core-postgres';
import pg from 'pg';

// Run once, at deploy time — NOT automatically by createPostgresStorage().
const migrationPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await runMigrations(migrationPool);
await migrationPool.end();

await initIdentityProvider({
  issuer: 'https://idp.example.com',
  // No config.mongo at all — storage.factory replaces it entirely.
  storage: {
    factory: (resolvedConfig, emailDeps) =>
      createPostgresStorage({ pool: { connectionString: process.env.DATABASE_URL } }, emailDeps),
  },
  signingKeys: { keys: { /* ... */ } },
  security: { emailHashPepper: '...', tokenHashSecret: '...' },
  // ...everything else is identical to the Mongo-backed quickstart.
});
```

## Migrations

Raw `.sql` files under `src/migrations/sql/`, applied in order by `runMigrations(pool)`, each in its own transaction, tracked in an `idp_schema_migrations` table. **Not** run automatically by `createPostgresStorage()`; call it explicitly at your own deploy/startup step.

`runMigrations()` is safe to call from several instances at once. It does all its work on one dedicated connection holding a Postgres session-level advisory lock (`pg_advisory_lock(8028622229990892656)`, exported as `MIGRATION_LOCK_KEY`). A second caller blocks until the first finishes, then re-reads `idp_schema_migrations` and applies nothing that's already there. The lock is released in a `finally`, and Postgres also drops it if the process dies mid-migration. Two things to know:

- Through a **transaction-mode** connection pooler (e.g. PgBouncer `pool_mode=transaction`), session-level advisory locks aren't reliable. Point `runMigrations()` at a direct or session-mode connection.
- A caller waits as long as another instance is migrating. If you want a bound, set `lock_timeout` / `statement_timeout` on the migration pool.

`createPostgresStorage()` does a cheap read-only check on startup that the expected migrations have been applied, and throws an actionable error if not. Set `config.skipMigrationCheck: true` to skip that round trip (e.g. a CI job reusing a known-good database).

## Schema notes

- Primary keys are application-generated UUIDs (`crypto.randomUUID()`) — no `pgcrypto`/`uuid-ossp` extension required, since some managed Postgres hosts restrict `CREATE EXTENSION`.
- Two of idp-core's Mongo-shaped embedded arrays became real join tables here, since they're looked up by more than "give me the whole document": `idp_user_external_providers` (SSO-linked identities, looked up by `provider`+`providerId`) and `idp_user_recovery_codes` (MFA recovery codes, consumed by positional index — reconstructed in `position` order).
- `idp_oauth_clients.client_secret_hash` has no database-level "hide by default" — every query lists its columns explicitly and only includes the secret hash when asked (`{ includeSecret: true }`). Don't change any repository query to `SELECT *`.
- Unlike MongoDB, Postgres has no native TTL index — `pruneExpired()` on sessions/authorization-codes/verification-tokens is a **real** delete here, not a no-op. Schedule it yourself (cron/interval); idp-core never calls it automatically.
- `createSessionForLogin` (the composite write every login flow uses) runs as a real Postgres transaction — a single checked-out client, explicit `BEGIN`/`COMMIT`/`ROLLBACK`. Unlike the Mongo adapter, there's no deployment-topology gate to worry about (no replica-set requirement) — plain Postgres has supported multi-statement transactions unconditionally, always.

## Testing

The test suite uses [`@electric-sql/pglite`](https://pglite.dev/) + [`@electric-sql/pglite-socket`](https://www.npmjs.com/package/@electric-sql/pglite-socket) — a real, WASM-compiled Postgres running in-process, exposed over a genuine wire-protocol TCP socket, so repository code runs against an entirely unmodified `pg.Pool`. No Docker/container is required to run `npm test`.

```bash
npm test                  # against the local ../identity checkout (file: dev dependency)
npm run test:published    # against the published @okeav/idp-core from the registry
```

`npm run test:published` copies `package.json`, `src/` and `test/` into a temp directory, installs the published `@okeav/idp-core` in the `peerDependencies` range there (never the local folder), and runs the same suite. Run it before releasing, so an adapter release that only works with an unreleased core is caught. Set `KEEP_TEST_DIR=1` to keep the temp copy.

pglite-socket multiplexes every connection onto one PGlite session, and advisory locks are per-session, so the concurrent-migration tests emulate the lock per connection (all other SQL still runs against pglite). To run the same scenario against a real Postgres, set `IDP_PG_TEST_URL` (it creates and drops a throwaway schema):

```bash
IDP_PG_TEST_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

## What this package does not do

- No connection pooling tuning beyond whatever you pass in `config.pool` (a plain `pg.Pool` config).
- No automatic migrations, no automatic `pruneExpired()` scheduling — both are your app's responsibility.
- No RBAC/authorization decisioning — same as idp-core itself; this package only implements storage.

## License

MIT © Okeav
