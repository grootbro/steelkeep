# Steelkeep interface

Mode: Operate. User-pinned reference: Databasement, not an independent minimalist reinterpretation. Previous muddy green palette is rejected and replaced.

## Visual thesis

A Milk/Graphite operational workspace: a quiet fixed sidebar, compact violet actions, large truthful summary numbers, a full-width activity chart, dense job history, and secondary status/storage panels. Inter follows the owner's brand book. Source: Databasement commit e7535032de8570f97b982c857b809caa7f1f4a24 (28 October 2026). Dashboard composition is adapted from its actual summary, activity, latest-jobs, status-grid and storage-distribution views. Steelkeep keeps its own navigation and recovery semantics.

## Composition and navigation

250px sidebar, desktop main gutter 32px, page heading separated by a hairline. Dashboard: three summary cards; 14-day UTC activity chart; compact job rows (roughly two thirds) alongside job-status grid and storage distribution. Below 1220px jobs and side panels form separate rows; below 680px sidebar becomes a drawer. Connections and snapshots use dense tables. Backup plans show route, schedule, timezone, next runs, policy and occurrence history. No marketing hero, eyebrow or workflow filler.

## Tokens

- Dark: ground #181c23; sidebar #161a21; panels #222730; raised control #2b323d; primary text #edf0f6; secondary text #a6b0c0; separator #363e4b.
- Light: Milk ground #f8fafc; white sidebar/panels; raised control #f0f3f8; Graphite text #0f172a; secondary text #5e6c82; separator #dfe5ee.
- Blue Violet brand #6366f1; compact primary buttons #5c5fe2; dark accent #b1a8ff and light accent #5557d8. Status colors remain semantic, with separate readable light-theme treatments.
- Font: self-hosted Inter Variable via @fontsource-variable/inter. Mono only identifiers, hashes, cron and technical values.
- Page title 29px / 680; panel title 18px / 650; body 14px; table 12px; contextual metadata 10–12px; tabular numeric values.
- Panels radius 12px; controls 7px; fields minimum 42px height. No decorative shadows on routine panels. Dialog shadow only.

## Data and interaction rules

All cards/charts derive from API DTOs. Summary counts/bytes use full artifact aggregates; fallback labels explicitly say recent. Thirty-day success rate excludes cancelled/interrupted from denominator and is not restore validation. Chart groups backup/restore created jobs per UTC day, with failed as overlapping subset, never stacked twice. Latest jobs are sorted with active operations first. Volume distribution is explicitly bounded to recent 100 artifacts.

REST action success invalidates overview/jobs/detail queries; jobs use TanStack DB query-backed collection. No optimistic terminal state or made-up percentage. Job detail shows phase, timestamps, heartbeat, bounded safe validation metadata and event log. Stale heartbeat shows uncertainty. Run status vocabulary matches the API: queued, running, cancelling, succeeded, failed, cancelled, interrupted. The completed string is a phase, not a run status. Cancel requests wait for worker state; restore cancellation asks for explicit confirmation and explains that partial data and a blocked target are possible after writes begin.

Restore opens a protected native dialog: artifact context → choose matching-engine restore-only connection → server preflight → source/target review + warnings → explicit acknowledgement → start using intent and one stable idempotency key generated when that intent is prepared. An ambiguous network/server error preserves the review and key; retry recovers the same request result. Changing the destination is disabled while that result is unknown. The target identity is not user-supplied free SQL. Interrupted and blocked target states stay visible. Native dialog provides focus containment, escape handling and focus return. Mobile navigation and content tables retain native scroll behavior. Reduced-motion preference disables authored transitions.

One visible Sun/Moon icon switches between light and dark on each viewport. The preference is shared by authentication and workspace screens through `steelkeep-theme`, with legacy authentication preference read as a fallback. There is no system-theme option. Use the supplied original PNG mark and lockups; never redraw the owner's database artwork or typeset a replacement wordmark.

## Reference use and licensing

Databasement MIT reference informed dashboard composition, summary hierarchy, activity/status panels, source-storage-schedule grouping, snapshot context and job-log flow. This is TypeScript/React implementation, not copied Blade component code. Root repository attribution documents reference reuse.

Salt.md theme source was read as the second reference, for consistent active/hover/focus vocabulary and panel semantics. No Salt AGPL source copied. Its paper/green palette and decorative effects do not override the requested Databasement direction.

## Validation boundary

Historical auth, responsive layout, operational collections and forms have browser evidence recorded in docs/authentication.md and docs/acceptance.md; mocked rendering does not establish native backup/restore. The latest owner instruction stops all local application execution. Local dependencies and generated builds were removed; current source checks and browser rendering run only on the isolated A-server stand, reusing its dependency image. Current dashboard, shared appearance, connection history and comment-control evidence is tied to frozen server snapshots in docs/design-validation.md and docs/snapshot-notes.md; older screenshots do not qualify later changes.
