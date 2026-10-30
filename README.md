# Steelkeep

Self-hosted database backup and recovery, built with TanStack Start and Elysia.

**In development. Current code has not passed product acceptance.** The owner requested
code/design first and postponed browsers, services, builds and tests until a later review.
Commands below are the intended runbook for that later phase, not evidence they passed.

## Product

- Database and S3 connections, encrypted credentials and explicit endpoint allowlists.
- Backup plans, manual runs, timezone schedules, persistent jobs and event history.
- Native database tools, immutable S3 artifacts and SHA-256 integrity.
- Safe restore review into a precreated, separate, empty destination; no source overwrite.
- Shared REST/OpenAPI and native MCP operations with scoped access.
- Databasement-inspired operational dashboard, dense history, charts and original Steelkeep details.

Required engine scope is PostgreSQL, MySQL, MariaDB, MongoDB, SQLite, Redis, ClickHouse and SQL Server.
Profiles, prerequisites and packaging gaps are explicit in [engine profiles](docs/engine-profiles.md).
PostgreSQL 17 and MariaDB 11.4 are the initial **target test fixtures**, not a verified support claim.
MySQL/MariaDB have distinct compatibility constraints. No PITR, cluster-wide backup, or business
recovery guarantee is implied by a successful logical dump or a zero CLI exit code.

The intended Compose worker uses the multi-engine Ubuntu recipe in `Dockerfile.engines`:
PG17, real MySQL8 and MariaDB11 clients, MongoDB tools100.20 and SQLite. This recipe has
not been built. SQL Server needs the separately provisioned x64 DacFx extension.
The MariaDB compatibility executable is deliberately refused for MySQL sources.
Current source limits are 2 GiB/archive, 500 tables and bounded validation metadata. MariaDB/MySQL
backup takes a global read lock for the manifest and dump, so it blocks source-server writes
for that interval and requires the explicit RELOAD privilege. It currently rejects stored
programs, views, triggers/events, non-InnoDB tables and cross-database references rather than
silently losing or rebinding them. These limits need real acceptance checks before support.

## Intended local setup — run only during the agreed review phase

Prerequisites: Bun 1.4+, Node for Start tooling, Docker Compose. The fixture stack publishes
only loopback ports. It contains synthetic data and deliberately public fixture credentials;
never reuse them for real services.

```sh
bun install --frozen-lockfile
bun scripts/setup-local.ts
docker compose up -d --wait
bun run db:migrate
docker compose --profile application up -d --build api worker
bun scripts/seed-fixture.ts
bun run dev
```

UI: `http://127.0.0.1:4310`. Installation token: `.steelkeep/token`; generated key:
`.steelkeep/key`. Setup preserves existing files. API: port 4311, OpenAPI `/openapi`, JSON
`/openapi/json`, MCP `/mcp`. The Start dev server forwards these to the same Elysia API.
The Docker application profile uses internal fixture hostnames; a host-only API uses the
loopback configuration from `.env.example` instead. Do not run both APIs on the same port.

For a packaged build, `Dockerfile` serves Start documents/assets and Elysia API/MCP from
one Bun server. `compose.selfhost.yaml` uses the separate `Dockerfile.engines` worker image.
Build/production
entry, scoped-token configuration and recovery need later verification before real use.

## Access and secrets

Owner installation token has all scopes. Optional `STEELKEEP_SCOPED_TOKENS_FILE` points to
a protected JSON array of `{token, actor, scopes}`; scopes: `read`, `configure`, `backup:run`,
`restore:run`, `jobs:cancel`, `agents:manage`. Do not place that file inside built client assets or a repository.
Configuration → AI agents provides named identities and expiring, revocable tokens. Tokens
are shown once and stored only as SHA-256 hashes. Default grant is read-only for 24 hours;
delegation cannot increase scopes or outlive its issuer. Revocation includes descendants.
REST and MCP expose the same management operations and sanitized audit events. No AI model
provider is needed. An invalid scoped-token file fails closed, never anonymous.
Agent workflow documentation is served at `/steelkeep-agent.md`.
Remote HTTPS needs explicit `STEELKEEP_PUBLIC_HOSTS`, `STEELKEEP_ALLOWED_ORIGINS` and
`STEELKEEP_SECURE_COOKIE=true`. The local bearer profile is not a universal OAuth integration.

Secrets are authenticated-encrypted in metadata; key is outside the metadata database.
Keep the key with a separate protected recovery copy. Losing it makes stored credentials
unrecoverable. This does not claim that the dump artifacts themselves are encrypted.

## Durable execution

One worker owns the installation advisory lock. Run + outbox are atomic; queue insertion
and dispatch acknowledgement are also atomic. Native operation and S3 effects are not
exactly-once merely because the queue is transactional. Worker restart quarantines unknown
operations; a restore that may have written is never retried automatically. Target reservation
persists, including after success, since the destination is no longer empty. Queue, metadata,
artifact integrity and restore validation are distinct records of evidence.

Never delete a partially restored database automatically. Use a new, deliberately prepared
empty target; keep partial data for inspection. No arbitrary SQL/shell or external dump import.
Retention that deletes user backups is outside the current scope.

## Development and evidence

Future checks: `bun run typecheck`, `bun run test`, `bun run build`, then isolated `bun run test:integration`,
MCP and UI E2E acceptance. See [acceptance](docs/acceptance.md) and [architecture](docs/architecture.md).
Nine foundation tests and a Start build passed before the no-run instruction; later changes
are **unverified**, and that historical result does not establish current compatibility.

Additional synthetic overlays and opt-in acceptance sources are written for MongoDB,
Redis, SQLite and ClickHouse. See [acceptance ledger](docs/acceptance.md),
[ClickHouse fixture](infra/clickhouse-fixture/README.md) and
[native worker tooling](docs/native-tooling.md). They have not been started.
Separate MySQL 8 and SQL Server fixture qualification remains outstanding.

No publication, deployment, real database connection or expense has been performed.
MIT licensed; adapted interface provenance and font notices: [third-party notices](THIRD-PARTY-NOTICES.md).
