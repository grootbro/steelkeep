# MongoDB server runtime and native recovery evidence

Qualified on server A, 31 October 2026: **MongoDB 8.0.34 standalone**, MongoDB Database Tools **100.20.0**, Linux x64, current backend snapshot `ef8bae643ac1f87a2b19193db74ca9a91ddb112401872670905b23f7d7ad7cb8`. No application changes, Docker image build, image pull, global APT installation or Mac execution were needed.

## Client runtime

The existing pinned application image is `sha256:cf3d84df5261bc00b40e907f6ca431c1f589662f041755f18b15dbf986d69b6d`. Mount the **client-only** bundle read-only:

```text
/opt/steelkeep/native-mongodb/client:/opt/steelkeep-mongodb:ro
```

Prepend `/opt/steelkeep-mongodb/bin` to the existing runtime `PATH`; retain the other engine tool paths. `mongodump` and `mongorestore` wrappers set their own local library search path before executing their verified `libexec` binaries. This is necessary because the application's `toolEnv()` intentionally does not inherit ambient `LD_LIBRARY_PATH`. Credentials continue through the adapter's private 0600 configuration file, never tool argv. The client bundle is approximately 47.1 MB and contains no MongoDB server or fixture data.

The two clients both reported version `100.20.0`, git `7536fd7f3d67f5115de3eb2e271b327b7ce329b9`, inside this existing image. The actual native worker subsequently executed both tools with the application's sanitized environment.

## Authenticity and bounded provisioning

Only selected binaries were extracted from the official Noble/amd64 packages. No package installation scripts ran.

| Package | SHA-256 of authenticated package |
| --- | --- |
| `mongodb-database-tools_100.20.0_amd64.deb` | `ac3c856a55695615bdffe02bcfd8592108493a26a7a2bed5dd8709405f840d24` |
| `mongodb-org-server_8.0.34_amd64.deb`, isolated fixture only | `511c3ce30e32880f67e73dcda7ff8547cc196360ab73070cd96cbdad1bf4de84` |

The MongoDB Release signature was verified against key fingerprint `4B0752C1BCA238C0B4EE14DC41DE058A4E7DCA05`, also published by the [official Mongo image source](https://github.com/docker-library/mongo/blob/master/8.0/Dockerfile). The verified Release authenticated the SHA-256 of `Packages.gz`; that index authenticated each downloaded package. Missing GSS/Kerberos and curl libraries came from authenticated Ubuntu Noble/updates/security `InRelease` → package-index → package SHA-256 chains. The downloaded dependency closure was about 1.94 MB. Package archives were removed after verification/extraction; signed metadata and per-file provenance remain under `/opt/steelkeep/native-mongodb/provenance`.

See MongoDB's [Ubuntu installation source](https://www.mongodb.com/docs/v8.0/tutorial/install-mongodb-on-ubuntu/), [package verification guidance](https://www.mongodb.com/docs/v8.0/tutorial/verify-mongodb-packages/) and [Database Tools installation documentation](https://www.mongodb.com/docs/database-tools/installation/).

The fixture reused the existing application image with an extracted server binary, 1 CPU/512 MiB, an independently checked internal subnet, no host ports and its own labelled data volume. A 256 MiB WiredTiger cache and smaller journal files with preallocation disabled kept the temporary footprint bounded. No existing MongoDB container, database or production fsync lock was used.

## Actual recovery

The isolated API and genuine durable worker used fresh metadata, private credentials and a new nonce S3 bucket. The official MCP client submitted the backup and reviewed restore, including stable request-key replay checks. The target was precreated with an empty `__steelkeep_empty_target` marker and a restricted database-only role.

| Evidence | Value |
| --- | --- |
| Backup run | `8ce80f8e-e157-4fdd-844d-3d4839a9d50d` |
| Restore run | `3129638a-4fac-4880-b8b8-9bb9d39e4eab` |
| Published artifact | `ec9d4e31-9604-4298-93c8-7f2ccacc1d68` |
| Actual downloaded archive | 797 bytes |
| Independent SHA-256 | `89f8c476e49a23effafc24c6e9bbf7eab0ba4167d2a3c7566d1b58a55674bf5b` |
| Preserved metadata DB | `steelkeep_mongodb_runtime_test` |

Both native jobs succeeded. Restore validation independently recorded schema, data and sequence checks as passed and the downloaded archive as SHA-256 matched. A separate read-only verifier checked the same original jobs/target against the fixed synthetic BSON fixture: signed Int64 values beyond JavaScript's safe integer range, Decimal128, Binary, Timestamp, Date, nested values, compound index order, unique index, collection validator and the retained empty sentinel. Source contents remained unchanged, fsync was released, source journals were empty and the successful target reservation remained. No owner account was created.

The first harness stopped after successful native recovery because `countDocuments()` returned BSON `Int32(1)` under `promoteValues:false`, failing a strict numeric assertion. Only that harness assertion was normalized. Verification resumed **read-only against the exact original IDs**, with zero additional native backup/restore runs and no target reset. This split execution is preserved in the evidence rather than reported as an uninterrupted first-run pass.

Private evidence: `/opt/steelkeep-mongodb-native-proof-20261031/private/native-result.json`, `readonly-result.json`, `durable-state-readonly.jsonl`, worker logs and cleanup receipt. Original native harness snapshot: `f1376cbe8843c0c9031f2acc0ad51989fe871b02a260ece34698ef720332b4bd`; read-only completion snapshot: `37b320634d91518f78d9f663b8f1f34fe3a5a873ad6439b43ebe10a94f0f0f09`. Backend files match the qualified `ef8bae…` source in both.

After verification, the fixture container was stopped/removed and its disposable 223 MB server binary removed after SHA/inode/link/use guards. Client binaries, signed provenance, original MongoDB data/restored target, metadata, archive, logs and target hold were retained. No fixture data volume was removed.

This qualifies the implemented MongoDB **8.0 standalone single-database** profile. Replica sets, sharded clusters, encrypted BSON and DBRef rebinding remain explicitly refused by the adapter; this proof does not establish their recovery or production workload limits.
