# Optional SQL Server fixture — source authored, never run

This is a synthetic BACPAC application-data recovery profile, not native `.bak`,
transaction-log/PITR recovery, server-login recovery or proof of availability.
The adapter/helper accepts SQL Server 2019/2022; this fixture targets 2022 only.
Its SQL Server Developer edition is for non-production use under Microsoft's
terms. Neither SQL Server nor DacFx is covered by this repository's MIT license.

When execution is explicitly authorized, provision on a **physical Linux Intel/
AMD x64 host**. Apple Silicon emulation/Rosetta and ARM are outside Microsoft's
supported container profile. The overlay's `linux/amd64` selector alone cannot
prove physical hardware. Set `STEELKEEP_MSSQL_PHYSICAL_X64=1` only after checking
that prerequisite. Use the optional `Dockerfile.mssql` extension image, tagged
`steelkeep-mssql:local`, for API and worker; base images lack the helper. No helper
compilation, package restore, image download or container command was executed
while writing these files.

Use `compose.yaml` with the explicit `compose.mssql-fixture.yaml` overlay. It
pins Microsoft's named `2022-CU23-ubuntu-22.04` tag; no digest was fetched or
verified, so pin the actual registry manifest before reproducible execution.
The fixture publishes only host-loopback TCP 54380 and keeps data in its own
named volume. Do not expose it publicly. The SA password must be an independently
chosen strong **synthetic-only** `STEELKEEP_MSSQL_SA_PASSWORD`; it is never put in
application connections, logs or process argv. Compose carries it in the SQL
Server container's environment, visible to the local Docker administrator.

There is intentionally no default EULA acceptance. After reviewing Microsoft's
terms, the operator must supply `STEELKEEP_MSSQL_ACCEPT_EULA=Y` before provisioning;
missing acceptance/password causes Compose interpolation to stop. Authoring this
overlay does not accept terms or authorize downloading/running proprietary tools.

Once the isolated metadata/API/worker/S3 services and SQL Server are ready, set
`STEELKEEP_ACCEPTANCE=synthetic-local-mssql` and explicitly invoke
`bun scripts/seed-mssql-fixture.ts`. It checks for a fresh SQL2022 namespace and
refuses existing databases/logins rather than dropping/replacing anything. It
creates simple dbo tables with exact decimals, Unicode, null/empty binary,
datetimeoffset(7), identities, a secondary index, FK and check constraints. Then
it makes the source READ_ONLY using WITH NO_WAIT: no forced rollback or writer
termination. Source and designated empty target each have a dedicated login with
db_owner **only in their respective database**, plus default public server rights.
Application credentials cannot provision databases/server logins. Source writes
remain impossible even to its db_owner while the database is READ_ONLY.

**Permission compatibility remains unproved.** Microsoft's BACPAC export page
lists ALTER ANY LOGIN in its minimum permissions, in addition to database VIEW
DEFINITION and catalog SELECT. This fixture deliberately does not grant that
server-level privilege. If DacFx export cannot work with read-only db_owner and
public-only server rights, report this as an unsupported least-privilege profile;
do not broaden permissions or quietly substitute sa. The helper also validates
plain supported application catalog objects and refuses extra external/security
objects. Model-database customization can therefore make this fixture fail closed.

The opt-in `bun test acceptance/mssql-recovery.test.ts` uses the official MCP
client to run backup, retry the same backup key, inspect a completed artifact,
GET its entire S3 object and independently hash its bytes. It provisions a fresh
separate empty target with the fixture-only SA credential, then uses restricted
application connections for prepare/start, same-key replay and import. Independent
`mssql` driver queries assert exact recovered values, column types/precision,
trusted/enabled constraints and index existence; actual inserts verify next
identity values, duplicate-key, FK and CHECK enforcement. Source target selection,
nonempty target and source-write attempts must fail. All databases/logins,
including partial targets, remain for inspection. No DROP/REPLACE cleanup exists.

Still pending: DacFx170.5.96 compilation/runtime dependencies, restricted source
export, importing into precreated db_owner-only target, SQL2019 compatibility,
TLS/certificate provisioning, cancellation/worker-loss ambiguity and UI acceptance.
SQL authentication with `tls:false` is confined to this isolated local fixture;
it is not a recommended production transport configuration. Do not retry an import
after an ambiguous result; preserve the target reservation and investigate.

Primary references: [Microsoft container requirements and environment variables](https://learn.microsoft.com/en-us/sql/linux/quickstart-install-connect-docker?view=sql-server-linux-ver16),
[Microsoft container tag listing](https://hub.docker.com/r/microsoft/mssql-server),
[BACPAC export permissions and consistency](https://learn.microsoft.com/en-us/sql/tools/sql-database-projects/concepts/data-tier-applications/export-bacpac-file),
[DacServices.ExportBacpac](https://learn.microsoft.com/en-us/dotnet/api/microsoft.sqlserver.dac.dacservices.exportbacpac),
and [DacImportOptions.PreserveIdentityLastValues](https://learn.microsoft.com/en-us/dotnet/api/microsoft.sqlserver.dac.dacimportoptions.preserveidentitylastvalues).
