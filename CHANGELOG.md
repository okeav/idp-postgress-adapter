# Changelog

## 0.1.2

- **Concurrent-safe migrations.** `runMigrations()` now holds a Postgres session-level advisory lock on one dedicated connection for the whole run and reads `idp_schema_migrations` only after taking it, so instances migrating at the same moment can't apply the same file twice. Exports `MIGRATION_LOCK_KEY`.
- **Peer dependency on `@okeav/idp-core@^0.2.1`**, so an incompatible core version is flagged at install time.
- **`npm run test:published`** runs the suite against the published `@okeav/idp-core` instead of the local checkout.

## 0.1.1

- Fix repository/homepage URLs.

## 0.1.0

- Initial release.
