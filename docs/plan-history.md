# Complete plan browsing

`GET /api/v1/history/plans` and MCP `browse_plans` provide cursor pages of all saved plan metadata under the existing `read` scope. They do not contact databases or storage. The existing `/plans` and `list_plans` array contracts remain available.

Filters: `id`, `sourceId`, `storageId`, database `kind`, `status` (`enabled`/`paused`), `schedule` (`scheduled`/`manual`), `retentionMode` (`keep_all`/`days`/`gfs`) and literal name `search` across plan/source/storage names. `limit` is 1–100, default 30. Orders are `newest`, `oldest`, `name_asc`, `name_desc` and ascending `next_due` with null timestamps last. UUIDs break ordering ties; cursors preserve PostgreSQL microseconds.

The response extends each existing plan DTO with source/storage names and source engine. `total` counts all matches before the cursor. `summary` explicitly covers all recorded plans, independent of filters: total, enabled, paused, scheduled and manual. Both counts and the page use one repeatable-read metadata snapshot. Upcoming occurrences reuse the existing timezone/DST scheduling helper.

Cursors are signed, domain-separated and bound to normalized filters, order and page size. Changing those inputs requires returning to the first page. Invalid cursors return `INVALID_PLAN_CURSOR`; unsupported filters return `INVALID_PLAN_FILTER`. No credentials, native execution token or connection secret is selected.

The current synthetic PostgreSQL proof passed 184 assertions with 137 plans, all five orders including ties/null due dates, global versus filtered counts, search/filter binding, strict legacy-endpoint-before-page response validation and scoped REST/MCP reads. It did not queue backup jobs or contact native engines. The final checkpoint summary records its frozen source and adjacent checks.
