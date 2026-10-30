# Acceptance ledger

31 October 2026. The full goal remains active. Current user direction: finish code and
design before running or opening anything. Therefore these are outstanding proof obligations,
not checked boxes and not a reason to reduce scope.

| Requirement | Necessary evidence | Current status |
| --- | --- | --- |
| Start + Elysia + TanStack DB | Install/build/typecheck with current lock, real route data and stale/error states | Earlier foundation built; current code unverified |
| Reference-quality UI | Desktop/mobile comparison against Databasement and Salt, keyboard/modal states | Rewritten source; visual review postponed |
| PG backup/restore | Real native dump, S3 upload/download, checksum, separate empty target, schema/data/sequence/constraint comparison | Implementation in progress; no accepted restore |
| MySQL and MariaDB | Equivalent native pipelines with exact server/client matrix and InnoDB constraints | Adapters written; unrun |
| MongoDB | Native archive, BSON/index/options match, lock acquisition/release loss and SIGKILL reconciliation, sentinel/restricted target | Adapter and durable lock journal written; unrun |
| SQLite | Online snapshot, WAL fixture, implicit rowids, identity/FK checks; symlink/hardlink/path guards | Adapter written; unrun |
| Redis | Atomic DUMP capture, binary keys/types/streams, absolute TTL including expired keys; no FLUSH/REPLACE | Bounded logical profile written; unrun |
| ClickHouse | Native disk archive, shared-spool setup, ASYNC result reconciliation and independent RowBinary validation | Adapter in static integration; unrun |
| SQL Server | Supported x64 helper packaging, read-only source BACPAC, empty target import, exact data/schema/identities, interrupted import | Helper and adapter source written; uncompiled/unrun |
| AI-agent access | Named identities, one-time hashed tokens, scope denial, expiry, delegation/revocation, safe audit, UI and MCP management | Source and targeted tests written; unrun |
| Durable jobs | Kill/restart on dump/upload/commit boundaries; no lost job, false success or restore replay | Static design only after current changes |
| Schedules | Timezone/DST/missed/overlap cases, unique occurrence under concurrency | Source present; runtime evidence pending |
| Secrets | Credentials absent from UI/API/MCP/errors/logs; ciphertext corruption rejected; key recovery documented | Earlier foundation checks only |
| Target protection | Source alias, metadata, nonempty/unknown target, version and privilege failures | Source present; refusal cases need execution |
| Retries/cancellation | Bounded safe backup retries, confirmed process-group stop, interrupted target remains blocked | Worker source updated; failure injection pending |
| REST/OpenAPI | Real response/schema correspondence, errors, pagination, stable operation IDs and auth | Earlier basic spec passed; current contracts unverified |
| MCP | Official client discovery and same backup/restore flow; scoped denial and idempotency | Source present; end-to-end proof pending |
| Self-hosted delivery | Clean isolated compose setup + packaged single-origin UI/API/MCP + separate worker | Docker/runbook source present; clean packaged run pending |
| No collateral changes | No production, real credentials, existing project edits, deployment or spend | All work scoped to Steelkeep and its docs |

Do not mark the goal complete until all required evidence exists. A lint/typecheck, screenshot,
API 200, S3 HEAD, SHA metadata or successful CLI exit alone cannot stand in for recovered data.

## Later failure matrix

Invalid source/S3 credentials; forbidden bucket; disk/file budget; stalled child process;
corrupt archive; source=target by alias; unsupported version; nonempty target; incompatible
extensions/ACL; cancellation before and during SQL; worker kill; metadata connection loss;
late completion from old ownership token; duplicate API/MCP requests; UI disconnect;
schedule timezone/DST gaps/folds; missing S3 object and unknown availability.

All data for these checks must remain synthetic and isolated. Test fixture database creation
is performed by the harness/admin before the app sees the target, never by restore itself.

## Authored harnesses, still unrun

- `acceptance/mcp-recovery.test.ts`: PostgreSQL and MariaDB native dump → S3 →
  restore, stable request keys and independent data/sequence checks.
- `compose.extra-engines.yaml`, `scripts/seed-extra-fixtures.ts` and
  `acceptance/extra-engines.test.ts`: isolated MongoDB, Redis and SQLite fixtures;
  independent downloaded S3 SHA-256, BSON/indexes, binary keys/TTL/types, WAL/rowids,
  identity and FK assertions. Explicit `synthetic-local-extra` opt-in only.
- `compose.clickhouse-fixture.yaml` and `acceptance/clickhouse-recovery.test.ts`:
  exact 25.8 LTS fixture, restricted direct roles, shared spool, MCP and independent
  JSON/Native-format data comparisons. Explicit `synthetic-local-clickhouse` opt-in.
- `tests/api.integration.test.ts`: explicit `synthetic-local` mode and fixed
  loopback metadata identity. Default unit test script cannot start metadata tests.
- `Dockerfile.engines` and optional `Dockerfile.mssql`: source-only native tooling
  recipes. No image build, native version check or DacFx compilation has run.

Separate MySQL 8 and SQL Server fixtures and their executed data-recovery acceptance
remain outstanding. UI browser acceptance and crash/restart/cancellation injection
remain outstanding for every new engine. Source-authored assertions are not a pass.
