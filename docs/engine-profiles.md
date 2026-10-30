# Engine profiles and provisioning

Current source scope is PostgreSQL, MySQL, MariaDB, MongoDB, SQLite, Redis,
ClickHouse and SQL Server, plus S3-compatible artifact storage. All eight profiles
have explicit acceptance gates. Local review is now authorized: PostgreSQL 17 and
MariaDB 11 passed MCP and UI recovery; MongoDB 8.0.34, Redis 7.4.12 and SQLite passed
MCP recovery. MySQL 8, ClickHouse and SQL Server remain pending. A form option or
ordinary recovery pass does not establish arbitrary-schema or production support.
See the [acceptance ledger](acceptance.md) for remaining adverse-case and packaging gates.

The shared machine-readable profile catalog is `shared/engines.ts`, returned by
REST and MCP. Native commands run only in the worker; connection tests and restore
reviews inspect destinations through database drivers. One operation runs at a
time per installation. Only installation-created trusted archives can be restored.
Archive budget: 2 GiB. Manifest budget: 2 MiB. Profile-specific limits can be lower.

| Engine | Implemented profile | Worker and destination requirements |
| --- | --- | --- |
| PostgreSQL | Server/client 17; custom logical archive; schema, row digests and sequence validation | PostgreSQL 17 client tools. Source read role; separate precreated empty target owned by a dedicated nonsuperuser role. No source overwrite. MVCC snapshot aligns data; changing non-MVCC sequence values refuse publication. |
| MySQL | Server/client 8; ordinary InnoDB tables, indexes, constraints and auto-increment | Real MySQL 8 clients, not MariaDB's compatibility alias. Explicit global read-lock permission and RELOAD, plus database-wide visibility permissions. Views, routines, triggers, events and cross-database references are rejected. |
| MariaDB | Server/client 11; same strict application-table profile | Matching MariaDB clients; source RELOAD plus SELECT, SHOW VIEW, TRIGGER, EVENT, EXECUTE visibility; target privileges confined to the target DB. Explicit server-wide write-blocking opt-in. |
| MongoDB | 8.0 standalone; Database Tools 100.20; native compressed archive | MongoDB tools installed in worker. Explicit fsync lock permission; database read/list privileges plus cluster fsync, unlock and inprog. No replica set, shard, encrypted BSON or DBRef rebinding profile. Owner creates the exact empty `__steelkeep_empty_target` collection in a separate target. Dedicated target role has find, insert, createCollection, createIndex, listCollections and listIndexes; no drop/update/admin privileges. |
| SQLite | Existing worker-local file; native Online Backup; schema, raw row and sequence checks | `sqlite3` CLI. Explicit separate canonical source/target roots, regular initialized SQLite files and one hard link only. Target is an existing empty initialized database, not a zero-byte placeholder. No virtual tables/extensions. Limits: 500 tables, 512 columns/table, 8 MiB/row. Integrity and FK checks are separate. |
| Redis | Standalone primary 7 or 8; one bounded logical DB; native DUMP payloads and absolute TTL | No external CLI. Atomic read-only script intentionally blocks other commands for the capture interval, requiring explicit opt-in. At most 5,000 keys, 64 MiB serialized data, 1 KiB/key. No cluster/modules. Source and target major versions must match. Separate empty DB index; RESTORE never uses REPLACE and no FLUSH is issued. |
| ClickHouse | 25.8 LTS single-node Atomic DB; ordinary MergeTree tables; native zip | Configured backup disk shared at the same canonical path with worker and the relevant server. An explicitly idle source window; no database-wide transactional consistency claim under writes. No distributed/replicated tables, TTL, dictionaries, views or in-flight mutations. ASYNC operation IDs and private native journals survive HTTP loss. |
| SQL Server | 2019/2022 read-only source; BACPAC logical portability | Optional explicitly provisioned .NET 10 Linux x64 DacFx helper. Separate precreated empty target and a dedicated login with db_owner only on that target, no privileged server permissions. Ordinary independently validated table types only; unsupported modules, computed/encrypted/temporal/CDC/external tables and user types are refused. BACPAC is not a native .bak, log-chain or PITR profile. |

Compose selects `Dockerfile.engines`, a source recipe provisioning PostgreSQL,
MySQL, MariaDB, MongoDB and SQLite tooling on Ubuntu; Redis and ClickHouse use their
existing protocol adapters. `Dockerfile.worker` remains a smaller PG/MariaDB/SQLite
development option. The optional SQL Server extension still needs explicit
provisioning. The ARM64 Ubuntu image built and runs the development API/worker;
clean immutable self-hosted delivery and amd64 acceptance remain pending. See
[native tooling](native-tooling.md) for package provenance and remaining checks.

## SQL Server optional helper

Source: `tools/Steelkeep.DacFx`. Its project pins Microsoft.SqlServer.DacFx 170.5.96.
The owning operator must provision a supported Linux x64 .NET 10 environment and
review the actual Microsoft package terms. Nothing was downloaded, licensed,
compiled or executed as part of authoring this helper. The application's MIT
license does not relicense Microsoft binaries.

During the later authorized build phase, publish the helper to a protected worker
directory and set `STEELKEEP_DACFX_HELPER` to its absolute `Steelkeep.DacFx.dll` path.
Only the worker requires it. The web/API uses the JavaScript SQL Server driver for
read-only connection/target inspection. Helper requests are bounded JSON through a
0600 stdin file in a private temporary directory. Passwords never appear in argv;
native diagnostic output is discarded. Export uses a database the owner has made
read-only; Steelkeep does not change source database mode. Import checks role and
emptiness immediately before DacFx. Cancellation is not proof of import rollback;
unknown outcomes leave the target reserved. Allow additional scratch space for
BACPAC table-data buffering, beyond the resulting compressed archive.

Primary contracts: [DacServices export](https://learn.microsoft.com/en-us/dotnet/api/microsoft.sqlserver.dac.dacservices.exportbacpac?view=sql-dacfx-162),
[DacServices import and cancellation](https://learn.microsoft.com/en-us/dotnet/api/microsoft.sqlserver.dac.dacservices.importbacpac?view=sql-dacfx-162),
[BACPAC source consistency](https://learn.microsoft.com/en-us/sql/tools/sqlpackage/sqlpackage-export?view=sql-server-ver17),
[existing empty target](https://learn.microsoft.com/en-us/sql/tools/sqlpackage/sqlpackage-import?view=sql-server-ver17),
[actual package license](https://www.nuget.org/packages/Microsoft.SqlServer.DacFx/170.5.96/License).
The API documentation currently describes an earlier assembly generation; source
compatibility with the pinned package must still be compiled and exercised.

## Source-lock reconciliation

MongoDB fsync locks can outlive SIGKILL or lost network acknowledgement. Before
acquisition, Steelkeep records resource, server process identity, run, execution
token and lock owner token in `source_blocks`. Both endpoint and server process
identity exclude duplicate acquisitions through aliases. Normal acknowledged
release clears only the matching journal. Unknown acquire/release leaves a block.
Restart never deletes it, and cancellation never blindly runs unlock in a loop.

An operator must inspect the actual server's identity and lock state, other lock
owners and the interrupted job before reconciling a block. A self-service automated
unlock/clear flow has not been implemented. Do not delete journals or run fsyncUnlock
just to make a retry pass: an existing lock can belong to another operation.

Redis capture ACLs need INFO, CLIENT INFO, SELECT, TIME, EVAL_RO, DBSIZE, SCAN, TYPE,
MEMORY USAGE, DUMP and PEXPIRETIME. The target additionally needs RESTORE. A payload
whose absolute TTL has expired by validation time is intentionally absent; permanent
keys and all still-live TTLs are compared exactly by the adapter's strategy.

ClickHouse native operation journals remain in its protected shared spool on an
unknown outcome. Aborting an HTTP request is not native cancellation. Reconcile the
recorded backup ID in `system.backups` or its configured durable history. A server
restart can erase an in-memory result, which remains unknown rather than successful.

## Acceptance still required

Run each profile with isolated synthetic fixtures through REST and MCP, then the
UI. Verify schema, exact data, native types, sequence/identity behavior and time
semantics independently of Steelkeep's own manifest. Include worker death, network
loss after submit, duplicate request keys, source/target aliases, restricted-role
failures and missing tooling. A tool exit code, S3 HEAD or schema checksum alone
does not establish recovered application data.
