# Open-source release preparation

Prepared as an alpha source release; no repository has been created, pushed or published by this checkpoint.

- README now describes the product, eight bounded engine profiles, installation, owner setup, first backup, API/MCP and recovery/deletion behavior. Long historical development transcripts remain in the acceptance ledger rather than the landing page.
- MIT license and Databasement attribution are present. Salt.md is an interaction reference; its AGPL code/assets were not copied. Original owner-supplied brand PNGs and font notices are retained. Optional Microsoft binaries keep their own terms and are not committed.
- CONTRIBUTING.md and SECURITY.md describe focused changes, synthetic qualification and private vulnerability reporting without inventing an active support address.
- Production Dockerfile includes the first-owner helper. Fresh-install instructions explicitly pull the metadata image before `--pull never`. Compose forwards SQLite/ClickHouse root settings, with explicit mount and optional MSSQL runtime-UID instructions.
- Environment files, private runtime state, dependencies, build output, dumps and generated helper binaries are ignored. Build context also excludes helper bin/obj output. Unwired publication-key prototypes were preserved outside the release checkout.
- A read-only Git scan checked287 tracked files for forbidden runtime paths, all recorded history paths and564 historical text-sized blobs plus21 candidate files for selected strong private-key/token/AWS/GitHub credential patterns: no matches. This is a bounded pattern/file audit, not a claim that every possible secret format or dependency vulnerability was assessed.

Before publishing: choose the GitHub namespace/repository, review any operator-specific acceptance paths and internal deployment notes, and read the final diff. Keep the alpha/profile limitations visible. A public source release does not imply that every native image, provider, production schema or adverse execution boundary has passed. Clean immutable all-engine packaging remains a separate qualification step; current native runtime evidence is in server-runtime.md.

The seven newly added native proof scripts passed the combined server acceptance typecheck. Self-host Compose syntax and Dockerfile helper-copy input were checked on the server. The new dashboard redesign is a separate, subsequent change and must receive its own current-source rendering/data checks before deployment.
