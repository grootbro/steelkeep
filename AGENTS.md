# Steelkeep contributor guidance

Self-hosted backup and reviewed recovery in TypeScript, TanStack Start and Elysia.
Start with README.md, docs/architecture.md and GOAL.md. Current engine qualification
is in docs/server-runtime.md; track remaining parity in docs/databasement-parity.md.

## Current workspace execution constraint

The owner's Mac application runtimes and Docker must remain stopped. Local file
reads/edits and Git are allowed. Application installs, builds, typechecks, tests and
browsers must run only on an explicitly authorized isolated server stand. Do not
restart local services or reinstall local dependencies without a new instruction.
This restriction applies to this workspace, not to contributors' own CI runners.

## Changes and evidence

- REST and MCP call the same application services. Native tools execute only in
  the worker. Keep the UI connected to actual operations and truthful status data.
- Preserve secrets, metadata, archives, reservations and original brand PNGs.
  Never restore over a source, metadata database or nonempty target.
- Never replay an uncertain restore after writes. Retain its target reservation
  for operator reconciliation. Do not clear partial targets to make a proof pass.
- Use isolated synthetic fixtures. Real database connections, deployment,
  publication and paid services require separate authorization.
- Some historical harnesses have exact checkout/fixture guards. Do not remove
  those guards to make them run on a different machine.
- Native recovery evidence requires actual dump/upload/download/restore,
  independent complete-byte SHA-256 and independently queried restored data.
  Typechecks, mocked screens and CLI exit codes establish narrower facts.
- Reuse dependencies and images. Avoid rebuilding for ordinary code/CSS changes.
  Inspect capacity before heavy work; preserve at least 8 GiB free on the authorized
  shared stand. Remove only verified owned disposable resources; no global prune.
- The owner requests parallel agents with disjoint write scopes. Integrate each
  finished slice and its contracts before expanding the work.

## Interface and licenses

Follow Databasement's actual operational composition, particularly its dashboard,
while retaining Steelkeep's original PNG mark/wordmark and Inter/Milk/Graphite/Violet
design. Use one light/dark icon button. Read DESIGN.md and reference source before
changing composition; generic dashboard styling does not establish visual parity.

Databasement adaptations retain MIT attribution in THIRD-PARTY-NOTICES.md. Salt.md
is an interaction reference only; do not copy its AGPL code/assets into this MIT
project without resolving licensing. Optional Microsoft tooling keeps its own terms.
