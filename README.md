# Current environment interruption

The earlier clean ARM64 packaged acceptance passed (1 test / 91 assertions / 10.09s), before the latest mobile CSS changes. A subsequent CSS image rebuild unexpectedly reinstalled dependency layers, exhausted host space to about100MiB and returned EIO. Root cancelled only the verified proof build clients. Docker API is currently unavailable; preview database operations and the packaged stack need recovery. No volumes, databases or archives were deleted. Do not start a cold build without at least8–10GiB free host space.

The new scheduled-backup harness created its dedicated minute-cron plan but failed during that interruption (44.06s, 6 assertions). Its finally block could not confirm disablement. After metadata recovers, inspect the unique `Scheduled native acceptance <uuid>` plan (Asia/Bangkok, exact fixture source/storage), disable only that plan through the application API, and review retained occurrences/jobs before any rerun. This is not scheduled native acceptance. Latest mobile CSS fixes remain unpackaged; both TypeScript checks passed.

# Steelkeep

Self-hosted database backup and recovery, built with TanStack Start and Elysia.

**In development. Local preview address: [127.0.0.1:4310](http://127.0.0.1:4310).**
Docker recovered after an owner-approved restart; existing fixture volumes were preserved.
The authorized local review on 31 October 2026 has verified ordinary native recovery for
seven engine profiles, plus build/typecheck and targeted tests. The full eight-engine
acceptance goal remains open. Scope and limitations are recorded in the [acceptance ledger](docs/acceptance.md).

## Product

- Database and S3 connections, encrypted credentials, revision-checked edits and explicit endpoint allowlists.
- Backup plans, manual runs, timezone schedules, persistent jobs and event history.
- Native database tools, immutable S3 artifacts and SHA-256 integrity.
- Safe restore review into a precreated, separate, empty destination; no source overwrite.
- Shared REST/OpenAPI and native MCP operations with scoped access.
- Explicit S3 availability checks with cached check times; full downloaded-byte verification during restore.
- Databasement-inspired operational dashboard, dense history, charts and original Steelkeep details.

Required engine scope is PostgreSQL, MySQL, MariaDB, MongoDB, SQLite, Redis, ClickHouse and SQL Server.
Profiles, prerequisites and packaging gaps are explicit in [engine profiles](docs/engine-profiles.md).
PostgreSQL 17 and MariaDB 11.4 have passed isolated native MCP recovery against the local fixtures.
MongoDB 8.0.34, Redis 7.4.12, SQLite, MySQL 8.0.46 and ClickHouse 25.8.12 also passed
isolated MCP recovery. SQL Server remains pending. This is not a general production support claim.
MySQL/MariaDB have distinct compatibility constraints. No PITR, cluster-wide backup, or business
recovery guarantee is implied by a successful logical dump or a zero CLI exit code.

The Compose worker uses the multi-engine Ubuntu recipe in `Dockerfile.engines`:
PG17, real MySQL8 and MariaDB11 clients, MongoDB tools100.20 and SQLite. Its ARM64 image
built successfully and runs the local API/worker with current `server` and `shared` source
bind mounts. Broader fault/profile acceptance remains pending; the separate packaged PG/Maria proof passed.
SQL Server needs the separately provisioned x64 DacFx extension.
The MariaDB compatibility executable is deliberately refused for MySQL sources.
Current source limits are 2 GiB/archive, 500 tables and bounded validation metadata. MariaDB/MySQL
backup takes a global read lock for the manifest and dump, so it blocks source-server writes
for that interval and requires the explicit RELOAD privilege. It currently rejects stored
programs, views, triggers/events, non-InnoDB tables and cross-database references rather than
silently losing or rebinding them. Boundary/limit checks and the remaining exact engine profiles still need acceptance.

## Local setup and preview

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

UI: [http://127.0.0.1:4310](http://127.0.0.1:4310). Installation token: `.steelkeep/token`; generated key:
`.steelkeep/key`. Setup preserves existing files. API: port 4311, OpenAPI `/openapi`, JSON
`/openapi/json`, MCP `/mcp`. The Start dev server forwards these to the same Elysia API.
The Docker application profile uses internal fixture hostnames; a host-only API uses the
loopback configuration from `.env.example` instead. Do not run both APIs on the same port.

For a packaged build, `Dockerfile` serves Start documents/assets and Elysia API/MCP from
one Bun server. `compose.selfhost.yaml` uses the separate `Dockerfile.engines` worker image.
The preview uses the development server and source-mounted API/worker. A separate clean
ARM64 packaged installation passed 1 test / 91 assertions in 10.09s without application
source binds: compiled UI login/six sections and official MCP PG/Maria recovery with
independent S3 GET/SHA and SQL. See [packaged proof](docs/selfhost-acceptance.md).
Its web image predates three newer mobile CSS declarations; their rebuild/rerun is pending.

## Access and secrets

Owner installation token has all scopes. Optional `STEELKEEP_SCOPED_TOKENS_FILE` points to
a protected JSON array of `{token, actor, scopes}`; scopes: `read`, `configure`, `backup:run`,
`restore:run`, `jobs:cancel`. Legacy file tokens cannot grant `agents:manage`; that permission
belongs to the owner or scoped database-backed agent tokens. Keep the file outside client assets and the repository.
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

Connection edits keep endpoint/database identity and restore designation fixed so old
artifacts retain their provenance. Omitted secret fields keep their stored values. Actual
credential or operation-setting changes require an idle connection and reset its check.
Unused connection records can be removed; any plan or recovery-history reference preserves
the record. Removing a record never deletes database data or S3 objects.

The Backups screen and MCP can explicitly recheck S3 object metadata. A matching HEAD
size/metadata checksum is not downloaded-byte verification. Missing objects are marked
missing; access denial and timeout stay unknown. Restore verifies the full SHA-256 before
target writes. Browser backup request keys survive navigation/reload within the actor's
session so an ambiguous start can recover its original job.

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

The compiled UI and single-origin entrypoint can be checked without Docker or a working
metadata database:

```sh
bun run build
STEELKEEP_ACCEPTANCE=synthetic-local-web bun test acceptance/web-outage.test.ts
```

This guarded check uses its own loopback port4320 and temporary installation credentials.
It deliberately targets an unavailable metadata endpoint, checks real API/MCP error results,
and verifies browser navigation/error states and native dialog keyboard behavior. It does
not create database/storage fixtures or establish successful recovery/container delivery.

The 31 October local execution record includes a successful frozen install, preserved setup
key/token, healthy PostgreSQL/MariaDB/RustFS fixtures, migration 6, typecheck and build.
`bun run test` most recently passed **26 tests / 154 assertions**; `bun run test:integration` passed
**34 tests / 209 assertions**. HEAD classifications in the latter use mocked provider
responses and are not data-recovery proof.

`acceptance/mcp-recovery.test.ts` then passed both native engine scenarios with **27 assertions**:
dump → S3 → downloaded-byte SHA-256 gate → fresh distinct precreated target → manifest
validation, plus independent SQL counts/sums and PostgreSQL identity. Request retries returned
the same job and a subsequent restore to the occupied target was refused. Runtime fixes
included JSONB-key-order-independent comparison and a quoted MariaDB `rows` alias.

Headless browser login and six main sections rendered; [overview screenshot](output/playwright/local-overview.png).
The latest full Playwright suite passed **4/4 scenarios in 36.4 seconds**: PostgreSQL
and MariaDB recovery, connection lifecycle and AI-agent issuance/scope enforcement/revocation.
The recovery scenarios covered: connection/plan forms, native jobs, metadata-only HEAD, independent S3 GET/SHA,
review confirmation, displayed validation and direct SQL checks. The authenticated same-origin
Scalar `/openapi` page also rendered its API heading and operation list without page errors.
Desktop/mobile visual, keyboard and failure-injection acceptance remain separate gates. See [acceptance](docs/acceptance.md)
and [architecture](docs/architecture.md). Earlier foundation-only results are historical.

Synthetic fixture and opt-in acceptance sources are written for all eight engine profiles.
See [acceptance ledger](docs/acceptance.md),
[ClickHouse fixture](infra/clickhouse-fixture/README.md) and
[native worker tooling](docs/native-tooling.md). Independent [MySQL 8](infra/mysql8-fixture-README.md)
and optional [SQL Server](infra/mssql-fixture-README.md) fixtures have their own prerequisites.
PostgreSQL 17, MariaDB 11, MongoDB 8.0.34, Redis 7.4.12, SQLite, MySQL 8.0.46 and
ClickHouse 25.8.12 have passed ordinary native MCP recovery. The extra-engine group passed 3 tests / 106 assertions; a subsequent
SQLite Linux-writer rerun passed 35 assertions including the exact live-WAL marker/count.
`bun run typecheck:acceptance` checks the harnesses and setup scripts separately.
After Docker recovery, PostgreSQL/MariaDB passed 2 tests / 27 assertions, MySQL passed
1 / 63 and ClickHouse passed 1 / 20. Permanent S3 failure acceptance passed 1 test / 510
assertions: missing bucket and invalid credentials failed at attempt 1 without artifact
publication or retry during the bounded observation window. Metadata amcheck passed,
all 46 stored secrets decrypted and 19 S3 objects matched their recorded bytes/SHA-256.
SQL Server's restricted-source export still requires an owner-provided nonproduction
physical x64 Linux runner and operator EULA acceptance; its helper compiled successfully.
The corrected transient-S3 acceptance passed 1 test / 21 assertions in 14.70s:
only its own RustFS container was stopped/restarted with the same container ID; the same
job moved from attempt 1 retry_wait with no artifact to succeeded at attempt 2 with
one artifact, independently downloaded/SHA-verified, while PostgreSQL totals stayed unchanged.
The full fault matrix remains open. Clean ARM64 packaged acceptance passed 1 / 91
in 10.09s: web image prefix `4aa204616469`, worker `ed6ac2132f62`, backend `a1e1cf5`.
The passing web image excludes the three newer mobile CSS declarations.

Only isolated synthetic databases/storage were used. No production connection, publication,
deployment or paid service was used.
MIT licensed; adapted interface provenance and font notices: [third-party notices](THIRD-PARTY-NOTICES.md).
