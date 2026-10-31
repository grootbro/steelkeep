# Reviewed snapshot deletion

Snapshots and connection profiles offer explicit deletion under `backup:delete`, separate from enabling a plan's retention policy. The Snapshots page can select up to 100 active, unlocked records on its current page. Both individual and bulk actions first fetch an actor-bound ten-minute review with exact source/storage names, creation times, sizes and protection reasons. Nothing is queued until the user acknowledges permanent deletion. Any protected or changed item refuses the entire batch.

REST:

- `POST /api/v1/backups/deletion-review` with `{artifactIds}`.
- `GET /api/v1/backups/deletion-reviews/:id` to inspect a review and its accepted receipt without submitting work.
- `POST /api/v1/backups/deletion-requests` with `{reviewId,idempotencyKey,confirmDeletion:true}` to admit the exact reviewed batch.

Native MCP tools `prepare_backup_deletion`, `get_backup_deletion_review` and `delete_backups` call the same services. Review and queue operations require `backup:delete`; archive contents and storage credentials are never included. Reviews bind publication metadata, connection revisions, protection state and actor. Expiry is checked again after acquiring locks. A successful previous request key returns its original receipt even after review expiry; a consumed review cannot accept another key.

The UI saves only the review ID, request key and acknowledgement in actor-separated session storage before sending the command. Dialog close/reload never submits work. An unknown response or ordinary router `404 NOT_FOUND` preserves that key; checking a receipt always GETs the original review. Only explicit post-lookup service refusals, including `DELETION_REVIEW_NOT_FOUND`, resolve a missing command. Recovery resubmits the identical previously confirmed request on explicit action. Session-storage errors prevent a new submission.

Schema 11 adds deletion reviews and distinguishes policy versus manual cleanup jobs. Existing policy jobs keep their defaults, retry budgets and receipt JSON. Manual jobs reuse the durable conditional-delete/tombstone path, support archives without a plan and never enable or change keep-all retention. Consistent UUID artifact lock ordering prevents a manual batch from deadlocking with policy admission/update/recovery.

The worker rechecks immutable ownership, revisions, locks, restore reviews/active runs/uncertain targets and source/target safety holds. It verifies the exact S3 object metadata/ETag and performs conditional deletion. These checks are not downloaded-byte SHA verification. Manual jobs have one attempt, including AWS SDK `maxAttempts:1`; a failed/ambiguous operation or interrupted worker stays held with its reservation. Policy retry cannot replay a manual job. A new review cannot clear that reservation. Inspection/reconciliation of held outcomes remains an operator responsibility; the UI does not offer a bypass.

Archive records and notes remain as tombstones. The global collapsible Cleanup history on Snapshots/profile pages includes unplanned manual jobs alongside retention jobs, with explicit kind and no manual Retry control. Accepted receipts link directly to that outcome view; it opens and scrolls to the requested hash. History explicitly shows the latest 100 jobs, so older cleanup-outcome pagination remains additional work.

## Evidence

Server snapshot `681c9eaa4d91a351a6d63d534d566fa903a3c40c07f56f34d6fb1c9ba6935aff` passed both TypeScript configurations and 90 default tests / 755 assertions. The actor-corrected test-only overlay `045524e3f2554d84c52a605fa46068cbbb12ca01a87e93f0f4573aa413d68340` passed 106 guarded PostgreSQL/S3 assertions: four actual manual conditional deletes plus one existing policy delete, unplanned archive support, unchanged keep-all settings, scoped REST/MCP, expiry and two-session lock barriers, changed/replaced object holds, one HTTP DELETE on ambiguous 503 and worker-restart quarantine. Original failed fixture logs remain recorded; no existing object or native database backup was touched.

Twenty-six synthetic browser scenarios passed on `681c9eaa…`, including acknowledgement/protection/scope gates, exact saved-key recovery, router404 preservation and plan paging. The UI-only outcome-history overlay `ef8bae643ac151d9181aabc59a3ae8e01e7b3e00d76a223bae5d52b0a19dca03cbe5` passed an application TypeScript check and two affected browser cases: receipt-to-history navigation with queued-to-succeeded refresh and direct-hash/reload for unplanned held outcomes. Browser mocks did not delete real objects. Selected PNGs/provenance are under `output/playwright/server-manual-deletion-20261031/`.

All execution used limited isolated server containers. Dedicated test databases and fresh buckets were absent after guarded cleanup, own PostgreSQL/RustFS/browser/checker services stopped, named volumes and evidence retained. No local application execution, image builds or dependency installations occurred.

The final hash-navigation correction is snapshot `ef8bae643ac1f87a2b19193db74ca9a91ddb112401872670905b23f7d7ad7cb8`: TSC passed; actual mobile direct-hash/reload lands at89px after history data is ready. Two targeted browser cases passed with no helper scroll.
