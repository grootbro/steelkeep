# Synthetic ClickHouse fixture

Recorded execution on 31 October 2026: ClickHouse25.8.12 native MCP recovery passed
**1 test / 20 assertions** after the owner-approved Docker restart. The isolated overlay,
server, shared spool and native backup/restore pipeline were actually used. Independent
checks cover the data/types and ordered Native-format comparison described below.
Existing volumes, targets and history were preserved. This is ordinary profile recovery
evidence; cancellation/crash/restart uncertainty and clean packaged delivery remain open.

For a separate authorized repeat, use the base `compose.yaml` together with
`compose.clickhouse-fixture.yaml`. Set `STEELKEEP_UID` and `STEELKEEP_GID` to the
current non-root host UID/GID consistently for provisioning and Compose. Set
`STEELKEEP_ACCEPTANCE=synthetic-local-clickhouse`, then explicitly invoke
`bun infra/clickhouse-fixture/prepare-directories.ts` before Compose. It only
creates/validates `.steelkeep/extra-fixtures/clickhouse/backups` and sets its mode
to 2770; existing unsafe ownership, permissions and symlinks fail closed.
`.steelkeep/` is already gitignored. API, worker and server mount this directory
at the exact same `/steelkeep-clickhouse-backups` path. The official entrypoint
uses `CLICKHOUSE_UID/GID` to drop to the application's identical UID/GID; this
also preserves the worker's private 0700 operation journal directory. No root
worker, world-writable spool or fictional image environment variable is needed.
The containing spool's group is for this isolated fixture only.

Fresh named ClickHouse data volume initialization creates plain Atomic source
and target databases, a local MergeTree table, direct source BACKUP/read grants
and minimal direct target INSERT/CREATE TABLE/read grants. Target cannot CREATE
DATABASE, DROP, ALTER or grant privileges. Only the synthetic fixture owner can
provision destinations or change source data; it is never registered in the
application. Keep all source writers quiescent through capture. This fixture
does not prove an atomic snapshot across tables. The built-in default user is
restricted to server loopback for bootstrap. Synthetic owner credentials are
published only on host loopback HTTP port 54378; do not expose or reuse them.

After the normal metadata/application/S3 fixture setup, explicitly invoke
`bun scripts/seed-clickhouse-fixture.ts`. It registers only typed connections,
an isolated bucket and an unscheduled plan. Re-seeding an existing name fails
instead of trusting an unrelated profile. It does not create ClickHouse tables
or bypass their restricted application roles.

`STEELKEEP_ACCEPTANCE=synthetic-local-clickhouse bun test acceptance/clickhouse-recovery.test.ts`
uses the official MCP client for backup, polling, prepare/start and idempotency.
It provisions a fresh empty target through the isolated fixture owner, then
checks exact rows, Unicode, array/null values, 64-bit integer precision, decimal
scale, timestamps and column types through independent JSON HTTP queries.
It also compares deterministic ordered Native-format streams, for example
`SELECT * FROM fixture_ch_source.entries ORDER BY id FORMAT Native`, against
the restored target. It checks source-target refusal and subsequent nonempty
target refusal. It does not drop targets or clear journals on failure.

Native-operation cancellation/crash/restart uncertainty and UI-driven recovery
still need separate acceptance. A missing `system.backups` record after server
restart is unknown, never permission to resubmit. Do not delete the spool or
named data volume to conceal an uncertain result.

Primary sources used for authoring: [official entrypoint at the pinned LTS tag](https://github.com/ClickHouse/ClickHouse/blob/v25.8.12.129-lts/docker/server/entrypoint.sh),
[local-disk backup configuration](https://clickhouse.com/docs/operations/backup),
[GRANT syntax](https://clickhouse.com/docs/sql-reference/statements/grant),
and [Native format](https://clickhouse.com/docs/interfaces/formats/Native).
