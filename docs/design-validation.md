# Databasement visual checkpoint · 31 October 2026

The dashboard now follows the inspected MIT reference's summary strip, compact activity plot, latest-job rows, status grid and storage-distribution hierarchy. Steelkeep retains the owner's original PNG mark/lockups, Inter and Milk/Graphite/Blue Violet branding. Shared application surfaces carry the same hierarchy into Connections, Plans, Snapshots, Jobs and Configuration. This checkpoint does not declare every reference feature implemented.

One Sun/Moon icon switches appearance; the explicit light/dark choice is shared by authentication and workspace screens and survives reload. At mobile widths the visible control lives in the top bar, including when navigation is open. Authentication uses a compact centered form; the original artwork and wordmark stay on one line. All 18 captured authentication combinations fit their viewport without unwanted vertical scroll.

## Server-only evidence

Application execution took place on the isolated A-server stand. Mac Docker and the local application remained stopped. The reusable browser image was provisioned once; ordinary UI corrections reused it without rebuilding images or reinstalling dependencies. Browser containers had no network, published ports or real credentials. Every API response used synthetic fixtures, and mutations were denied.

- Baseline source `747fa278493737f72fc9a91971a83894b68e5266a1345b4b56e4f208a1a904fd`: 120 cases, covering 1440×1000, 1366×768 and 390×844 in both themes; populated, empty and long content; forms, job details, notes, retention and owner claim/setup/sign-in. No missing images/fonts, asset errors, unknown API requests or document horizontal overflow. Raw page-error logs include a harness initialization exception on `about:blank`; it was isolated and corrected before the final pass.
- Final source `4faa176ee9343e4d0ad5d7b106b5dff5a412b37572061e2e6cd056e8e5e89d29`: 18 affected captures after account-footer, endpoint/action-row and dashboard-subtitle polish. No page errors, theme mismatches, missing images/fonts, asset HTTP errors or document horizontal overflow. The account identity has its own full-width row; utility icons no longer squeeze it. Desktop connection endpoints do not split their port digits; actions align on one row and retain accessible labels/tooltips.
- Theme checks confirmed preference persistence after reload and exactly one visible appearance button at each viewport, including mobile navigation open.
- Both TypeScript configurations, 78 default tests / 612 assertions, and the two synthetic PostgreSQL integration proofs passed on the final snapshot. These tests qualify their specific logic and metadata contracts; they do not qualify native engine recovery.

Selected PNGs and provenance are under `output/playwright/server-design-20261031/`. Root visually inspected current light/dark desktop dashboards, the corrected desktop connection table, mobile dashboard/connections and compact auth screens. Browser rendering and intercepted actions cannot establish an actual backup, restore, notification delivery or note save through the browser. MSSQL helper changes were excluded from these frozen snapshots and remain separately qualified.

## Remaining operational screens

The next source slice adds what/where/when plan summaries, Configuration section tabs that preserve drafts, shared recent/full-history snapshot and operation tables, native scoped Download links and a log-first job inspection view with metadata disclosure. The reference file additions are attributed in THIRD-PARTY-NOTICES.md.

Snapshot `2690d89ca7f91d82b5fe900c9d203a9c985aa2301e37b675405df85f49c7d0a1` passed 44 targeted cases: 16 desktop/mobile base captures in both themes plus tab keyboard/draft preservation, history dates/advanced filters/cursor recovery, job states/validation/long logs and Download capability/scope/state gates. All 55 frontend source files match backend-corrected snapshot `e9bda888…`. A two-CSS-file mobile correction, snapshot `a38d5f3929a5545a7fd37fb36cdebed4be7c685a3f7645755e074c66840066e4`, passed two affected captures with populated agent/audit and profile-job rows: all tables fit their 362px containers.

Across 46 cases: no page/asset errors, missing images/fonts, document horizontal overflow, unknown API reads or API writes. The visual mock denied actual archive GETs; real archive transfer is separately qualified in docs/snapshot-downloads.md. Root inspected Plans, Snapshots, Configuration, interrupted JobInspection and the corrected mobile agent/audit/profile screens. Selected PNGs and provenance are in `output/playwright/server-operations-20261031/` (1.8 MiB). Browser containers were removed; no local application execution occurred.
