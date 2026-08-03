# @okeav/idp-core-postgres Documentation

Reference documentation and a runnable example for
[`@okeav/idp-core-postgres`](https://github.com/adaptiveedge/idp-postgress-adapter) — a PostgreSQL
storage adapter for [`@okeav/idp-core`](../../identity). It implements all eight of idp-core's
storage repository interfaces (users, sessions, OAuth2 authorization codes/clients/consents,
verification tokens, service keys, WebAuthn credentials) against a plain relational schema, using
nothing but [`pg`](https://node-postgres.com/) — no ORM. This tree is intentionally light — one API
page and one example — since the package is thin: 8 repositories behind one config seam
(`config.storage.factory`).

## Layout

```
docs/
  api/         one file per concept area — purpose, full signatures, config, schema
  examples/    one working, runnable scenario per file
```

Every file carries the same YAML frontmatter (`title`, `package`, `category`, `tags`,
`description`) as idp-core's own docs tree, so both can be indexed/filtered the same way —
`category` is `api-reference` or `example`.

## API reference (`api/`)

| File | Covers |
|---|---|
| [storage-adapter.md](api/storage-adapter.md) | `createPostgresStorage`, `config.storage.factory` wiring, the adapter's `pool`/`skipMigrationCheck` config, migration behavior, and the full relational schema |

## Examples (`examples/`)

| File | Scenario |
|---|---|
| [postgres-storage-adapter.md](examples/postgres-storage-adapter.md) | Running the migration and starting an Express server with idp-core wired against this adapter, end to end |

## Source of truth

Written directly against this package's own source (`README.md`, `src/index.js`, `src/pool.js`,
`src/migrations/run-migrations.js`, `src/migrations/sql/0001_init.sql`, and
`src/repositories/*.js`), kept in sync as the package evolves. The eight repository interfaces
themselves are not redefined here — see
[idp-core's Repository Adapters doc](https://github.com/okeav/idp/blob/main/docs/api/repository-adapters.md)
for that canonical contract; this tree only documents how this specific adapter satisfies it.
