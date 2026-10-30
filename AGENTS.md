# Steelkeep

Self-hosted backup and recovery product. TanStack Start + Elysia are user choices.
Read docs/architecture.md and the kickoff in /Users/dobrota/dev/reports/stillkeep-research-20261031.

## Current user instructions (31 October 2026, take priority)

- Code/design-first phase is complete enough for local review. On 31 October the owner asked «есть что локально посмотреть уже?»; local install/build/typecheck/tests and isolated Steelkeep fixture services are now authorized as necessary to provide a working local preview. Start and verify the app, provide its URL; preserve existing fixture volumes. Do not launch a visible browser prematurely or touch production. Earlier passed checks are historical evidence only.
- UI must closely follow Databasement's polished operational dashboard and screens; use Salt.md as a second source of useful interaction/technology ideas. User rejected the muddy green direction. Read actual reference source, don't substitute personal minimalist styling.
- User explicitly permits reusing open-source interface code subject to its license. Preserve attribution for adapted Databasement MIT code. Salt.md local source is AGPL; don't silently copy its code into differently licensed product.
- User explicitly requests subagents. Keep their write boundaries disjoint; root integrates into one coherent app.

- Only synthetic isolated data. No production connections, deployment, publication or paid services.
- Preserve secrets and data; never restore over source, metadata DB, or a nonempty target.
- REST and MCP call the same application services; native tools execute in worker only.
- No optimistic job success or invented progress. Backup success, checksum and restore validation differ.
- Never auto-retry a restore after writes. Unknown outcome stays interrupted and target blocked.
- Tests must prove actual dump/upload/download/restore and fixture data through UI and MCP.
- Keep history and safe error states. No secret in response, command argv or persisted log.
- Implement finished slices; do not replace the requested product with a mocked dashboard.
