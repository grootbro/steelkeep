<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/brandassets/lockup-dark.png">
  <img src="public/brandassets/lockup-light.png" alt="steelkeep" width="560">
</picture>

### Database backups. A clear path to recovery.

Self-hosted backups for eight database engines, with a web dashboard<br>
and native MCP access for your AI agents.

<p>
  <a href="#project-status"><img src="https://img.shields.io/badge/status-alpha-F59E0B?style=flat-square&amp;labelColor=0F172A" alt="Status: alpha"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-6366F1?style=flat-square&amp;labelColor=0F172A" alt="License: MIT"></a>
  <a href="#database-profiles"><img src="https://img.shields.io/badge/database_engines-8-3B82F6?style=flat-square&amp;labelColor=0F172A" alt="Eight database engine profiles"></a>
  <a href="#api-and-ai-agents"><img src="https://img.shields.io/badge/MCP-native-8B5CF6?style=flat-square&amp;labelColor=0F172A" alt="Native MCP server"></a>
</p>

**[Get started](#self-host)** · **[Database profiles](#database-profiles)** · **[AI agents](#api-and-ai-agents)** · **[Documentation](#documentation)**

PostgreSQL · MySQL · MariaDB · MongoDB<br>
SQLite · Redis · ClickHouse · SQL Server

</div>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/dashboard-dark.png">
  <img src="docs/assets/dashboard-light.png" alt="Steelkeep dashboard with backup activity, recent jobs, snapshot totals and storage distribution" width="1440">
</picture>

<p align="center"><sub>Light and dark themes · Actual interface with synthetic demonstration data · <a href="docs/assets/README.md">Screenshot details</a></sub></p>

## Why Steelkeep

Keep database connections, backup schedules, snapshots and recovery in one place.
See what the worker is doing, inspect the archive it created, and review the destination
before a restore writes data. Use the dashboard or give a scoped AI agent access to the same operations.

| Connect & inspect | Schedule & recover |
| :--- | :--- |
| **🗄️ Eight database engines**<br>PostgreSQL, MySQL, MariaDB, MongoDB, SQLite, Redis, ClickHouse and SQL Server, each with an explicit recovery profile. | **🗓️ Backups on your schedule**<br>Run manually or use timezone-aware schedules. Follow persistent jobs, worker phases and logs. |
| **🔎 Inspect every snapshot**<br>Archive size, SHA-256, availability checks, notes and scoped downloads. Keep all snapshots or choose retention tiers. | **↩️ Review before recovery**<br>Check a separate empty target, verify downloaded bytes and inspect schema/data validation after restore. |
| **🤖 Built for AI agents**<br>Native MCP, REST and OpenAPI. Named agents get scoped credentials with expiry, delegation limits and revocation. | **🏠 Run it yourself**<br>Your infrastructure and S3-compatible storage. Email/password sign-in, sealed connection credentials and light/dark themes. |

## Project status

> [!IMPORTANT]
> **Steelkeep is alpha software.** All eight engine profiles have bounded synthetic
> native recovery evidence. Full feature parity, broader failure testing and a clean
> all-engine distribution image remain in progress. Check the
> [runtime ledger](docs/server-runtime.md) and [engine profiles](docs/engine-profiles.md)
> before trusting a real database to a particular installation.

## Database profiles

| Engine | Current profile | Capture and prerequisites |
| --- | --- | --- |
| PostgreSQL | 17 | Exported snapshot; `pg_dump` / `pg_restore` 17. Sequence changes during capture refuse publication. |
| MySQL | 8.0, ordinary InnoDB tables | Real MySQL 8 clients and an explicitly permitted server-wide read lock. |
| MariaDB | 11, ordinary InnoDB tables | Separate MariaDB 11 clients and an explicitly permitted server-wide read lock. |
| MongoDB | 8.0 standalone | Database Tools 100.20; explicitly permitted, journaled server-wide fsync lock. |
| SQLite | Worker-local initialized files | Native Online Backup; separate allowlisted source and target mounts. |
| Redis | Standalone 7 / 8, one logical database | Atomic native DUMP/RESTORE with absolute expiry; up to 5,000 keys / 64 MiB. |
| ClickHouse | 25.8, Atomic / plain MergeTree | Server-native backup, an owner-maintained idle window and a backup disk shared with the worker. |
| SQL Server | 2019 / 2022 profile; 2022 tested | Read-only source, .NET 10 Linux x64 / DacFx 170.5.96; BACPAC logical portability. |

Archives currently have a **2 GiB limit**. Each profile has version, schema and
consistency requirements; eight adapters do not imply arbitrary-version or cluster support.

<details>
<summary><strong>Read the engine boundaries before connecting a database</strong></summary>

MySQL/MariaDB refuse stored programs, views, triggers/events and non-InnoDB tables.
MongoDB replica sets/shards and ClickHouse distributed/replicated tables need additional
profiles. SQL Server BACPAC is logical portability, not native `.bak`, log-chain recovery
or PITR. Source locking and maintenance requirements vary by engine.

Read the [full profiles](docs/engine-profiles.md), [native tooling](docs/native-tooling.md)
and [independent runtime evidence](docs/server-runtime.md).

</details>

## Self-host

**You’ll need:** Bun 1.4 for setup, Docker Compose, an S3-compatible bucket with credentials, and network access from the worker to the chosen database. Run setup as the intended non-root service owner. Native package pins are in [Dockerfile.engines](Dockerfile.engines). SQL Server additionally needs the explicit [x64 extension](Dockerfile.mssql) and applicable Microsoft terms; it is not silently downloaded by the default stack.

### 1. Prepare your installation

From a source checkout:

```sh
git clone https://github.com/grootbro/steelkeep.git
cd steelkeep
bun install --frozen-lockfile
bun scripts/setup-local.ts
```

### 2. Configure access

Edit `.env` before starting. Set exact database and S3 hostnames in `STEELKEEP_ALLOWED_HOSTS`. For HTTPS also set:

```dotenv
STEELKEEP_PUBLIC_HOSTS=backup.example.com
STEELKEEP_ALLOWED_ORIGINS=https://backup.example.com
STEELKEEP_SECURE_COOKIE=true
```

### 3. Build once and start

Keep the generated `.steelkeep/key`, `.steelkeep/token` and `.steelkeep/metadata-password` private. Setup preserves existing files. Build the web and multi-engine worker once, then start:

```sh
docker compose -f compose.selfhost.yaml pull database
docker compose -f compose.selfhost.yaml build migrate
docker compose -f compose.selfhost.yaml build worker
docker compose -f compose.selfhost.yaml up -d --no-build --pull never
```

The web server binds `127.0.0.1:4310` on the host. Put your HTTPS reverse proxy in front of that port; preserve the Host header and streaming responses. Metadata and archive storage are separate: the Compose file provisions PostgreSQL metadata, while you supply the S3 bucket. Worker-local SQLite files and ClickHouse shared disks need explicit mounts and allowlists described in [engine profiles](docs/engine-profiles.md).

### 4. Create your account

Create a private, single-use setup link immediately before opening it:

```sh
docker compose -f compose.selfhost.yaml exec \
  -e STEELKEEP_SETUP_ORIGIN=https://backup.example.com \
  web bun scripts/setup-owner.ts
```

The link expires in five minutes and contains no installation key. Choose your name, email and password; later visits use ordinary sign-in. For loopback-only HTTP testing, use `http://127.0.0.1:4310` and `STEELKEEP_SECURE_COOKIE=false`. See [authentication](docs/authentication.md).

### Your first backup

1. In Connections, add your database and S3 storage; test both connections. Use a dedicated database role with the documented permissions.
2. Create a plan with that source and destination. Start manually or configure a timezone schedule.
3. Follow the actual worker phases in Jobs. Open the resulting snapshot to inspect size, SHA-256, availability and logs.
4. Test recovery into a separate empty destination. A stored archive and a successful restore validation are distinct results.

> [!NOTE]
> Keep an independent protected copy of the metadata encryption key. Losing it makes
> stored connection credentials unrecoverable. Configure archive encryption and offsite
> retention in your storage; client-side archive encryption is not implemented.

## API and AI agents

Connect your MCP client to your installation:

```text
https://backup.example.com/mcp
```

| Interface | Endpoint | Use it for |
| :--- | :--- | :--- |
| **MCP** | `/mcp` | Native Streamable HTTP tools for AI agents |
| **REST** | `/api/v1` | Scripts, integrations and application commands |
| **OpenAPI / Scalar** | `/openapi` · `/openapi/json` | Browse the API and its schemas |
| **Agent guide** | `/steelkeep-agent.md` | Installation-served operating instructions |

Create an agent in **Configuration → AI agents**, then give its token to your MCP
client as a bearer credential. The default grant is read-only and expires in 24 hours.
Tokens are shown once and stored hashed. Delegation cannot increase permissions or
outlive its issuer; revocation includes descendants. No model-provider account is required.

<details>
<summary>Available agent scopes</summary>

`read` · `configure` · `backup:run` · `restore:run` · `jobs:cancel` ·
`agents:manage` · `backup:delete` · `backup:download`

See [authentication and agent access](docs/authentication.md).

</details>

## How recovery stays deliberate

An empty-target review expires and is bound to the actor, source artifact, destination identity and permissions. SHA-256 is checked before restore writes. Unknown restore outcomes retain a destination reservation and are never automatically replayed; inspect partial data and prepare a fresh target.

Snapshot availability HEAD checks inspect object metadata, not downloaded bytes. Native downloads and restores verify complete bytes. Manual deletion requires a reviewed selection and explicit acknowledgement; ambiguous conditional deletes stay held without retry. See [downloads](docs/snapshot-downloads.md), [reviewed deletion](docs/snapshot-deletion.md) and [retention](docs/retention.md).

## Documentation

| Start here | Go deeper |
| :--- | :--- |
| [Installation](docs/server-installation.md) | [Architecture](docs/architecture.md) |
| [Engine profiles and permissions](docs/engine-profiles.md) | [Native tooling](docs/native-tooling.md) |
| [Sign-in and AI agents](docs/authentication.md) | [Recovery acceptance evidence](docs/acceptance.md) |
| [Retention policies](docs/retention.md) | [Runtime qualification](docs/server-runtime.md) |
| [Snapshot downloads](docs/snapshot-downloads.md) | [Feature parity and remaining work](docs/databasement-parity.md) |
| [Reviewed deletion](docs/snapshot-deletion.md) | [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) |

## Built with

**TypeScript** · **TanStack Start / Router / DB** · **React** · **Elysia** · **Bun**<br>
PostgreSQL metadata · Kysely · pg-boss · S3-compatible archives

The web dashboard, REST API and MCP server call the same application services.
Native tools run in the worker.

## Development

The synthetic development fixtures contain deliberately public disposable credentials. Never reuse them for real services. Follow [architecture and development evidence](docs/architecture.md) and the guarded acceptance scripts; heavy native fixtures are opt-in.

```sh
bun run typecheck
bun run typecheck:acceptance
bun run test
```

Default tests do not start database fixtures. The CI workflow installs locked dependencies,
runs both TypeScript checks and default tests, and builds the web application.
See the [GitHub CI results](https://github.com/grootbro/steelkeep/actions/workflows/ci.yml);
these checks do not qualify native recovery.

Some historical acceptance harnesses deliberately require their original absolute checkout
and fixture identities. They are operator-specific tools, not a portable test suite;
don't remove their guards just to run them elsewhere. Native acceptance requires
independent archive-byte and restored-data checks. Historical proofs don't automatically
qualify newer source, packages or images. See the [acceptance ledger](docs/acceptance.md),
[native tooling](docs/native-tooling.md) and [parity tracker](docs/databasement-parity.md).

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Steelkeep source is [MIT licensed](LICENSE). Adapted Databasement interface material, fonts and optional Microsoft tooling retain their respective [notices and terms](THIRD-PARTY-NOTICES.md). Salt.md was an interaction reference; its AGPL source/assets were not copied.
