# Architecture and current evidence

TanStack Start owns the web application; Elysia owns REST/OpenAPI/MCP and application commands.
PostgreSQL metadata, Kysely, pg-boss, isolated worker CLI, S3-compatible artifacts.
Required engines: PostgreSQL, MySQL, MariaDB, MongoDB, SQLite, Redis, ClickHouse and SQL Server. Shared adapter contracts, profile-specific consistency and validation. Never imply an untested version is supported.

User correction: closely follow Databasement's actual operational composition and polish;
the previous jade/muddy green direction is rejected. Cool neutral/slate surfaces, readable
type and dense operational rows; blue/violet accents. Salt.md supplies secondary UX ideas.
The user's permission includes licensed interface-code adaptation; preserve provenance.

Current execution policy: the owner's Mac Docker and application remain stopped. All installs, builds, typechecks, browsers and tests run on isolated server stands. An owner-authorized persistent HTTPS installation is now available separately from those stands. Existing historical local results below are evidence from the earlier phase, not instructions to restart local execution. Actual user database targets require the owner's selection; paid services and public repository publication need separate authorization.

Root integrates subagents with disjoint boundaries: src/design, native engines/restore,
application API/MCP/schema/scheduler; root owns worker/deployment/docs and final contracts.

Implementation and local review started 31 October 2026. Frozen install, preserved key/token
setup, migration 6, typecheck and build passed. The executor recorded latest 26 unit tests / 154
assertions and 34 guarded integration tests / 209 assertions passed. The ARM64 Ubuntu worker
image built; the running Docker API/worker use fresh source bind mounts. This is development
runtime evidence, not clean immutable self-hosted delivery. A separate clean ARM64 packaged installation passed 1 test / 91 assertions in 10.09s:
web image ID prefix `4aa204616469`, worker `ed6ac2132f62`, backend `a1e1cf5`. Private
separate metadata/secrets and no application source binds supplied compiled UI login/six
sections and official MCP PG/Maria recovery with independent actual S3 GET/SHA and SQL
into fresh restricted targets. Its web image predates three newer mobile CSS declarations;
rebuilt-image acceptance for those edits is pending. See [packaged proof](selfhost-acceptance.md).

Native MCP recovery passed for PostgreSQL 17 and MariaDB 11: actual dump/upload/download,
worker SHA-256 gate, fresh separate precreated target and manifest validation. Independent
SQL checks confirmed fixture counts/sums and the PostgreSQL identity. Both scenarios passed
27 assertions after runtime fixes. MongoDB, Redis and SQLite subsequently passed native MCP
recovery (3 tests / 106 assertions), with an additional Linux-writer live-WAL rerun.
After the owner-approved Docker restart, MySQL 8.0.46 passed 1 test / 63 assertions and
ClickHouse 25.8.12 passed 1 test / 20 assertions; PG/Maria passed again (2 / 27).
Existing volumes were preserved, metadata amcheck passed, all 46 stored secrets decrypted
and 19 existing S3 objects matched their recorded bytes/SHA-256. SQL Server runtime is
still pending on an owner-provided nonproduction physical x64 Linux runner with EULA
acceptance; its .NET 10/DacFx helper has compiled, including the patched Pkcs dependency.
Selected PostgreSQL cancellation/SIGKILL/restart quarantine passed (1 / 403 assertions),
with a 12-second no-replay window. Permanent S3 refusals passed (1 / 510); an actual own-
RustFS stop/start passed (1 / 21, 14.70s): same job attempt 1 retry_wait/no artifact to
attempt 2 success/one artifact, independent GET/SHA and unchanged source totals. These
checks do not establish partial-write recovery, every lease boundary or the full fault matrix.
[Detailed evidence and proof gates](acceptance.md).

31 October expansion: native AI-agent access is required scope, superseding the original
goal's optional-agents wording. Agent identities and hash-only scoped credentials are
stored in metadata with expiry, descendant revocation and sanitized audit. UI and MCP
manage the same identities and services; secrets are returned only once on token issue.

The current native strategy uses engine-owned capture/restore under one common immutable
S3 publication and trusted restore pipeline. MongoDB source-lock journals survive worker
death; ClickHouse native operation journals distinguish HTTP loss from server completion.
SQL Server uses an optional .NET DacFx BACPAC portability helper, never passwords in argv.
See [engine profiles](engine-profiles.md) and [fresh research](fresh-tech-research-20261031.md).
The application and acceptance harnesses typecheck. Seven ordinary native recovery profiles
have execution evidence; SQL Server runtime, broader adverse cases, additional packaged engine/architecture
coverage and the latest mobile CSS packaged rerun remain proof obligations.

Scalar is pinned and served from the installation's own dependency asset, with CDN fonts,
credential persistence and proxy disabled. Authenticated API/MCP responses use no-store.
The package metadata advertises standalone.js, while the OpenAPI plugin's default CDN path
uses standalone.min.js; the explicit local asset path avoids depending on that moving URL.
The local build, headless login/navigation and authenticated Scalar `/openapi` browser render
passed. The API heading and operation list rendered from the local bundle with zero page
errors. The separate packaged proof covers its own UI/API/MCP PG/Maria path; a full API-client
compatibility matrix and latest mobile CSS packaged rerun remain open.

Connection lifecycle now uses a revision CAS and sorted connection-row admission locks.
Identity remains immutable; name-only edits preserve ciphertext and checked state. Actual
secret/settings changes are rejected during active jobs or an uncertain source journal.
Unused metadata removal refuses all plan/run/artifact/restore references. Bounded connection
probes cannot overwrite a newer revision's status. REST and MCP share these services.

Explicit artifact HEAD probes use a database-clock ordering CAS and storage-revision guard.
404, size mismatch, denial and timeout have separate states; metadata digest agreement does
not establish file integrity. The UI shows check time and separate human-readable restore
validation. Full bytes are SHA-256 checked before restore writes. Pending browser backup keys
are non-secret, actor-scoped session state and survive route changes/reload.

MySQL's native no-TLS client requests a server RSA public key rather than relying on a warm
caching_sha2_password cache; verified TLS remains the default. Manifest sessions disable
information_schema statistics expiry for current auto-increment values. PostgreSQL compares
visible logical column ordinals because a native logical restore compacts dropped slots.
The PG fixture now includes a dropped-column slot. The passing unit group includes manifest
comparison tests; the native PostgreSQL/MariaDB rerun covers logical recovery with the current
comparison. Runtime fixes use standard key-order-independent deep comparison for JSONB
manifests and quote MariaDB's reserved `rows` alias. Independent MySQL 8.0.46 recovery
subsequently passed 63 assertions. Database-level grants now normalize escaped wildcard
characters and verify MySQL partial_revokes mode; quoted raw wildcard target grants are
refused when their scope is broader than the selected destination.

Headless browser login and all six main sections rendered against the local runtime; an
[overview screenshot](../output/playwright/local-overview.png) was saved. The real UI recovery
suite passed both PostgreSQL and MariaDB scenarios; the latest full Playwright group
passed 4/4 in 36.4s, including connection lifecycle and AI-agent issuance, real MCP/API
scope enforcement and UI revocation. Recovery covered form-created profiles,
native jobs, metadata-only availability, independent S3 GET/SHA, explicit review confirmation,
displayed schema/data/sequence validation and independent SQL. The PG fixture's dropped
column, Unicode/bytea and identity were checked; MariaDB's FK/CHECK and auto-increment 41
were checked. Broader responsive/keyboard/visual and physical-device acceptance remain open.
Selected failure behavior has separate execution evidence above. Broader ownership-transfer,
partial-write, crash-boundary and engine-specific source-lock/native-journal cases still
require deliberate injection; ordinary successful recovery does not establish them.
