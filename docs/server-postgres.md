# PostgreSQL server runtime and native recovery evidence

Qualified on server A, 31 October 2026: PostgreSQL server, `pg_dump` and `pg_restore` **17.11**, Linux x64, backend snapshot `ef8bae643ac1f87a2b19193db74ca9a91ddb112401872670905b23f7d7ad7cb8`. The existing application image and deployed native bundle were reused; no image build, package installation or Mac execution was needed.

## Runtime

The pinned application image is `sha256:cf3d84df5261bc00b40e907f6ca431c1f589662f041755f18b15dbf986d69b6d`. Mount the deployed client bundle read-only:

```text
/opt/steelkeep/native-postgres:/opt/steelkeep-pg17:ro
```

Prepend `/opt/steelkeep-pg17/wrappers` to the existing runtime `PATH`, retaining other engine paths. The wrappers provide the client's own library environment under the adapter's sanitized tool environment. Database credentials remain in the existing private credential-file path. This proof exercised the actual durable worker with this mount, rather than only checking tool version output.

## Actual current-runtime recovery

The isolated CORE API/worker and its `steelkeep_runtime_core` metadata database were guarded by the existing installation nonce. Two new databases and two dedicated restricted roles were created on the PostgreSQL cluster, with fresh-name absence and database-OID checks. The source reader had SELECT privileges; the target owner had no superuser, create-database, create-role, replication, bypass-RLS or inherited-role privileges. No live application metadata database or owner account was accessed.

The official MCP client created source/target profiles and a manual plan, submitted a backup, downloaded the published object directly from the private S3 fixture, prepared the restore and accepted the reviewed restore. Repeating each command's original request key returned its original run. Both native jobs completed in one attempt.

| Evidence | Value |
| --- | --- |
| Backup run | `1e039ffe-c2e2-4edd-8d96-c48f449220aa` |
| Restore run | `9342953a-5e12-4f55-a836-8788676156a6` |
| Published artifact | `299b9bb3-e1b2-45b7-932a-c6a464a4b4b4` |
| Actual downloaded archive | 5,167 bytes |
| Independent SHA-256 | `3e1e2662f63472c31eece400e4fe4d54b4376e2e9d33b9067ae15d014cc4ab9f` |
| Synthetic source | `steelkeep_core_pg_source_1339db716c2d` |
| Restored target | `steelkeep_core_pg_target_1339db716c2d` |

Restore validation recorded data, schema and sequence checks as passed, with SHA-256 matched archive integrity. Separate read-only SQL connections compared the fixed source baseline, restored target and source after recovery: ten entry rows, two project rows, multilingual text, binary values, exact decimals and microsecond timestamps, identity columns and sequence state, foreign keys, check/unique constraints and index definitions. All comparisons passed, the source remained unchanged and the successful target reservation remained. Original database OIDs were unchanged.

The initial harness stopped **before any MCP configuration or native job** because `ORDER BY id` selected the textual output alias and sorted `1,10,2…9`, invalidating its fixed binary-baseline assertion. The harness was corrected to order by the qualified numeric column. Its guarded `prequeue` continuation required the exact retained nonce, OIDs, private state, empty target and absence of any admitted command IDs; it skipped all bootstrap DDL/DCL and seeding. The successful continuation therefore performed the first and only native backup/restore, with no database reset or restore replay.

Private evidence is preserved under `/opt/steelkeep-runtime-postgres-proof-20261031/private`: `result.json`, `prequeue-resume-runner.json`, original attempt/diagnosis files and sanitized runner logs. The passing harness SHA-256 was `80de7d5e244cce2c410bae050eb74fdecde8982f221aba117073c1a92c4de1c8`; the runner exited 0 without OOM in 2.8 seconds. Own runner containers were removed; synthetic databases, roles, archive, metadata and target hold were retained. CORE services were not stopped or restarted by the proof.

This qualifies the implemented PostgreSQL 17 single-database profile on this small synthetic fixture. It does not establish recovery of other PostgreSQL majors, arbitrary extensions, cluster-wide roles or production workload limits.
