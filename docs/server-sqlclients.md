# Private MySQL, MariaDB and SQLite runtime extension

The server deployment uses the existing Ubuntu Noble amd64 runtime image `cf3d84df5261bc00b40e907f6ca431c1f589662f041755f18b15dbf986d69b6d`. Required native clients were privately extracted from authenticated official packages; the host package database, global client commands and live compose were not modified by this provisioner. No new image was built or pulled.

| Command family | Authenticated package version | Private vendor prefix |
|---|---|---|
| `mysql`, `mysqldump` | Ubuntu `mysql-client-core-8.0=8.0.46-0ubuntu0.24.04.4` | `mysql8/` |
| `mariadb`, `mariadb-dump` | MariaDB `1:11.4.13+maria~ubu2404` | `mariadb11/` |
| `sqlite3`, matching `libsqlite3-0` | Ubuntu `3.45.1-1ubuntu2.8` | `sqlite/` |

The host prefix is `/opt/steelkeep/native-sqlclients`. Mount it read-only at `/opt/steelkeep-sqlclients` and prepend `/opt/steelkeep-sqlclients/bin` to the existing worker `PATH`. Preserve other engine prefixes already present in `PATH`.

Wrappers resolve their own prefix and invoke the original vendor ELF with an explicit private loader library path. They work with `toolEnv()`'s sanitized environment without inherited `LD_LIBRARY_PATH`. MySQL commands execute actual MySQL8 binaries; MariaDB commands execute actual MariaDB11 binaries. No cross-vendor aliases are used. Original package copyright files remain in the extracted client prefixes.

## Authentication and bounded provisioning

`scripts/server-runtime-sqlclients.py` owns only the marked private prefix. It obtains Ubuntu's archive keyring and installed-package inventory from the exact existing runtime image, rather than using the host's different Ubuntu release. Ubuntu2018 archive fingerprint `F6ECB3762474EDA9D21B7022871920D1991BC93C` is checked. The MariaDB2025 official keyring must match pinned SHA-256 `403e0403df51273fbf5613e5644959d3f85923ef7d8f92e7d83eafe289093af4`, matching `Dockerfile.engines`.

APT state/config/cache and GPG home are private. Ubuntu Noble main/updates/security and the official MariaDB11.4 Noble repository supplied four independently verified signed `InRelease` files. APT rejects insecure/unsigned metadata; every downloaded archive is checked against signed-index package SHA-256 and size before `dpkg-deb --extract`. No package maintainer script or host package installation runs.

The provisioner, fixture launcher and proof harness run only on the Linux server. A minimum8GiB free disk reserve and8.25GiB pre-operation soft floor apply. Fixture packages reused the existing runtime and native daemons instead of full database images. The temporary private bundle stayed below the approved400MiB budget.

Typical server-only stages from a checked-out source tree are `metadata`, `plan`, `clients`, `wrappers`, `check`, then explicit `library --package …` for a missing authenticated library. `fixtures`, `fixture-start --engine mysql|mariadb`, `fixture-stop --engine …` and `cleanup-servers` are synthetic proof stages, not application startup actions. The exact captured package ledger and source hashes identify the actual completed run.

## Completed native and queued MCP recovery proof

Both engines passed a direct `NativeAdapter` capture/restore and a separate full queued workflow against isolated CORE nonce `14bafed8114d2c726a31e7040b155f28`, metadata database `steelkeep_runtime_core`, source snapshot `ef8bae643ac1f87a2b19193db74ca9a91ddb112401872670905b23f7d7ad7cb8`.

The existing image ran disposable MySQL8.0.46 and MariaDB11.4.13 daemons sequentially as UID10001,1CPU/1536MiB, read-only root filesystem, dropped capabilities, no-new-privileges, no host ports and256MiB tmpfs datadirs. Only the owned internal CORE network was attached. The fresh fixtures had independent source, direct restore and MCP restore databases and restricted database-specific restore users. No production database or live owner's credentials/data were used.

For each engine, `scripts/server-runtime-sqlclients.ts` verified the stand identity and absence of an owner before using CORE credentials. It exercised REST connection/plan creation, the official MCP client, durable backup/restore queue jobs, native dump/upload, independent S3 bytes/size/SHA verification, restore review/start, worker schema/data/sequence/integrity validation, and independent SQL row/auto-increment comparisons. Backup and restore idempotency-key replay returned the same jobs. A source auto-increment value51 above existing IDs was preserved. Unicode, binary/null and decimal data were checked; the MySQL fixture also covered uint64 and JSON. Original sources remained unchanged.

| Engine | Backup job | Restore job | Actual S3 archive | Result |
|---|---|---|---:|---|
| MySQL8.0.46 | `0261822c-2261-4e95-ad98-b703f06fe798` | `61d04298-65cf-443d-a32a-977204d35a0b` | 3705 bytes | Both succeeded; independent rows and all validation checks passed |
| MariaDB11.4.13 | `721e6aea-e9c5-4355-a306-f3476ddded29` | `b3b42550-0b40-4f9f-8067-e75d71cc3602` | 3166 bytes | Both succeeded; independent rows and all validation checks passed |

S3 archive SHA-256 values:

- MySQL: `338ed94ad91db5085177f1861077c399d7046aac242cfe54fef6c49ae0d55bcf`.
- MariaDB: `b6d5f68a2b001bcfa772aaa0dd11b22697d0fd2f586d39930fde48ac8a857f0e`.

The four jobs were independently requeried in durable metadata as `succeeded`. SQL fixture inputs, independently recovered row evidence, archive objects, metadata and terminal JSON remain retained. SQLite's client/library closure was verified here; its complete queued recovery workflow belongs to the separate CORE engine proof.

## Final state and provenance

After verified terminal outcomes and zero active CORE jobs, both owned SQL fixture containers were removed. Server-only package file inventories were subtracted from the protected client package inventories; unused daemon/bootstrap files and three server archives were removed. This released224,432,852 bytes without deleting client-owned files. All five client commands and their complete ELF library closure then passed again in exact `cf3d…`, networknone, UID10001, sanitized `PATH`, through `prlimit`.

The resulting private prefix allocates143,708,160 bytes (approximately137MiB), including retained authenticated metadata, client archives and proof. Free host space after proof was10,085,629,952 bytes. No daemon data volume or new image remains.

Authoritative server evidence lives under `/opt/steelkeep/native-sqlclients/provenance/`:

- `combined-proof.json`: direct/MCP outcomes, durable terminal metadata, actual archive SHA and native ELF/wrapper hashes.
- `runtime-sqlclients-{mysql,mariadb}-{direct,mcp}-proof.json`: four actual terminal records.
- `sqlclients-{mysql,mariadb}-recovered-data.json`: independent recovered SQL rows and counters.
- `release-signatures.json`, retained signed `InRelease` files and key fingerprints, `extracted-packages.json`: package authentication/provenance.
- `client-runtime-check.json`, `server-cleanup.json`: final closure checks and bounded cleanup inventory.

The native profile remains the documented MySQL8/MariaDB11 InnoDB SQL-authentication profile. This proof does not qualify external authentication plugins, views/stored programs or every server/plugin configuration. See [engine profiles](engine-profiles.md) and [native tooling](native-tooling.md).
