# Architecture and current evidence

TanStack Start owns the web application; Elysia owns REST/OpenAPI/MCP and application commands.
PostgreSQL metadata, Kysely, pg-boss, isolated worker CLI, S3-compatible artifacts.
Required engines: PostgreSQL, MySQL, MariaDB, MongoDB, SQLite, Redis, ClickHouse and SQL Server. Shared adapter contracts, profile-specific consistency and validation. Never imply an untested version is supported.

User correction: closely follow Databasement's actual operational composition and polish;
the previous jade/muddy green direction is rejected. Cool neutral/slate surfaces, readable
type and dense operational rows; blue/violet accents. Salt.md supplies secondary UX ideas.
The user's permission includes licensed interface-code adaptation; preserve provenance.

Latest user instruction: code and design first. No browsers, services, containers, builds,
tests, lint, or typechecks until the user asks to start running/reviewing. All earlier runtime
results predate this instruction and do not validate subsequent edits.

Root integrates subagents with disjoint boundaries: src/design, native engines/restore,
application API/MCP/schema/scheduler; root owns worker/deployment/docs and final contracts.

Implementation started 31 October 2026. No product acceptance tests passed yet.

31 October expansion: native AI-agent access is required scope, superseding the original
goal's optional-agents wording. Agent identities and hash-only scoped credentials are
stored in metadata with expiry, descendant revocation and sanitized audit. UI and MCP
manage the same identities and services; secrets are returned only once on token issue.

The current native strategy uses engine-owned capture/restore under one common immutable
S3 publication and trusted restore pipeline. MongoDB source-lock journals survive worker
death; ClickHouse native operation journals distinguish HTTP loss from server completion.
SQL Server uses an optional .NET DacFx BACPAC portability helper, never passwords in argv.
See [engine profiles](engine-profiles.md) and [fresh research](fresh-tech-research-20261031.md).
These contracts and source files remain uncompiled/unexecuted under the current instruction.

Scalar is pinned and served from the installation's own dependency asset, with CDN fonts,
credential persistence and proxy disabled. Authenticated API/MCP responses use no-store.
The package metadata advertises standalone.js, while the OpenAPI plugin's default CDN path
uses standalone.min.js; the explicit local asset path avoids depending on that moving URL.
This source integration still needs the postponed browser/build acceptance.
