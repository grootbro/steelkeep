# Architecture and current evidence

TanStack Start owns the web application; Elysia owns REST/OpenAPI/MCP and application commands.
PostgreSQL metadata, Kysely, pg-boss, isolated worker CLI, S3-compatible artifacts.
Required engines: PostgreSQL, MySQL, MariaDB, MongoDB, SQLite, Redis, ClickHouse and SQL Server. Shared adapter contracts, profile-specific consistency and validation. Never imply an untested version is supported.

User correction: closely follow Databasement's actual operational composition and polish;
the previous jade/muddy green direction is rejected. Cool neutral/slate surfaces, readable
type and dense operational rows; blue/violet accents. Salt.md supplies secondary UX ideas.
The user's permission includes licensed interface-code adaptation; preserve provenance.

On 31 October the owner requested a working local preview and authorized local install,
build/typecheck/tests and isolated fixture services. That review phase is now active.
Only synthetic local services are in scope; production, deployment, publication and paid
services remain outside it. The current preview is [127.0.0.1:4310](http://127.0.0.1:4310).

Root integrates subagents with disjoint boundaries: src/design, native engines/restore,
application API/MCP/schema/scheduler; root owns worker/deployment/docs and final contracts.

Implementation and local review started 31 October 2026. Frozen install, preserved key/token
setup, migration 6, typecheck and build passed. The executor recorded latest 18 unit tests / 68
assertions and 34 guarded integration tests / 209 assertions passed. The ARM64 Ubuntu worker
image built; the running Docker API/worker use fresh source bind mounts. This is development
runtime evidence, not clean immutable self-hosted delivery.

Native MCP recovery passed for PostgreSQL 17 and MariaDB 11: actual dump/upload/download,
worker SHA-256 gate, fresh separate precreated target and manifest validation. Independent
SQL checks confirmed fixture counts/sums and the PostgreSQL identity. Both scenarios passed
27 assertions after runtime fixes. MongoDB, Redis and SQLite subsequently passed native MCP
recovery (3 tests / 106 assertions), with an additional Linux-writer live-WAL rerun. MySQL8,
ClickHouse, SQL Server and crash/restart/cancellation injection remain pending.
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
The application and acceptance harnesses typecheck. Five ordinary native recovery profiles
have execution evidence; the remaining adapters, adverse cases and clean packaged delivery
remain proof obligations.

Scalar is pinned and served from the installation's own dependency asset, with CDN fonts,
credential persistence and proxy disabled. Authenticated API/MCP responses use no-store.
The package metadata advertises standalone.js, while the OpenAPI plugin's default CDN path
uses standalone.min.js; the explicit local asset path avoids depending on that moving URL.
The local build, headless login/navigation and authenticated Scalar `/openapi` browser render
passed. The API heading and operation list rendered from the local bundle with zero page
errors. This does not cover clean packaged delivery or a full API-client compatibility matrix.

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
manifests and quote MariaDB's reserved `rows` alias. Independent MySQL 8 recovery is still pending.

Headless browser login and all six main sections rendered against the local runtime; an
[overview screenshot](../output/playwright/local-overview.png) was saved. The real UI recovery
suite then passed both PostgreSQL and MariaDB scenarios (2/2, 28.5 s): form-created profiles,
native jobs, metadata-only availability, independent S3 GET/SHA, explicit review confirmation,
displayed schema/data/sequence validation and independent SQL. The PG fixture's dropped
column, Unicode/bytea and identity were checked; MariaDB's FK/CHECK and auto-increment 41
were checked. Broader responsive/keyboard/visual and physical-device acceptance remain open.
Failure/ownership-transfer behavior requires deliberate injection; it is not inferred from
these successful ordinary recovery paths.
