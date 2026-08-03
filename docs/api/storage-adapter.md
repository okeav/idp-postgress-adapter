---
title: "Postgres Storage Adapter"
package: "@okeav/idp-core-postgres"
category: "api-reference"
tags: ["storage-adapter", "postgres", "sql"]
description: "A plain-relational, no-ORM Postgres implementation of idp-core's eight storage repository interfaces, plugged in via config.storage.factory."
---

# Postgres Storage Adapter

`@okeav/idp-core-postgres` implements all eight of idp-core's storage repository interfaces
(`UserRepository`, `SessionRepository`, `AuthorizationCodeRepository`, `ConsentRepository`,
`OAuthClientRepository`, `VerificationTokenRepository`, `ServiceKeyRepository`,
`CredentialRepository` — see [Related](#related) for the canonical contract) against a plain
relational schema, using nothing but [`pg`](https://node-postgres.com/) — no ORM, no query builder.
It's a drop-in alternative to idp-core's built-in MongoDB adapter for deployments that would rather
run Postgres.

## Wiring it in — `config.storage.factory`

idp-core doesn't import this package — you wire it in yourself via `config.storage.factory`, the
seam idp-core exposes specifically so non-Mongo adapters can plug in without idp-core ever knowing
they exist. `initIdentityProvider()` calls `resolved.storage.factory(resolved, { hashEmail,
normalizeEmail })` in place of its built-in `createMongoStorage()` whenever a factory is provided.

This package's factory, `createPostgresStorage(config, emailDeps)`, matches that exact signature:

```js
import { initIdentityProvider } from '@okeav/idp-core';
import { createPostgresStorage } from '@okeav/idp-core-postgres';

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

`emailDeps` (`{ hashEmail, normalizeEmail }`) is handed through by idp-core so this adapter can
implement the same email blind-index pattern the Mongo adapter uses: `idp_users.email` stores the
normalized plaintext, `idp_users.email_hash` stores the HMAC blind index, and
`UserRepository.findByEmail` matches on either column.

## Adapter config shape

`createPostgresStorage(config, emailDeps)` takes:

```ts
{
  pool: import('pg').PoolConfig | { connectionString: string }; // required
  skipMigrationCheck?: boolean;                                  // default false
}
```

`config.pool` is passed straight through to `new pg.Pool(poolConfig)` — any valid `pg.Pool` config
works (`connectionString`, or discrete `host`/`port`/`user`/`password`/`database`/etc.), plus
whatever pool-tuning options `pg` itself accepts (`max`, `idleTimeoutMillis`, ...). There's no
tuning layered on top by this package. `createPool()` throws synchronously if `config.pool` is
missing or has neither `connectionString` nor `host` set.

## Migrations are a separate, explicit step

`createPostgresStorage()` does **not** run migrations itself. Run `runMigrations(pool)` explicitly
at your own deploy/startup step, before calling `initIdentityProvider()`:

```js
import pg from 'pg';
import { runMigrations } from '@okeav/idp-core-postgres';

const migrationPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await runMigrations(migrationPool);
await migrationPool.end();
```

This mirrors Prisma/Knex/node-pg-migrate's separation of "migrate" from "connect" — running DDL
implicitly on every process boot risks concurrent-migration races when multiple instances start at
once.

What `runMigrations(pool, { dir? })` actually does: it applies every not-yet-applied
`NNNN_description.sql` file under `src/migrations/sql/` (in filename order), each inside its own
transaction, and records applied filenames in an `idp_schema_migrations` table it creates on first
run.

What `createPostgresStorage()` *does* do on startup: unless `config.skipMigrationCheck: true`, it
runs a cheap read-only check — reading `idp_schema_migrations` and comparing against the filenames
this package version bundles — and throws an actionable `Error` if the table is missing or a
migration hasn't been applied yet. Set `skipMigrationCheck: true` to skip that round trip (e.g. a
CI job reusing a known-good database).

## Schema at a glance

One migration file today (`0001_init.sql`), nine tables, all primary-keyed with
application-generated UUIDs (`crypto.randomUUID()`, assigned in the repository layer) rather than
DB-generated ones — no `pgcrypto`/`uuid-ossp` extension required, since some managed Postgres hosts
restrict `CREATE EXTENSION`.

| Table | Backs | Notes |
|---|---|---|
| `idp_users` | `UserRepository` | `email` (plaintext) + `email_hash` (blind index, unique); profile fields flattened as `profile_*` columns; `metadata` is `JSONB` |
| `idp_user_external_providers` | `UserRepository` (linked SSO identities) | Join table — was Mongo's embedded `externalProviders` array; unique on `(provider, provider_id)` for `findByExternalProvider` |
| `idp_user_recovery_codes` | `UserRepository` (MFA recovery codes) | Join table with an explicit `position` column — was Mongo's embedded array; consumed by positional index, unique on `(user_id, position)` |
| `idp_sessions` | `SessionRepository` | `token_hash`, `kid`, `jti`, `device_fingerprint`, `claims` (`JSONB`) |
| `idp_access_token_audit` | `SessionRepository` (write-only audit) | One row per issued access token |
| `idp_authorization_codes` | `AuthorizationCodeRepository` | `code` column stores the **hash** despite the name, matching idp-core's own field naming; `scopes` is a Postgres `TEXT[]` |
| `idp_consents` | `ConsentRepository` | Unique on `(user_id, client_id)` |
| `idp_oauth_clients` | `OAuthClientRepository` | `client_secret_hash` has no DB-level "hide by default" — every repository query lists columns explicitly and only selects it when `{ includeSecret: true }` is passed; never changed to `SELECT *` |
| `idp_verification_tokens` | `VerificationTokenRepository` | One table for all three kinds (`password_reset` \| `email_verification` \| `magic_link`, enforced by a `CHECK`); `verification_code` is only populated for `email_verification` |
| `idp_service_keys` | `ServiceKeyRepository` | `kid` unique, `status` (`ACTIVE`/`ROTATING`/...), `region` |
| `idp_credentials` | `CredentialRepository` (WebAuthn) | `credential_id` unique (base64url from the browser), `counter`, `transports` as `TEXT[]` |

## No native TTL — `pruneExpired()` is real

Unlike MongoDB's TTL indexes, Postgres has no equivalent. `pruneExpired()` on sessions,
authorization codes, and verification tokens issues a real `DELETE`, not a no-op — idp-core never
calls it automatically, so schedule it yourself (cron/interval) if you want expired rows reaped.

## Transactions, no topology gate

`SessionRepository.createSessionForLogin()` — the composite "audit + session + user.lastLoginAt"
write every login flow uses — runs as a real Postgres transaction (a single checked-out client,
explicit `BEGIN`/`COMMIT`/`ROLLBACK`). Unlike the Mongo adapter, there's no deployment-topology
check at startup: plain Postgres has supported multi-statement transactions unconditionally, so
there's nothing analogous to Mongo's replica-set requirement to probe for.

## Related

- [Repository Adapters (Storage)](https://github.com/okeav/idp/blob/main/docs/api/repository-adapters.md)
  — the canonical eight-interface contract and the `config.storage.factory` seam, documented in
  `@okeav/idp-core` itself.
- [Postgres Storage Adapter example](../examples/postgres-storage-adapter.md) — full worked setup.
