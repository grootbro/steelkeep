# Full history

Jobs and Snapshots offer **Recent activity** and **Full history**. Recent activity retains the lightweight live operational view. Full history pages through stored records, including records older than the latest 100. Filters include database, storage, date range and creation order, plus operation/status for jobs or engine, availability and cleanup state for snapshots. Date inputs include the full local calendar day across daylight-saving transitions.

`GET /api/v1/history/jobs` and `/api/v1/history/snapshots` accept bounded pages of up to 100 records; the UI uses 30. `GET /api/v1/backups/:id` retrieves an older snapshot directly, with its tombstone and latest restore validation. Corresponding read-scoped MCP tools are `browse_job_history`, `browse_snapshot_history` and `get_backup`. Existing list endpoints keep their original array shapes.

Cursor ordering uses the exact database creation timestamp and UUID, preserving all six timestamp fractional digits. Cursors are HMAC-bound to resource type, filters, ordering and page size; changed filters start from the first page. The API does not claim a cross-request database snapshot: mutable statuses can enter or leave a filter as work finishes. Newly inserted records before the current cursor do not shift an offset or duplicate the next page. Changing the installation encryption key invalidates existing history cursors.

Older snapshots use the same availability, lock and restore guards. Opening restore fetches that snapshot's current state independently of the overview window; cleanup-reserved or deleted objects cannot start a new review. Availability metadata and the latest restore validation remain distinct. Previous storage secrets, native execution tokens and review fingerprints never enter history DTOs.

## Verification · 31 October 2026

`tests/history.integration.test.ts` passed 1 test / 166 assertions against a new dedicated PostgreSQL database. It paged 107 records in both directions, checked microsecond timestamp ties, insertion between requests, literal wildcard search, date/source filters and old-artifact validation. It then exercised real Elysia routes and official MCP read tools with a scoped agent, cursor/filter refusal and authentication. The isolated database and temporary keys were removed. Five pure tests cover cursor tampering/filter binding and full local DST-short/long days. The intercepted actual-workspace UI test passed 1 / 8 assertions, including pagination, filter reset, mobile overflow and a held older snapshot refusing restore.

The integrated local API independently returned paginated jobs/snapshots and a direct snapshot lookup after migration 9. Supporting creation/UUID indexes were added in that migration. Broader production-scale query planning and all provider/engine execution combinations remain separate qualifications.
