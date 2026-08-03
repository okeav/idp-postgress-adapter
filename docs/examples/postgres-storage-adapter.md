---
title: "Swap in the Postgres Storage Adapter"
package: "@okeav/idp-core-postgres"
category: "example"
tags: ["storage-adapter", "postgres", "sql"]
description: "Run the bundled migration and wire idp-core up against Postgres instead of the built-in MongoDB adapter."
---

# Swap in the Postgres Storage Adapter

A complete, runnable setup: run the migration once, then start idp-core with
`config.storage.factory` pointed at this package instead of `config.mongo`. See
[Postgres Storage Adapter](../api/storage-adapter.md) for the full contract this satisfies.

## Prerequisites

- Node ≥ 20
- A running Postgres instance (any version `pg` supports — no extensions required)
- `npm install @okeav/idp-core @okeav/idp-core-postgres pg`

## Step 1 — run the migration

Migrations are **not** run automatically by `createPostgresStorage()` — run them explicitly, once,
at deploy time, before the app that calls `initIdentityProvider()` starts serving traffic:

```js
// migrate.js
import pg from 'pg';
import { runMigrations } from '@okeav/idp-core-postgres';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const applied = await runMigrations(pool);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Already up to date.');
await pool.end();
```

```bash
DATABASE_URL=postgres://localhost:5432/idp_quickstart node migrate.js
```

This creates (on first run) an `idp_schema_migrations` tracking table plus the package's full
schema — `idp_users`, `idp_sessions`, `idp_oauth_clients`, and the rest (see
[Postgres Storage Adapter](../api/storage-adapter.md#schema-at-a-glance) for the complete table
list).

## Step 2 — wire up the server

```js
// server.js
import crypto from 'crypto';
import express from 'express';
import { initIdentityProvider, buildRouter, cookieParser } from '@okeav/idp-core';
import { createPostgresStorage } from '@okeav/idp-core-postgres';

// A real deployment generates this once and stores it durably — regenerating it on every
// boot invalidates all existing sessions.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

await initIdentityProvider({
  issuer: 'http://localhost:3000',
  // No config.mongo at all — storage.factory replaces it entirely.
  storage: {
    factory: (resolvedConfig, emailDeps) =>
      createPostgresStorage({ pool: { connectionString: process.env.DATABASE_URL } }, emailDeps),
  },
  cache: { adapter: 'memory' }, // fine for a single process; see idp-core's cache-interface.md for Redis

  signingKeys: { keys: { 'quickstart-key-1': { privateKey, publicKey, status: 'ACTIVE' } } },

  security: {
    // Generate real random secrets for anything beyond your own laptop.
    emailHashPepper: 'dev-only-pepper-do-not-use-in-prod',
    tokenHashSecret: 'dev-only-token-secret-do-not-use-in-prod',
  },

  hooks: {
    onVerificationEmailRequested: ({ email, verificationCode }) => {
      console.log(`[dev email] Verify ${email} — code: ${verificationCode}`);
    },
    onAuditLog: (event) => console.log(`[audit] ${event.action}`, event),
    resolveAuthContext: async () => ({ claims: { role: 'member' } }),
  },
});

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use('/auth', buildRouter());

app.use((err, req, res, next) => {
  res.status(err.httpStatus || 500).json({ error: err.code || 'INTERNAL_ERROR', message: err.message });
});

app.listen(3000, () => console.log('Listening on http://localhost:3000'));
```

## Try it

```bash
# Register
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"Str0ng!Passw0rd"}'

# Server console prints: [dev email] Verify you@example.com — code: 123456

curl -X POST http://localhost:3000/auth/register/verify-email \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","code":"123456"}'

curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"Str0ng!Passw0rd"}'
# -> { "accessToken": "...", "accessTokenExpiresAt": "...", "refreshToken": "...", "refreshTokenExpiresAt": "...", "userId": "..." }
```

Behind the scenes, that `/auth/login` call runs `SessionRepository.createSessionForLogin()`, which
writes the access-token audit row, the session row, and the user's `last_login_at`/lockout reset
inside a single Postgres transaction.

## This is a quickstart, not a production config

- The signing key is regenerated every restart here — pin one via a persisted PEM for anything
  beyond a demo.
- `emailHashPepper`/`tokenHashSecret` are placeholders — generate real random secrets. The pepper
  in particular must be treated as a non-rotating, well-backed-up secret: rotating it invalidates
  every existing user's email lookup hash.
- Nothing here schedules `pruneExpired()` — Postgres has no native TTL, so expired sessions,
  authorization codes, and verification tokens accumulate until you delete them yourself (cron or
  interval calling each repository's `pruneExpired()`).
- No connection-pool tuning beyond the plain `pg.Pool` config passed in — set `max`,
  `idleTimeoutMillis`, etc. directly in `config.pool` if you need them.
- No HTTPS or CORS configured — that's Express's and your app's job, same as any Express server.

## Related

- [Postgres Storage Adapter](../api/storage-adapter.md) — full config shape, schema, and migration
  behavior.
- [Repository Adapters (Storage)](https://github.com/okeav/idp/blob/main/docs/api/repository-adapters.md)
  — the eight-interface contract this adapter implements, documented in `@okeav/idp-core`.
