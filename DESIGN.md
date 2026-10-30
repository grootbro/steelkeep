# Steelkeep interface

Mode: Operate. User-pinned reference: Databasement, not an independent minimalist reinterpretation. Previous muddy green palette is rejected and replaced.

## Visual thesis

A cool graphite operational workspace: a quiet fixed sidebar, compact violet actions, large truthful summary numbers, a full-width activity chart, dense job history, and secondary status/storage panels. Instrument Sans follows the main reference. Source: Databasement commit e7535032de8570f97b982c857b809caa7f1f4a24 (28 October 2026). Source read and bundled screenshot visually inspected during research; its older Jobs menu/donut are not treated as current IA.

## Composition and navigation

250px sidebar, desktop main gutter 32px, page heading separated by a hairline. Dashboard: three summary cards; 14-day UTC activity chart; jobs table (roughly two thirds) alongside job-status grid and storage usage. Below 1250px jobs and side panels form separate rows; below 680px sidebar becomes a drawer. Connections and snapshots use dense tables. Backup plans show route, schedule, timezone, next runs, policy and occurrence history. No marketing hero, eyebrow or workflow filler.

## Tokens

- Ground #191e27; sidebar #171c25; panels #222936; raised control #2b3342.
- Primary text #e9edf4; secondary text #a7b1c1; separator #343e50.
- Accent #9a8aff; action fill #7665e9; success #2dd4a3; failure #fb7a92; warning #f2c467; secondary chart blue #72b5ff.
- Font: self-hosted Instrument Sans Variable via @fontsource-variable/instrument-sans. Mono only identifiers, hashes, cron and technical values.
- Page title 29px / 680; panel title 18px / 650; body 14px; table 12px; contextual metadata 10–12px; tabular numeric values.
- Panels radius 12px; controls 7px; fields minimum 42px height. No decorative shadows on routine panels. Dialog shadow only.

## Data and interaction rules

All cards/charts derive from API DTOs. Summary counts/bytes use full artifact aggregates; fallback labels explicitly say recent. Thirty-day success rate excludes cancelled/interrupted from denominator and is not restore validation. Chart groups backup/restore created jobs per UTC day, with failed as overlapping subset, never stacked twice. Latest jobs are sorted with active operations first. Volume distribution is explicitly bounded to recent 100 artifacts.

REST action success invalidates overview/jobs/detail queries; jobs use TanStack DB query-backed collection. No optimistic terminal state or made-up percentage. Job detail shows phase, timestamps, heartbeat, bounded safe validation metadata and event log. Stale heartbeat shows uncertainty. Run status vocabulary matches the API: queued, running, cancelling, succeeded, failed, cancelled, interrupted. The completed string is a phase, not a run status. Cancel requests wait for worker state; restore cancellation asks for explicit confirmation and explains that partial data and a blocked target are possible after writes begin.

Restore opens a protected native dialog: artifact context → choose matching-engine restore-only connection → server preflight → source/target review + warnings → explicit acknowledgement → start using intent and one stable idempotency key generated when that intent is prepared. An ambiguous network/server error preserves the review and key; retry recovers the same request result. Changing the destination is disabled while that result is unknown. The target identity is not user-supplied free SQL. Interrupted and blocked target states stay visible. Native dialog provides focus containment, escape handling and focus return. Mobile navigation and content tables retain native scroll behavior. Reduced-motion preference disables authored transitions.

## Reference use and licensing

Databasement MIT reference informed dashboard composition, summary hierarchy, activity/status panels, source-storage-schedule grouping, snapshot context and job-log flow. This is TypeScript/React implementation, not copied Blade component code. Root repository attribution documents reference reuse.

Salt.md theme source was read as the second reference, for consistent active/hover/focus vocabulary and panel semantics. No Salt AGPL source copied. Its paper/green palette and decorative effects do not override the requested Databasement direction.

## Validation boundary

Code and static source inspection only. Per user's current instruction, no browser, screenshot capture, service, build, lint, test, or typecheck was run for this redesign. Contrast, responsive layout, native-dialog focus behavior and endpoint integration remain unverified in a rendered application. This document records intended shipped tokens and composition, not visual acceptance.
