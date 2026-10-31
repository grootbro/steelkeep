# Steelkeep

Self-hosted backup and recovery product. TanStack Start + Elysia are user choices.
Read docs/architecture.md and the kickoff in /Users/dobrota/dev/reports/stillkeep-research-20261031.
The owner expanded the objective to a complete platform on 31 October. Read GOAL.md for the current agreed scope; AI-agent support and all eight engine profiles are required.

## Current user instructions (31 October 2026, take priority)

- Latest owner authorization: deploy an accessible HTTPS installation on the server and provide a private first-owner link so the owner can inspect the interface and try their first backup. Keep this installation separate from synthetic stands and existing services. Actual user database connections require owner-specified targets; local execution remains suspended.

- **Latest owner override:** stop Docker Desktop and local development processes, clean this project's disposable files, and continue writing code locally. All further application runs, browsers, installs, builds, typechecks and test execution must happen on an isolated server stand. Do not restart local Docker/Vite or reinstall local dependencies without a new owner instruction. File reads/edits, Git and scoped cleanup remain local. Preserve database/artifact volumes, metadata/secrets, original brand assets and proof evidence. This supersedes the earlier local-preview/run authorization below.
- The owner specifically requests a dedicated visual-design agent and close visual correspondence to Databasement, especially its dashboard and then the remaining screens. Inspect actual reference source/composition; keep Steelkeep's supplied PNG branding and improve polish without replacing the reference with a generic dashboard.

- Code/design-first phase is complete enough for local review. On 31 October the owner asked «есть что локально посмотреть уже?»; local install/build/typecheck/tests and isolated Steelkeep fixture services are now authorized as necessary to provide a working local preview. Start and verify the app, provide its URL; preserve existing fixture volumes. Do not launch a visible browser prematurely or touch production. Earlier passed checks are historical evidence only.
- UI must closely follow Databasement's polished operational dashboard and screens; use Salt.md as a second source of useful interaction/technology ideas. User rejected the muddy green direction. Read actual reference source, don't substitute personal minimalist styling.
- User explicitly permits reusing open-source interface code subject to its license. Preserve attribution for adapted Databasement MIT code. Salt.md local source is AGPL; don't silently copy its code into differently licensed product.
- User explicitly requests subagents. Keep their write boundaries disjoint; root integrates into one coherent app.

- Only synthetic isolated data. No production connections, deployment, publication or paid services.
- The owner explicitly authorized choosing server A or B for a separate synthetic SQL Server acceptance stand on 31 October. Read-only capacity checks selected A (185.70.198.142). Keep the stand in its own project/network/paths with loopback ports and resource limits; do not connect existing services or change their databases. The owner explicitly confirmed Microsoft SQL Server EULA acceptance for this temporary Developer-edition stand. Keep at least 8 GiB free on A, cap build/runtime CPU and RAM, and clean only this stand’s verified build resources.
- Preserve secrets and data; never restore over source, metadata DB, or a nonempty target.
- REST and MCP call the same application services; native tools execute in worker only.
- No optimistic job success or invented progress. Backup success, checksum and restore validation differ.
- Never auto-retry a restore after writes. Unknown outcome stays interrupted and target blocked.
- Tests must prove actual dump/upload/download/restore and fixture data through UI and MCP.
- Keep history and safe error states. No secret in response, command argv or persisted log.
- Implement finished slices; do not replace the requested product with a mocked dashboard.

## Local resources

- Local execution is currently suspended by the latest owner override. The existing dependencies/build output were removed as reproducible files; the lockfile remains authoritative. Instructions below describe the earlier development workflow and do not authorize restarting it.

- Use the existing Vite server and source-mounted API/worker for code, CSS and auth work. Do not rebuild Docker images for UI edits.
- Build immutable images only for an explicit packaging checkpoint or changed native dependencies. Build one image at a time; inspect host free space first and never assume a warm cache.
- After heavy acceptance, remove this checkout's obsolete images and build-history/cache records by verified identifiers. Keep one reusable worker image; never use global prune or remove database/artifact volumes.
- A persistent package cache must live in a named BuildKit cache mount, not in every image layer. Cache mounts are not a disk quota; inspect and clean this project's unused cache after packaging.
