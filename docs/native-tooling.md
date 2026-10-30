# Native worker tooling

Status: **ARM64 development image built; seven ordinary native recovery profiles verified, 31 October 2026**.
The primary executor observed the Ubuntu `Dockerfile.engines` build and running development
API/worker. Current `server`/`shared` source is bind-mounted into those containers. This does
not prove a clean immutable self-hosted image, amd64 delivery or recovery for every packaged
profile. Development and self-hosted Compose select this recipe; the Alpine alternative remains.
See the [execution ledger](acceptance.md). This documentation pass did not build or run tooling.

## Packaged profiles

The new worker recipe uses Ubuntu 24.04 and the Bun 1.4.0 binary from the official `oven/bun` image. Both `linux/amd64` and `linux/arm64` are intended build targets. The local ARM64 image build passed; amd64 remains unbuilt in this record. Bun's platform support does not by itself prove the complete application matrix. [Bun installation](https://bun.com/docs/installation).

| Engine | Tools in this recipe | Additional requirement |
| --- | --- | --- |
| PostgreSQL 17 | PGDG `postgresql-client-17` | Isolated source and restricted empty target roles |
| MySQL 8 | Ubuntu `mysql-client-core-8.0`, extracted under `/opt/mysql8` | Matching MySQL profile and explicit source-lock permission |
| MariaDB 11 | Official MariaDB 11.4 `mariadb-client` and `mariadb-client-core` | Matching MariaDB profile and explicit source-lock permission |
| MongoDB 8 standalone | Official Database Tools **100.20.0** | Fsync-lock opt-in, journal reconciliation, designated target sentinel |
| SQLite | Ubuntu `sqlite3`, Bun SQLite APIs | Existing files under separate allowlisted source/target mounts |
| Redis | Existing JavaScript adapter | Supported standalone server and bounded capture permissions; no CLI required |
| ClickHouse | Existing HTTP adapter and server-native backup | Explicit maintenance assertion and matching shared backup-disk mounts; no CLI required |
| SQL Server | Helper source included, **no .NET/DacFx binaries** | Explicitly provisioned Linux x64 extension described below |

PostgreSQL 17, MariaDB 11, MongoDB 8.0.34/Tools100.20, Redis 7.4.12 and SQLite passed
real local native MCP recovery with this development runtime. Post-restart MySQL 8.0.46
passed 1 test / 63 assertions; ClickHouse 25.8.12 passed 1 test / 20 assertions.
SQL Server runtime remains pending on a supported nonproduction physical x64 Linux runner. A successful image build or packaged client does not establish additional server-version, schema or consistency support.

## Coexisting MySQL and MariaDB

Installing both vendors' conflicting client-core packages into one package database is avoided. A separate Ubuntu stage asks authenticated Ubuntu APT for `mysql-client-core-8.0=8.0.46-0ubuntu0.24.04.4` and extracts the package under `/opt/mysql8`. The final stage installs MariaDB normally. `PATH` chooses `/opt/mysql8/usr/bin/mysql` and `mysqldump` first; `mariadb` and `mariadb-dump` remain the MariaDB clients. PostgreSQL 17's binary directory is also explicit.

Ubuntu's package metadata lists the shared-library dependencies installed by the recipe. Both architecture file lists contain `mysql` and `mysqldump`. No MySQL daemon is installed. Optional external authentication plugins are outside the current SQL-authentication profile and need separate qualification. [Ubuntu package](https://packages.ubuntu.com/noble-updates/mysql-client-core-8.0), [amd64 files](https://packages.ubuntu.com/noble-updates/amd64/mysql-client-core-8.0/filelist), [arm64 files](https://packages.ubuntu.com/noble-updates/arm64/mysql-client-core-8.0/filelist).

## Provenance and integrity

APT uses Ubuntu's normal signed repositories plus three explicitly scoped `signed-by` entries. No `trusted=yes`, signature bypass or unverified tarball fallback is used. Only clients are requested; no database server package is requested.

- PostgreSQL: `https://apt.postgresql.org/pub/repos/apt`, suite `noble-pgdg`; key `https://www.postgresql.org/media/keys/ACCC4CF8.asc`. The Dockerfile checks fingerprint `B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8`, published by [PostgreSQL's Ubuntu instructions](https://www.postgresql.org/download/linux/ubuntu/).
- MariaDB: `https://dlm.mariadb.com/repo/mariadb-server/11.4/repo/ubuntu`, suite `noble`, component `main`. Reviewed amd64 and arm64 indexes both list `1:11.4.13+maria~ubu2404`. The official [repository setup source](https://r.mariadb.com/downloads/mariadb_repo_setup) names the keyring URL used here. Its separately fetched [published SHA-256](https://supplychain.mariadb.com/mariadb-keyring-2025.gpg.sha256) is `403e0403df51273fbf5613e5644959d3f85923ef7d8f92e7d83eafe289093af4`. [Repository documentation](https://mariadb.com/docs/server/server-management/install-and-upgrade-mariadb/mariadb-package-repository-setup-and-usage).
- MongoDB: `https://repo.mongodb.org/apt/ubuntu`, suite `noble/mongodb-org/8.0`, component `multiverse`; key `https://pgp.mongodb.com/server-8.0.asc`. The official [Ubuntu 8.0 instructions](https://www.mongodb.com/docs/v8.0/tutorial/install-mongodb-on-ubuntu/) publish this repository and both architectures. The recipe pins **only** `mongodb-database-tools=100.20.0` from it. [Tools platform/version documentation](https://www.mongodb.com/docs/database-tools/).

The following exact package paths and hashes were read from official MongoDB package indexes. During the original source-research step, package binaries were not downloaded and signatures were not independently verified. The later successful ARM64 image build used the signed APT installation path. These index hashes are provenance records, not an additional independent byte-verification report.

| Architecture | URL | SHA-256 from repository index |
| --- | --- | --- |
| amd64 | [100.20.0 Debian package](https://repo.mongodb.org/apt/ubuntu/dists/noble/mongodb-org/8.0/multiverse/binary-amd64/mongodb-database-tools_100.20.0_amd64.deb) | `ac3c856a55695615bdffe02bcfd8592108493a26a7a2bed5dd8709405f840d24` |
| arm64 | [100.20.0 Debian package](https://repo.mongodb.org/apt/ubuntu/dists/noble/mongodb-org/8.0/multiverse/binary-arm64/mongodb-database-tools_100.20.0_arm64.deb) | `0884051f2d7e9eb3cfb8f5c9166d4e61c70d4c55e50778ee7a7c637999097ed2` |

Index sources: [amd64 Packages.gz](https://repo.mongodb.org/apt/ubuntu/dists/noble/mongodb-org/8.0/multiverse/binary-amd64/Packages.gz), [arm64 Packages.gz](https://repo.mongodb.org/apt/ubuntu/dists/noble/mongodb-org/8.0/multiverse/binary-arm64/Packages.gz). No archive checksum was invented; the signed-repository installation path is used instead.

Client packages keep their distribution copyright files; the extracted MySQL package keeps its documentation beneath `/opt/mysql8/usr/share/doc`. MongoDB Database Tools are separately distributed under Apache 2.0, not the server's license. MariaDB and MySQL client distribution obligations remain applicable to those packages. Before distributing an image, retain the corresponding notices and satisfy source-distribution obligations. [MongoDB tools download](https://www.mongodb.com/try/download/database-tools), [MariaDB licensing FAQ](https://mariadb.com/docs/general-resources/community/community/faq/licensing-questions/licensing-faq).

Versions in build arguments identify reviewed package releases. Ubuntu image tags, Bun image tags and repository contents can change. The PostgreSQL package deliberately follows the maintained 17 client series. The recipe records installed package versions and the extracted MySQL metadata beneath `/usr/share/steelkeep`; it is not yet a digest-pinned reproducible release.

## SQL Server provisioning boundary

The base recipe supports seven engines' client requirements. It does **not** make SQL Server operational by installing an unrelated `sqlcmd` binary. The adapter requires the project's `tools/Steelkeep.DacFx` helper, its pinned Microsoft DacFx package and a compatible .NET 10 runtime. Microsoft's [SqlPackage download documentation](https://learn.microsoft.com/en-us/sql/tools/sqlpackage/sqlpackage-download?view=sql-server-ver17) describes Linux tooling and the DacFx package. Project source and package terms must be reviewed together before redistribution.

For the current MSSQL profile, explicitly provision a **Linux x64** worker extension with the published helper output and runtime, put `dotnet` on the worker's `PATH`, and set `STEELKEEP_DACFX_HELPER` to the absolute helper DLL path. Publishing must retain the helper's dependencies, not just the DLL. The adapter verifies the actual package/tool response. The broad base's ARM64 target does not imply DacFx ARM64 support. Missing or mismatched tooling must remain a clear profile error. No Microsoft tooling or license acceptance is silently introduced by this Dockerfile.

`Dockerfile.mssql` is a separate opt-in source recipe for that extension. It uses
the official .NET 10 Ubuntu 24.04 SDK/runtime images, publishes the helper and adds
it to the already built multi-engine image. It refuses a non-amd64 target. It has
not been built; Microsoft terms, runtime API compatibility and native dependencies
remain unverified for this optional profile. Default Compose does not select this recipe.
Use a supported physical Linux x64 environment; a Docker platform flag is not proof
that Microsoft supports an emulated host.

Commands for a separate amd64/SQL Server qualification; these remain unexecuted in this record:

```sh
docker build --platform linux/amd64 -f Dockerfile.engines -t steelkeep-engines:local .
docker build --platform linux/amd64 -f Dockerfile.mssql -t steelkeep-engines-mssql:local .
```

Then explicitly select the resulting worker image in a Compose override. Preserve
the existing secret mounts, user mapping, source/target mounts and endpoint allowlist.
The .NET helper receives credentials only through its bounded private stdin request.

Official MCR tag-list metadata was checked for `sdk:10.0-noble` and
`runtime:10.0-noble`; both tags exist. This is metadata evidence only, not an image
pull or runtime check: [SDK tag list](https://mcr.microsoft.com/v2/dotnet/sdk/tags/list),
[runtime tag list](https://mcr.microsoft.com/v2/dotnet/runtime/tags/list).

## Integration and later acceptance

Development Compose selects `Dockerfile.engines`; self-hosted Compose builds a separate `steelkeep-engines:local` worker image. The image defaults to non-root UID/GID `10001:10001`; Compose overrides the user to match ownership of its protected secret files and mounted databases. Keep the key/token directory private, source mounts read-only where the engine permits, and target/shared-backup mounts restricted to the intended owner/group.

Recorded local execution: the ARM64 Ubuntu worker built, Docker API/worker started with
current source mounts, and PostgreSQL 17/MariaDB 11 passed the native MCP recovery rerun
(27 assertions). Install, schema migration, typecheck, application build and targeted tests
also passed. The latest full Playwright group passed 4/4 in 36.4s, including PostgreSQL/MariaDB
recovery with independent S3 GET/SHA and SQL assertions, connection lifecycle and agent
issuance/scopes/revocation. Those results are recorded by the primary
executor, not rerun by this docs edit.

MongoDB8.0.34/Tools100.20, Redis7.4.12 and SQLite subsequently passed native recovery;
see the acceptance ledger for exact assertions and Linux live-WAL fixture limits.
Worker cancellation/SIGKILL/restart passed its first PostgreSQL native harness (403 assertions),
with a bounded no-replay window; other fault boundaries still need checks.

The Linux-x64 DacFx helper compiled through `Dockerfile.mssql --target helper` under local
amd64 emulation. The first restore warned about transitive Pkcs9.0.11; an explicit9.0.21
reference removed both NuGet advisory warnings on the next compile. That compile succeeded,
but exporting its image failed with Docker storage I/O errors when the host disk filled.
The recipe now removes NuGet/build caches from that stage; this last recipe edit is unbuilt.
Neither compilation nor emulation qualifies SQL Server runtime: Microsoft requires Intel/AMD
x64 Linux for supported containers ([support policy](https://learn.microsoft.com/en-us/sql/linux/install-upgrade/setup)).

Docker recovered after an owner-approved restart, preserving existing volumes; metadata
amcheck, decryption of all 46 stored secrets and full bytes/SHA checks for 19 existing S3
objects passed. MySQL 8.0.46 and ClickHouse 25.8.12 ordinary recovery subsequently passed
as recorded above. Permanent S3 failures and bounded retry after stopping/restarting only
the same fixture RustFS container also passed; the full fault matrix remains open.
The packaged web image has built successfully; the separate worker image was still building.

Remaining qualification: amd64 worker delivery, clean immutable self-hosted stack/recovery,
SQL Server runtime on an actual nonproduction x64 runner with operator EULA acceptance,
remaining engine UI and responsive/accessibility review, and broader adverse cases.
No volume or restore target was deleted.
