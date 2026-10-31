# Snapshot notes

Schema migration 10 adds a plain-text note, revision and update timestamp to artifact metadata. It does not alter backup files or enable cleanup. Notes remain available on deleted artifact tombstones.

The Snapshots, connection-profile and full-history lists show a note icon when the server advertises `snapshot_comments` and returns the note fields. Read-only sessions can inspect a note; `configure` permission is required to change it. The editor accepts up to 2,000 characters, trims surrounding whitespace and clears the note when the result is empty. Text renders as text, including angle brackets. Notes should contain operational context rather than credentials.

`GET /api/v1/backups/:id/comment` returns `id`, `comment`, `comment_revision` and `commented_at`. `PATCH` accepts exactly `{revision, comment}`, where `comment` is a string or null. The native MCP tools `get_backup_comment` and `update_backup_comment` use the same service and permissions. Artifact list, overview, direct lookup and history DTOs carry the same note fields.

Saving uses an atomic revision comparison. A competing edit returns `409 REVISION_CONFLICT`; the editor preserves the draft and requires loading the latest saved note before explicitly choosing its revision. An unknown save result also requires a reload. A no-op at the current revision does not increment the revision or add an audit event. Actual changes record the actor, action, artifact ID and time; the audit event excludes the note body.

The service updates only note metadata. It cannot clear source/target holds, release retention locks, undelete an object or create a restore job.

## Verification

The final combined source snapshot `4faa176ee9343e4d0ad5d7b106b5dff5a412b37572061e2e6cd056e8e5e89d29` passed both TypeScript configurations and the 78-test / 612-assertion default suite on the isolated A-server stand. Its synthetic PostgreSQL notes test passed 51 assertions with 103 artifact records, including competing revisions, no-op semantics, tombstone notes, unchanged recovery holds, audit-body exclusion and actual REST/MCP/history responses. The fixture database was dropped after guarded cleanup; the stand's metadata service was stopped and its control volume retained.

The first integration run found a real response-schema error after a direct artifact endpoint compiled its strict base schema. Flattening extended history DTOs fixed the REST 500 without weakening response validation; endpoint-order regression assertions now cover artifact and job histories and the connection browser.

Browser captures use synthetic read fixtures and deny mutations; they do not prove an actual note save through the browser or native backup/recovery. These checks made no native-engine, S3 or external-provider calls. The separate in-progress MSSQL helper was excluded from this snapshot.
