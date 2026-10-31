# Contributing

Steelkeep is an alpha TypeScript application using TanStack Start, Elysia, PostgreSQL metadata and S3-compatible archives. Start with README.md and docs/architecture.md; check docs/databasement-parity.md for implemented behavior and remaining work.

Keep changes focused. REST and MCP must call the same application services. Native tools run only in the worker. Preserve source/target identity guards, durable request keys, secret redaction and uncertain-outcome reservations. Never replace actual progress with optimistic success.

Run the relevant typechecks/default tests in an environment authorized for execution. Changes to a native profile require isolated synthetic backup/upload/download/restore evidence and independent restored-data checks. Mocked UI responses or a zero CLI exit code alone do not establish recovery. Never point acceptance scripts at production or erase a partial target to make a retry pass.

Keep credentials, dumps, generated binaries, dependency folders and runtime volumes out of Git. Use `.env.example` for nonsecret configuration examples. Preserve third-party notices when adapting source; do not copy AGPL source/assets into this MIT project without resolving the license implications.

A useful pull request describes the concrete problem, resulting behavior, validation and remaining limits. Explicitly distinguish source-only work from executed proof and current runtime qualification from historical results.
