# PostgreSQL 17 and 18 qualification

Source checkpoint `f4906e1f31ad2de640e930c54125e73c2878239b` passed the isolated
[PostgreSQL native CI run45296406576](https://github.com/grootbro/steelkeep/actions/runs/45296406576)
on24 November2026. Both TypeScript configurations and129 unit tests /1,157
assertions passed. Two actual native adapter roundtrips passed52 assertions.

| Server | Actual matching client | Independent result |
| --- | --- | --- |
| PostgreSQL17.12 | PGDG17.12 (`17.12-1.pgdg24.04+1`) | Custom archive5,770bytes; schema/data/sequence validation passed; source unchanged |
| PostgreSQL18.7 | PGDG18.7 (`18.7-1.pgdg24.04+5`) from the generated bundle below | Custom archive5,767bytes; schema/data/sequence validation passed; source unchanged |

The test captured exported snapshots through Steelkeep's actual NativeAdapter,
restored each archive into a separately provisioned empty database through a
restricted nonsuperuser role, compared manifests and independently queried Unicode,
binary/empty bytes, JSON, decimals, timestamps, arrays, enum values, foreign keys,
indexes, views, a routine, NOT NULL and sequence state (next value74). It checked
the complete archive SHA-256 before and after recovery. Both cross-major attempts
were refused before writes; their targets remained empty.

This qualifies the native adapters and archive path. It does **not** establish an
S3/worker/API/MCP end-to-end run, a production backup, a new immutable image,
ARM64 tooling or arbitrary PostgreSQL18 schemas. Production provisioning and its
first platform backup need their own evidence. Earlier PG17 platform recovery
proof remains recorded in [the PostgreSQL ledger](server-postgres.md).

## Admission and native tools

Source, archive and restore target must use the same supported PostgreSQL major:
17→17 or18→18. `pg_dump` and `pg_restore` must report that exact major. Cross-major
migration is outside this recovery profile even when PostgreSQL's tools can perform
broader migration operations. The check runs both during read-only restore review
and again before the native restore writes data.

PG17 keeps its existing `pg_dump` / `pg_restore` PATH commands. PG18 uses separate
allowlisted `pg_dump18` / `pg_restore18` commands, so adding18 cannot redirect17 to a
newer dump client. Missing or wrong-major tools refuse execution. The Ubuntu worker
recipe installs both client families; that changed recipe has not been rebuilt by
this proof. The Alpine alternative remains PG17-only unless separately provisioned
and qualified.

Existing boundaries remain: no non-plpgsql extensions, foreign tables or large
objects; at most500 tables and2GiB per archive; MVCC snapshot with changing sequence
state refusing publication; a dedicated restricted empty target; no source overwrite.
Native client18 support does not waive those schema and consistency checks.

## Verified Linux amd64 client bundle

CI downloaded the PostgreSQL signing key over HTTPS, verified fingerprint
`B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8`, and installed packages through signed PGDG
Noble repository metadata and package hashes. It copied the installed client18
binaries and observed dependency closure, including their loader, into a standalone
bundle. Wrappers select that private loader/library path; `runTool` continues to
strip ambient libpq and loader settings. The **generated wrappers**, rather than
host18 binaries, executed the successful adapter proof.

Artifact `postgres-native-f4906e1f31ad2de640e930c54125e73c2878239b`, ID14876931444:

- `steelkeep-postgres18-linux-amd64.tar.gz`:7,803,315bytes; unpacked19,449,332bytes.
- SHA-256:`aefbed798923625aabb89440c89d4b84466f581c89372c80c27a21e76ff0327f`.
- Client:`postgresql-client-18 18.7-1.pgdg24.04+5 amd64`.
- libpq:`libpq5 18.7-1.pgdg24.04+2 amd64`; libc:`2.39-0ubuntu8.12 amd64`.
- Internal layout:`postgres18-client/{bin,lib,wrappers,manifest.json,package-provenance.tsv}`.
- Intended mount/extraction root:`/opt/steelkeep-pg18`; append its `wrappers` directory
  to the worker's trusted PATH while preserving all PG17 PATH entries.

The artifact includes per-file hashes and separate17/18 JSON proof reports. Verify
the archive and manifest before installing it. This is a pinned CI artifact, not a
permanent package mirror; artifacts expire after14 days. Regeneration requires a
new signed-vendor download and native qualification. No server package installation,
image build or production deployment occurred in this agent's qualification lane.

[Official pg_dump18 semantics](https://www.postgresql.org/docs/18/app-pgdump.html),
[pg_restore18](https://www.postgresql.org/docs/18/app-pgrestore.html), and
[the PostgreSQL Ubuntu repository](https://www.postgresql.org/download/linux/ubuntu/).

## Application data in the default `postgres` database

Some applications use the literal database name `postgres` for their own tables.
Capture remains refused by default. An installation administrator can set
`STEELKEEP_POSTGRES_SOURCE_ALLOWLIST` to comma-separated **exact** endpoints such as
`db.example.test:5432,other.example.test:6543`. IPv6 entries use
`[fd00::1]:5432` while the connection host is the unbracketed address. Host spelling,
case and numeric port must match; there are no wildcard, CIDR, suffix, URL or
implicit-port matches. The host must also pass `STEELKEEP_ALLOWED_HOSTS`.

The normal self-host Compose forwards this setting to the shared API/worker
environment; `.env.example` leaves it empty. It permits only a PostgreSQL **source**
whose exact database name is lowercase `postgres`. The worker and native adapter
recheck capture policy; a connection field, scoped token or imported source record
cannot grant this exception. Other system names remain protected. If the metadata
database itself is named `postgres`, the exception stays disabled, including for
archived-source admission; metadata-name protection always runs first.

A verified archive may retain `postgres` as its recorded PostgreSQL source name,
including portable Drive import on an installation whose metadata has another
name. This does not authorize connecting to or capturing that source. Recovery
still requires a different precreated empty database under a dedicated restricted
role. A target named `postgres`, any metadata database name or another protected
system name remains forbidden. The exception does not change schema, snapshot,
matching-major, source/target separation or archive-integrity requirements.
