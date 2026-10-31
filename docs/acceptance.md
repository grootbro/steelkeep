# Acceptance ledger

## Local checkpoint · 31 October 2026

Docker and the preview are running again. Host free space reached12GiB after the failed-build remnants, this checkout's six build-history records/cache references and obsolete worker image were removed. BuildKit reports0B cache. Four stopped extra-engine fixture containers/images were also removed after checking ownership and image users; their named data volumes remain intact. The two completed temporary auth test databases were removed after verifying they contained no connections, runs or artifacts. The preview reuses the existing worker image and runs UI edits through Vite; no new Docker image was built for this checkpoint. Database/artifact volumes and other projects were preserved.

Owner email/password authentication now replaces the daily installation-token form. Initial setup creates the owner only after installation ownership is verified; an existing setup session avoids another key entry. Sessions are opaque, hashed in metadata and revocable. First setup has not been performed on the main installation: the user chooses their own account. [Authentication](authentication.md).

Observed checks: unit28/167 assertions and API/MCP integration34/209; isolated auth unit/integration3/65 assertions; browser setup/login/logout/password revocation and six sections1/24 assertions in4.69s, including the final legacy-cookie refusal; read-only desktop/mobile light/dark rendering passed. A separate native scheduled backup passed1/53 assertions in22.45s with S3 SHA-256 and source SQL checks; its plan is paused. The earlier outage-created plan was separately disabled and had no jobs/occurrences. The scheduler lock-wait clock correction is implemented; that specific contention case is not runtime-qualified.

The current auth/brand/cache-recipe changes are source/development evidence. The older clean packaged1/91 pass predates them. The new cache-mount recipe has not been rebuilt; this checkpoint deliberately avoids another packaging build.


## Current environment and latest evidence · 31 October 2026

The owner approved a Docker restart after host disk exhaustion interrupted the Unix API.
Docker recovered with existing volumes preserved. Post-restart read checks passed metadata
amcheck, decrypted all 46 stored secrets and verified the actual bytes/SHA-256 of 19 S3
objects. This is bounded fixture integrity evidence, not a general key-recovery audit.

The primary executor then observed these passing current runs:

- PostgreSQL/MariaDB native MCP:2 tests / 27 assertions, including the literal-grant guard.
- MySQL 8.0.46 native MCP:1 test / 63 assertions; the earlier FK-code assertion issue is resolved.
- ClickHouse 25.8.12 native MCP:1 test / 20 assertions.
- Full Playwright suite:4 tests / 36.4s, covering PG/Maria recovery, connection lifecycle
  and AI-agent one-time issuance, MCP/API scope enforcement and UI revocation.
- Permanent S3 failures:1 test / 510 assertions. Actual missing-bucket and invalid-credential
  backup attempts failed once with distinct safe errors, no artifact publication and no
  retry during the harness's 12-second observation window; source totals remained unchanged.
- Unit suite:26 tests / 154 assertions.

Together with the recorded MongoDB/Redis/SQLite runs, seven ordinary native profiles now
have recovery evidence. SQL Server remains unrun: its helper compiles, but supported
nonproduction physical x64 Linux execution and operator EULA acceptance are still needed.
The corrected transient-S3 retry acceptance passed 1 test / 21 assertions in 14.70s:
only its own RustFS container was stopped and restarted with the same container ID.
The actual PostgreSQL job recorded attempt 1 STORAGE_UNAVAILABLE/retry_wait with no
artifact, then the same job succeeded at attempt 2 with one artifact and stable request
idempotency. Independent S3 GET/SHA and unchanged PostgreSQL count/sum passed. An earlier
Mac socket realpath preflight failure occurred before mutation and is not counted as proof.
Clean ARM64 packaged acceptance passed 1 test / 91 assertions in 10.09s. Image ID
prefixes: web `4aa204616469`, worker `ed6ac2132f62`; backend `a1e1cf5`. No application
source binds supplied the compiled UI/backend. Separate private metadata/secrets, UI
login/six sections, official MCP PG/Maria native recovery into fresh restricted targets,
independent actual S3 GET/SHA and SQL passed. The image predates three newer mobile CSS
declarations; rebuild/rerun for those edits remains pending. See [packaged proof](selfhost-acceptance.md).

### Earlier incident timeline and retained evidence

The earlier disk incident reached 498MiB free and interrupted Docker image export/extraction.
Only this task's full Chromium download was removed; no fixture volumes or history were
removed. The owner-approved restart and checks above supersede the earlier Docker-down state.

New directly observed results before the incident:

- `acceptance/worker-failures.test.ts`: 1 passed, 403 assertions, 42.45 s; actual native
  cancellation, SIGKILL dump/restore, restart quarantine, retained target block and no replay
  for 12 seconds. It does not prove partial committed writes or the entire lease interval.
- MySQL 8.0.46: native dump/upload/download/restore and manifest/independent data checks
  completed, then the harness stopped on the FK error-code assertion (1216 vs1452).
  Both are FK rejection codes; the assertion now recognizes both. A full passing post-restart rerun is recorded above. The unsupported Ubuntu mysqldump `--no-login-paths` flag was replaced
  with a private `MYSQL_TEST_LOGIN_FILE` lookup, preserving option-file isolation.
- UI management: connection lifecycle scenario passed in8.2 s (real secret retention,
  rotation/check failure/recovery, stale revision/reload, protected/unused removal).
  AI-agent scenario found missing initial field focus; Modal now focuses the first enabled
  form control after opening. Revalidation was initially blocked by Docker failure; the full post-restart
  Playwright suite above subsequently passed the token/revocation flow. Focus behavior was subsequently checked separately
  by the host-only web harness below.
- C# helper compile succeeded; Pkcs9.0.21 override compiled without the earlier advisories.
  Updated image export and actual SQL Server runtime remain unproven.
- Isolated packaged proof source is prepared (ports4312/54381, distinct metadata/keys,
  no app source mounts). Its filesystem-only setup ran twice and retained private0600
  material; the later 91-assertion packaged pass above supersedes that earlier source-only status.

During the Docker outage, the SQL grant guard was tightened: backtick quoting does not
make `_`/`%` literal database-grant characters. Restore rejects wildcard scopes unless
escaping or verified MySQL `partial_revokes=ON` proves an exact scope; ambiguous mode
is refused. Source metadata checks recognize the corresponding exact grants. Fresh
fixture-role authoring was updated without editing any live role/database. Four pure
regression tests passed40 assertions; the complete unit suite later passed 26 tests / 154 assertions. Native MySQL/MariaDB
recovery was repeated successfully after Docker recovery with the changed guard and
fresh exact-scope targets. Earlier passes alone were not counted as proof of that revision. Application and acceptance typechecks pass.

The record below combines earlier scoped evidence with the explicitly identified post-restart reruns.

## Host-only web checks during the Docker outage

The current Start client/SSR build passed on the host without image downloads. Root then
ran the same `server/serve.ts` entrypoint on loopback with deliberately unavailable metadata
and no fixture mutations. HTTP checks passed for HTML root/deep routes, compiled JavaScript
and immutable asset caching, owner session/unauthenticated refusal, local OpenAPI, safe
metadata-failure JSON, unsupported-method and encoded path-traversal refusals.

That exercise found an actual UI failure: after the first overview500, parent/child query
observers repeatedly remounted/refetched and left the page on Connecting indefinitely.
The child now consumes the parent's query result. Configuration is rendered independently
of the unavailable overview data; integration details and separately scoped agent queries
remain visible, with their own error states. Native dialog cleanup also returns focus to
the still-connected opener after Escape/close.

`STEELKEEP_ACCEPTANCE=synthetic-local-web bun test acceptance/web-outage.test.ts` passed
**1 test /46 assertions /1.55s** against the real rebuilt UI and Bun server: actual500 for
metadata reads, real MCP tool error (not an empty successful list), available capabilities
and OpenAPI, successful login, six navigable sections with error alerts rather than a spinner,
no uncaught browser error/token rendering, initial form focus, inert background controls
under Tab/Shift+Tab, Escape and focus restoration. The test owns temporary credentials,
port4320 and its server/browser processes, which are closed afterward; no Docker, database
or stored artifact is modified. This is degraded-mode evidence, not successful recovery or
immutable image qualification. The later four-scenario Playwright run above supplies real-DB agent issuance/revocation evidence.

31 October 2026. The owner authorized local install, build/checks and isolated fixture
services to provide a working preview. The full eight-engine goal remains active.

This execution record comes from the primary executor's observed local run in this chat.
This documentation pass read the harnesses and artifact paths without rerunning commands.
Results apply to that checkout and fixture environment; later source changes need their own checks.

## Recorded local evidence

| Execution | Recorded result | Scope |
| --- | --- | --- |
| `bun install --frozen-lockfile` | Passed | Current dependency lock |
| `bun scripts/setup-local.ts` | Passed; existing key/token preserved | Local setup, no fixture-volume reset |
| Base Compose stack | PostgreSQL 17, MariaDB 11 and RustFS healthy | Isolated synthetic services |
| Metadata migration | Through version 6 passed | Revision-aware connection schema included |
| `bun run typecheck` and `bun run build` | Passed | Current local application source |
| `bun run test` | Latest 26 tests, 154 assertions passed | Unit coverage; not native recovery |
| `bun run typecheck:acceptance` | Passed | Acceptance harnesses, Playwright config and setup scripts included |
| `bun run test:integration` | 34 tests, 209 assertions passed | Guarded metadata/API/MCP contracts, credentials, connection lifecycle and mocked HEAD observations |
| `Dockerfile.engines` | Ubuntu native ARM64 worker image built | Package resolution/build; not an amd64 or eight-engine runtime pass |
| API and worker | Running in Docker with fresh `server`/`shared` source bind mounts | Development runtime, not a clean immutable packaged release |
| `acceptance/mcp-recovery.test.ts` rerun | Both PostgreSQL 17 and MariaDB 11 scenarios passed, 27 assertions | Native dump → S3 → worker download/SHA gate → separate precreated target → manifest validation |
| MySQL 8.0.46 MCP | 1 test / 63 assertions passed after restart | Independent MySQL dump/client, S3 GET/SHA, exact data/schema/constraints/identity |
| ClickHouse 25.8.12 MCP | 1 test / 20 assertions passed after restart | Native disk archive and restore, independent rows/types/Native streams |
| Permanent storage failures | 1 test / 510 assertions passed | Actual missing bucket and denied credentials; attempt 1 terminal failure, no artifact or bounded-window retry |
| Transient storage retry | 1 test / 21 assertions passed in 14.70s | Own RustFS same-ID stop/start; same job attempt 2 success, one artifact and independent GET/SHA |
| Post-restart integrity checks | amcheck; 46 secrets; 19 stored objects passed | Existing metadata structure, credential decryption and full object bytes/SHA before later acceptance artifacts |
| Independent SQL in MCP harness | Passed | PG: 1,000 entries, `625625.00` sum, next project identity 2. MariaDB: 3 entries, `7.5` sum |
| Headless browser smoke | Login and six main sections rendered | [Overview screenshot](../output/playwright/local-overview.png); render evidence, separate from recovery below |
| Full Playwright recovery + management suite | Latest 4/4 passed in 36.4s | PG/Maria forms/jobs/S3/restore with independent reads; connection lifecycle and agent scopes/revocation |
| Authenticated Scalar `/openapi` | API heading and full operation list rendered; zero page errors | Same-origin local bundle, real headless browser |

Preview: [http://127.0.0.1:4310](http://127.0.0.1:4310).

The MCP recovery runs also confirmed stable backup/restore request keys and refusal to
reuse the occupied destination. Target databases and recovery history are retained.
The worker verified downloaded-byte SHA-256 before target writes and compared manifests;
the harness independently queried recovered counts/sums and the PostgreSQL identity.
That distinction matters: the MCP harness is not an independent full-object download check.

The UI suite created its own synthetic source/target connections and S3 buckets through the
real forms. It checked metadata-only HEAD messaging separately from an independent S3 GET
and SHA-256, enforced the restore review checkbox, and observed schema/data/sequence results
in the UI. Direct SQL confirmed PostgreSQL's 1,000 rows, `625625.00`, dropped-column logical
layout, Unicode/bytea and next identity 2; MariaDB's 3 rows, `7.5`, FK/CHECK behavior and
auto-increment 41. Sources, targets, roles, buckets and history are retained. These are the
two local profiles covered; responsive/physical-device and broad accessibility acceptance
are still separate.

The executor found and fixed JSONB object-key-order sensitivity in manifest comparison
using standard deep comparison, and quoted the MariaDB `rows` alias. The passing rerun
covers those fixes. The UI harness's select locator was corrected to use the real browser
combobox role/name; that is not a general accessibility audit. The integration group was
rerun after the comparison fix and again passed 34 tests / 209 assertions. Source-authored
assertions alone were not counted as execution.

## Remaining proof gates

| Requirement | Necessary evidence | Current status |
| --- | --- | --- |
| Start + Elysia + TanStack DB | Current install/build/typecheck, real route data and stale/error states | Install/build/typecheck and route smoke passed; broader UX/state acceptance pending |
| Reference-quality UI | Desktop/mobile comparison against Databasement and Salt, keyboard/modal states | Functional UI recovery/render passed; visual/responsive/a11y acceptance pending |
| PostgreSQL 17 | Native recovery plus independent schema/data/sequence checks and adverse cases | Local MCP/UI plus selected cancellation, SIGKILL/restart and S3 failure/retry cases passed; full fault/partial-write matrix pending |
| MariaDB 11 | Native InnoDB recovery with exact client/server constraints | Local MCP and real UI recovery passed; native adverse cases pending |
| MySQL 8 | Independent MySQL client/server pipeline, exact types/constraints and auto-increment | MySQL 8.0.46 native MCP passed 1 test / 63 assertions; broader fault/UI profile pending |
| MongoDB | Native archive, BSON/index/options match, source-lock loss/SIGKILL reconciliation, sentinel/restricted target | 8.0.34 / Tools100.20 native MCP recovery passed; lock-loss/SIGKILL matrix pending |
| SQLite | Online/WAL snapshot, implicit rowids, identity/FK checks, path/symlink/hardlink guards | Linux-writer live-WAL MCP recovery, rowids, identity/FK and hard-link refusal passed; broader fault/path matrix pending |
| Redis | Atomic DUMP capture, binary keys/types/streams, absolute TTL including expiry; no FLUSH/REPLACE | 7.4.12 native MCP recovery passed including binary keys/types and exact expiry; Redis8/fault matrix pending |
| ClickHouse | Native disk archive, shared spool, ASYNC reconciliation and independent data checks | ClickHouse 25.8.12 native MCP passed 1 test / 20 assertions; native uncertainty/fault/UI matrix pending |
| SQL Server | Supported physical Linux x64 helper, read-only source BACPAC, empty target import and independent validation | Helper compiled with patched Pkcs; supported x64 runtime/package/permission/recovery proof pending |
| AI-agent access | Scope denial, expiry, delegation/revocation, audit, UI and MCP management | Targeted metadata/API/MCP tests and real browser issuance/scope/revocation workflow passed; broader delegation/expiry cases pending |
| Durable jobs | Kill/restart on dump/upload/commit boundaries; no lost job, false success or restore replay | Ordinary jobs, selected dump/restore cancellation/SIGKILL/restart quarantine and permanent S3 refusals passed; actual storage retry passed; full boundary/partial-write matrix pending |
| Schedules | Timezone/DST/missed/overlap and unique occurrence under concurrency | Relevant unit/integration cases passed; real scheduled native execution pending |
| Secrets | No credentials in responses/errors/logs, ciphertext protection, key recovery | Targeted tests passed; complete operational/log/key-recovery audit pending |
| Connection lifecycle | CAS, secret preservation, active/journal guards, stale checks, immutable identity and history-preserving removal | Guarded integration and real browser secret rotation/revision/removal workflow passed; full concurrency matrix pending |
| Artifact availability | Present/missing/changed/unknown, bounded HEAD, denied/timeout unknown, stale/credential races | Mock-provider/metadata tests plus real UI HEAD and independent GET/SHA passed; real deletion/denial matrix pending |
| Target protection | Source aliases, metadata, nonempty/unknown target, version and privilege failures | MCP occupied-target refusal and targeted cases passed; full refusal matrix pending |
| Retries/cancellation | Safe bounded retries, confirmed process-group stop, partial target retained | Selected cancellation/SIGKILL/quarantine, permanent S3 refusals and real attempt-2 storage retry passed; full late-result/partial-write matrix pending |
| REST/OpenAPI | Actual schema correspondence, auth, errors and stable operation IDs | Targeted integration/Scalar render and separate ARM64 packaged UI/API/MCP PG/Maria proof passed; latest mobile CSS image pending |
| MCP | Official-client discovery, same native flow, scope denial and idempotency | Seven ordinary native engine profiles passed; MSSQL and broader adverse matrices pending |
| Self-hosted delivery | Clean isolated Compose, packaged single-origin UI/API/MCP and separate immutable worker | Clean ARM64 no-source-bind installation passed 1 / 91 for PG/Maria; latest mobile CSS image and other engine/architecture coverage pending |
| No collateral changes | Preserve data/volumes; no production, deployment, publication or paid services | Local synthetic scope retained |

A lint/typecheck, screenshot, API 200, S3 HEAD, metadata digest or zero native-tool exit
cannot replace recovered-data evidence. Passing fixture profiles do not establish
support for all eight engines, arbitrary schemas, production or business-level recovery.

## Outstanding adverse-case matrix

Invalid source/S3 credentials; forbidden bucket; disk/file budget; stalled child process;
corrupt archive; source=target aliases; unsupported version; nonempty or uncertain target;
unsupported extensions/ACL; cancellation before/during writes; worker kill; metadata connection
loss; late completion after ownership transfer; duplicate API/MCP requests; UI disconnect;
real scheduled jobs across timezone/DST/missed/overlap boundaries; missing real S3 objects.

Some input, scope, idempotency and mocked provider cases have targeted test evidence above.
The full native failure-injection matrix has not passed. Keep all such checks synthetic and
isolated. Harness/admin setup precreates test targets; restore does not create or clean them.

## Harness inventory

- `acceptance/mcp-recovery.test.ts`: PostgreSQL and MariaDB ordinary native recovery passed
  in the recorded rerun; target fixtures are intentionally retained.
- `tests/api.integration.test.ts`, `tests/connections.integration.test.ts` and
  `tests/artifact-availability.integration.test.ts`: guarded `synthetic-local` metadata tests
  passed as the 34-test integration group. HEAD provider mocks are contract evidence only.
- Unit script sources, including manifest/lock regression tests: latest 18 tests / 68 assertions passed.
- `acceptance/ui/recovery.spec.ts`: both real UI recovery scenarios passed (2/2); independent
  S3 GET/SHA and SQL checks distinguish this from render-only smoke. [Harness details](../acceptance/ui/README.md).
- `compose.extra-engines.yaml`, `scripts/seed-extra-fixtures.ts` and
  `acceptance/extra-engines.test.ts`: MongoDB, Redis and SQLite passed 3 tests / 106 assertions;
  explicit `synthetic-local-extra` opt-in. SQLite then passed 35 assertions with an additional
  exact live-WAL row-count check. The one-off Linux writer is `scripts/sqlite-fixture-writer.ts`.
- `compose.clickhouse-fixture.yaml` and `acceptance/clickhouse-recovery.test.ts`:
  ClickHouse 25.8.12 native MCP passed 1 / 20; broader fault cases pending; `synthetic-local-clickhouse` opt-in.
- `compose.mysql-fixture.yaml` and `acceptance/mysql8-recovery.test.ts`: MySQL 8.0.46 independent
  native recovery passed 1 / 63; packaging alone was not counted as execution.
- `compose.mssql-fixture.yaml`, `acceptance/mssql-recovery.test.ts` and `Dockerfile.mssql`:
  optional provisioned SQL Server profile remains unrun, including restricted-source export.
- `Dockerfile.engines`: ARM64 build and clean no-source-bind PG/Maria packaged proof passed; other
  architecture/profile matrices and latest mobile CSS packaged rerun remain outstanding.

## Extra-engine execution notes

MongoDB 8.0.34 / Tools100.20 passed full native archive recovery, independent lossless
EJSON documents, ordered compound indexes/options, restricted sentinel target, source
preservation, source-alias and occupied-target refusal. Read-only checks established that
the initial currentOp failure happened before lock acquisition; no journal/unlock cleanup
was needed. Fixed omitted unlocked `fsyncLock`, optional-valued `--archive=<file>` syntax,
and shared comparison of JSON-persisted values rather than JS prototypes. Old failed jobs
and their blocked targets remain untouched.

Redis 7.4.12 passed independent S3 GET/SHA, binary keys/payloads, hashes/lists/sets/sorted
sets/streams, exact absolute expiry and natural expiry before restore. Explicit per-command
node-redis type mapping keeps raw DUMP bytes binary-safe. ACL fixture files accept user
rules only; comments were moved into Compose.

SQLite uses Bun's 3.53.2 inspector and native sqlite3 3.45.1 online backup/restore. The first
macOS-writer/Linux-reader live-WAL run missed the new marker; a later unchanged rerun passed.
The underlying cross-platform cause was not established and that first run is not accepted
proof. The harness now starts its fixture writer in Linux, commits/holds a live WAL, and
checks the exact recovered marker/blob/count, rowids, identity 11, FK/integrity, user_version,
occupied-target preservation and hard-link refusal. That profile passed in the combined
group and a subsequent 35-assertion run. It does not qualify cross-kernel/network-filesystem
SQLite access or crash consistency.
## Platform continuation · 31 October 2026

The owner expanded the active goal to the complete platform in [GOAL.md](../GOAL.md). Current source changes add collection search/filters and no-match states, context-sensitive first-backup guidance, clear source/restore roles, schedule presets and honest connection-test scope. Workspace rendering passed 18 synthetic browser assertions, and forms passed 15 interaction assertions plus 13 SSR guards. These use mocked API responses and do not qualify native backup/recovery. Actual isolated owner setup/sign-in/session revocation passed separately (1 test / 44 assertions); main owner credentials remain the user's choice.

MongoDB admission now serializes source operations across database/endpoint aliases and respects retained server-wide source-lock journals before creating a run/outbox entry. A dedicated real metadata test passed 28 assertions in 409ms, including concurrent admission, manual refusal, scheduler outcomes, blocked connection DTOs, frozen credential rotation and idempotent result retrieval. The existing journal is preserved. This conservative admission also serializes independent Mongo servers until physical identity is available before admission; target database identities are unchanged. This test does not run a native Mongo dump. Its disposable metadata database was removed after data/client guards.

The root unit group passed 32 tests / 216 assertions, and application/acceptance TypeScript checks passed. All UI/backend iteration used existing dependencies/source mounts; no Docker image build was performed. Current packaged images still predate owner auth and this platform UI.
