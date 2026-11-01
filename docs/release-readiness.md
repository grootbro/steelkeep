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

## GitHub source preparation — 1 November 2026

- README now has original theme-aware branding, honest static badges, light/dark
  interface captures with synthetic-data provenance, a feature overview, numbered
  setup, MCP entry points and a documentation navigator. No CI-passing, star-count
  or production-certification badge is claimed.
- `.github/workflows/ci.yml` pins checkout/setup-bun to verified commit IDs. It has
  read-only repository permissions, no persisted checkout credentials, concurrency
  cancellation and a 15-minute job. It runs locked install, both TypeScript checks,
  default tests and the web build; no native fixtures or deployment. The first
  actual GitHub run is pending.
- Issue/PR templates request synthetic reproduction and sanitized evidence. Enable
  GitHub private vulnerability reporting when creating the repository.
- Public installation/architecture instructions no longer identify the operator's
  deployment host. Original operator documents and stale design-agent state were
  preserved outside this checkout; current design authority is DESIGN.md.
- An independent read-only audit examined 27 commits, 305 tracked paths and 584
  historical text blobs. Selected secret patterns found no actual credentials;
  credential URLs were fixtures, placeholders or interpolation. No tracked runtime
  state/archives/keys were found, and the largest historical blob was 1.43 MB.
  This is a bounded source-publication audit, not a dependency/security certification.
- Historical personal paths and topology remain in Git history. Exact-path guards
  remain in historical harnesses deliberately. No history rewrite was performed.
- Static Markdown checks found no broken relative file links, YAML parsed, and Git
  whitespace checks passed. No local application, browser, install, build or tests ran.

Before the upload, review the final staged diff, choose the repository namespace
and visibility, and explicitly decide which unfinished feature changes to include.
Keep source-release preparation separate from dashboard/runtime acceptance. No
remote repository, push, public release or deployment was created by this preparation.

## Public source upload — 1 November 2026

The owner explicitly authorized publication to `grootbro/steelkeep`. The repository
is public with `main` as its default branch, project topics and private vulnerability
reporting enabled. Prepared source and its audited history were pushed; unfinished
dashboard status-count changes remain local and were not included.

GitHub CI on `9482cc8` passed both TypeScript checks, 90 default tests with 755
assertions and the web build. The manual README preview passed four real GitHub
browser cases: desktop/mobile in light/dark, all six images loaded and the original
brand/dashboard theme sources matched. Screenshots use the public page, not a local
Markdown approximation. This does not add native recovery or new image evidence.

The follow-up only changes publication documentation and preview framing; its push
skips duplicate application CI. README rendering is checked again by the manual
preview workflow. No Mac application/browser/install/build/test or Docker run occurred.
