# Steelkeep platform goal

Owner scope update · 31 October 2026

Build a complete self-hosted open-source backup and recovery platform for everyday use. The earlier goal's restriction against building a platform and its optional AI-agent scope are superseded by the owner's explicit instructions.

Use TypeScript, TanStack Start/Router/DB, Elysia, PostgreSQL metadata, S3-compatible artifacts, durable jobs/workers and timezone scheduling. OpenAPI/Scalar, native MCP and AI-agent management are required: named agents, scoped permissions, expiry, revocation and audit through shared application services.

Match Databasement’s complete core backup-management functionality and operational design using its actual source as the reference, while keeping the approved TypeScript architecture and Steelkeep branding. Track every reference feature/screen/action and its implemented or unverified state in docs/databasement-parity.md; a similar palette or generic CRUD dashboard does not establish parity. Use Salt.md UX ideas, the owner's original Steelkeep PNG artwork and Milk/Graphite/Blue Violet palette. Include compact owner setup and daily sign-in, one light/dark icon button, Overview, Connections, Plans, Jobs, Snapshots, safe Restore and Configuration. First backup must clearly lead from a real database and storage configuration through checks, plan creation and execution to an inspectable artifact. Show honest phases, logs, history, availability and integrity evidence; distinguish reachability from backup privileges and HEAD metadata from downloaded-byte checksums.

Required engine profiles: PostgreSQL, MySQL, MariaDB, MongoDB, SQLite, Redis, ClickHouse and Microsoft SQL Server. Publish exact qualified versions, consistency guarantees, prerequisites and limitations. Implement retries, restart recovery, cancellation, idempotency, uncertain-outcome blocking, secret protection and separate empty restore-target guards. Never replay an uncertain restore or overwrite a source.

Complete usable installation/operation documentation and actual synthetic integration/E2E proofs through UI and MCP. Written tests, mocked views and CLI exit codes alone do not establish backup/recovery: require native dump/upload/download/restore, independent SHA-256 and database-content checks. Existing successful proofs do not qualify subsequent changes automatically.

Work in the repository and keep its qualification and parity ledgers current. Use relevant skills and parallel agents with disjoint write scopes; root integrates finished slices. Prefer existing dependencies, Vite and source mounts. Avoid repeated Docker builds for ordinary UI/code changes; package at a deliberate checkpoint and clean only verified obsolete project resources, preserving data, archives and volumes.

Latest owner execution constraint: Docker Desktop and local development processes are stopped; continue code/design work locally, but perform any further application/browser/dependency/build/typecheck/test execution only on an isolated server stand. Do not restart local runtimes or reinstall local dependencies without a new instruction. Prioritize dedicated visual implementation matching Databasement's actual dashboard and remaining screens, with Steelkeep branding.

Do not touch unrelated projects or production, connect or move real data/secrets, deploy, publish or incur expenses without separate authorization. Billing, paid Cloud, PITR and enterprise features remain outside scope unless separately requested. Continue autonomously until the agreed platform scope is complete, reporting tested behavior and material limitations honestly.
