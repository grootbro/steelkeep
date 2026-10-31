# Snapshot retention

New and existing plans keep all snapshots by default. Migration 8 adds metadata only: it does not enable cleanup or delete stored objects. Open **Backup plans → Snapshot retention** (also available inside a connection profile) to preview a policy. Enabling cleanup requires a current preview and an explicit permanent-deletion acknowledgement.

Policies:

- **Keep everything:** cleanup stays disabled.
- **Days:** retain snapshots at or newer than the cutoff, calculated in the plan's timezone using calendar-day subtraction.
- **Recent, weekly and monthly (GFS):** retain the union of the latest N eligible snapshots, the newest snapshot in each of the latest N Monday-start weeks, and the newest snapshot in each of the latest N calendar months. “Recent” counts snapshots, not distinct days. Protected snapshots do not consume keep slots. These semantics follow Databasement's MIT retention action.

Locked snapshots, live unconsumed restore reviews, active restores and uncertain restore reservations are excluded. A validated successful restore no longer pins its source archive forever; its target reservation remains intact. Queued, deleting and uncertain cleanup reservations prevent new restore reviews and starts. Snapshot history remains as a tombstone after confirmed absence.

Saving policies requires both `configure` and `backup:delete`. Running cleanup, granting a snapshot lock and retrying a held cleanup require `backup:delete`. Existing stored browser/agent grants are not upgraded by migration; sign in again for new owner permissions or explicitly issue an appropriately scoped agent token. Legacy file-based grants cannot acquire deletion permission.

The worker evaluates enabled policies about every minute and queues at most 20 objects per evaluation. Evaluation refuses plans above 10,000 nondeleted snapshots instead of truncating the selection. Previews list at most 100 candidates and 100 protected objects, with separate full counts within that evaluation limit. Disable cleanup before changing its plan timezone.

Before deletion, the worker rechecks policy revision, restore protection, storage revision and exact publication ownership. It persists the observed ETag and optional S3 version ID before sending a conditional `DeleteObject` with `IfMatch`. It then verifies that the selected object or version is absent. Changed or unsupported objects stay held; there is no unconditional deletion fallback. Retries retain the same object identity and have a bounded attempt budget. An explicit held-job retry grants a new bounded budget while preserving its deletion reservation.

A selected version's deletion does not purge unrelated versions or delete markers. Versioned-provider behavior is not runtime-qualified. Current native storage evidence covers unversioned local RustFS with conditional delete support. A storage connection check alone does not establish deletion support.

REST and MCP use the same services. OpenAPI documents preview, policy update, manual cleanup, history, held-job retry and snapshot locks. MCP exposes the corresponding tools with destructive-operation annotations. Cleanup history and policy previews report their own outcomes; a saved policy or accepted queue request is not a successful deletion.

## Verification recorded on 31 October 2026

`tests/retention.integration.test.ts` passed 1 test / 68 assertions in a fresh dedicated metadata database and new nonce-named S3 bucket. It confirmed wrong-ETag refusal (412), three actual conditional object deletions with HEAD 404 and tombstones, four protected objects, changed-object refusal, restore-review lock ordering, validated-restore eligibility, explicit delegated permission enforcement, REST/MCP DTOs, bounded transient retries and metadata epoch fencing. It uses synthetic published objects; it does not claim a native database backup/restore or process-kill boundary test. Its dedicated database, bucket and temporary secrets were cleaned.

Frontend intercepted checks cover preview/acknowledgement, revision conflicts with draft preservation, ambiguous request bookmarks, lazy history, actual mounted collection/profile controls, cleanup-state restore guards and mobile layout. These checks do not establish native engine qualification.

The main local metadata was migrated to 8 after both application processes stopped with no active jobs or enabled schedules. A private 159,815-byte metadata backup was retained under `.steelkeep/metadata-pre-retention-20261031.dump`. The restarted API independently returned all 20 plans in keep-all/disabled state, all 28 artifacts active and zero cleanup jobs. No existing archive was removed.
