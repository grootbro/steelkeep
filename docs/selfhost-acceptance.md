# Packaged self-host acceptance

This proof packages the current application and worker from the repository's existing Dockerfiles, with **no application source bind mounts**. It derives from `compose.selfhost.yaml` using `compose.acceptance-selfhost.yaml`; the existing preview remains on 4310 and its API on 4311. Authoring these files does not establish that the package built or passed. No image/service/browser/test command was executed during this task.

## Separate installation

| Resource | Fixed proof setting |
| --- | --- |
| Compose project | `steelkeep-proof` |
| Packaged UI, API, OpenAPI, MCP | `http://127.0.0.1:4312` |
| Private metadata inspection | `127.0.0.1:54381`, database/user `steelkeep` |
| Metadata volume | `steelkeep-proof_metadata`; never the preview metadata volume |
| Web/migration image | `steelkeep-proof-web:local`, existing `Dockerfile` |
| Native worker image | `steelkeep-proof-worker:local`, existing `Dockerfile.engines` |
| Private bootstrap files | `.steelkeep/selfhost-proof/{key,token,metadata-password,compose.env}` |
| Permitted source/storage hosts | `fixture`, `mysql-fixture`, `s3` only |
| Shared fixture network | Existing external `steelkeep_default`; no production network is configured |

The metadata service stays on a private internal proof network. Web/worker also join the existing synthetic fixture network so native and driver connections resolve the same fixture DNS names as the already running local stack. The host allowlist limits product configuration, but joining a Docker network is **not** an outbound packet firewall: containers on that shared network remain network reachable. Run this proof only with the known isolated local fixture network. Do not attach a production or similarly named remote network.

The shared PostgreSQL 17, MariaDB 11 and RustFS fixtures must already be running. This proof does not start, migrate, stop or rebuild those services. Do not run concurrent recovery/failure suites: PostgreSQL fixture readers are read-only, while MariaDB's explicitly opted-in capture briefly takes a server-wide read lock.

## Owner-run preparation and build

Docker Compose **2.24.4 or later** is required. `!override` deliberately replaces inherited ports/volumes rather than appending a second listener or leaving the development secret mount. [Official Compose merge behavior](https://docs.docker.com/reference/compose-file/merge/).

From the exact checkout, first prepare new private installation material:

```sh
cd /Users/dobrota/dev/steelkeep
STEELKEEP_ACCEPTANCE=synthetic-local-selfhost bun scripts/prepare-selfhost-acceptance.ts
```

The script performs filesystem work only. It requires the fixed workspace and a nonroot local owner, validates real owner-only directories, creates mode-0600 files with exclusive creation, and preserves existing files. Key is 32 random bytes; token and metadata password are independent 64-character random hex strings. It never reads/copies development secrets, prints credentials, connects to an API/DB, or runs Docker. Invalid existing files cause a safe failure; they are not replaced. The generated `compose.env` contains only host/origin settings and the local UID/GID, not credentials.

Use the explicit environment file and both explicit Compose files. Avoid ambient Compose/Docker endpoint overrides. `env -i` below retains the local owner home/path for the local Docker context and credential helper, while excluding development environment variables; it does not put a password/token in argv.

```sh
env -i PATH="$PATH" HOME="$HOME" docker compose \
  --env-file /Users/dobrota/dev/steelkeep/.steelkeep/selfhost-proof/compose.env \
  --file /Users/dobrota/dev/steelkeep/compose.selfhost.yaml \
  --file /Users/dobrota/dev/steelkeep/compose.acceptance-selfhost.yaml \
  --project-name steelkeep-proof config --quiet

env -i PATH="$PATH" HOME="$HOME" docker compose \
  --env-file /Users/dobrota/dev/steelkeep/.steelkeep/selfhost-proof/compose.env \
  --file /Users/dobrota/dev/steelkeep/compose.selfhost.yaml \
  --file /Users/dobrota/dev/steelkeep/compose.acceptance-selfhost.yaml \
  --project-name steelkeep-proof build migrate worker

env -i PATH="$PATH" HOME="$HOME" docker compose \
  --env-file /Users/dobrota/dev/steelkeep/.steelkeep/selfhost-proof/compose.env \
  --file /Users/dobrota/dev/steelkeep/compose.selfhost.yaml \
  --file /Users/dobrota/dev/steelkeep/compose.acceptance-selfhost.yaml \
  --project-name steelkeep-proof up -d --no-build --pull never
```

The migration service uses the packaged web image and the private proof metadata password file. Web/worker wait for its successful exit. The first launch initializes a new proof metadata volume; subsequent launches intentionally retain it. No `down -v`, volume removal or metadata reset is part of the procedure. A different password cannot be substituted for an already initialized volume; preserve the proof password/key alongside its data.

Before accepting results, independently inspect the merged model/container mounts and record image IDs, build result/date and the source revision being packaged. Expected web/worker mount inventory: only the proof secret directory mounted read-only at `/run/steelkeep`. No `src`, `server`, `shared`, `dist`, repository root or development `.steelkeep` mount is allowed. Database uses only the named proof volume plus the proof metadata-password file. Confirm 4310/4311 still serve the original preview and 4312/54381 bind only to loopback.

## Guarded acceptance

The new harness is source-only until the owner runs:

```sh
STEELKEEP_ACCEPTANCE=synthetic-local-selfhost bun test acceptance/selfhost.test.ts
```

It is skipped without the exact marker and is absent from default test scripts. It builds/starts/stops **nothing**. It uses read-only Docker inspection to require running `steelkeep-proof` containers from this checkout, proof image tags, exact loopback bindings and the no-source-mount boundary. It refuses Docker endpoint environment overrides and non-Unix-socket contexts. The actual metadata connection is fixed to loopback 54381 with the private proof password; all direct metadata queries are read-only. Existing metadata profiles must name only the two known synthetic database hosts or local S3.

One serial scenario establishes:

1. Migrated private PostgreSQL 17 metadata exists and the packaged API authenticates the new proof installation token.
2. The official MCP SDK connects to `http://127.0.0.1:4312/mcp` and discovers backup/recovery tools.
3. A fresh **headless** Chromium context loads the compiled packaged UI on the same origin, signs in through the real token form, and navigates Dashboard/Connections/Backup plans/Snapshots/Jobs/Configuration. No Vite server or source mount supplies the UI.
4. For PostgreSQL and MariaDB, the owner harness checks the exact existing fixture version/count/sum marker before creating a new generated empty target with a restricted role. Source data is never reset or modified by the harness.
5. Real REST requests on 4312 register the fixed source, new target, independent RustFS bucket/storage and manual plan. A read-only metadata lookup correlates the REST-created connection ID with the private proof database, rather than trusting an unrelated API response.
6. MCP queues a real native backup; request-key retry returns the same job. A separate S3 GET verifies actual size, SHA-256 and native archive header.
7. MCP prepares and starts the trusted restore into that generated empty target. Repeating its intent/key returns the same restore job. The worker must report validated recovery with SHA-256 matched.
8. Independent direct SQL reads verify restored and retained source counts/sums. The packaged UI reloads Snapshots and displays the new source's published artifact.

All SQL admin/fixture and S3 connections use fixed loopback ports and public disposable fixture credentials. Generated target credentials are sent through PostgreSQL/MySQL drivers and REST bodies, never shell argv or console output. The product itself reaches only the fixed fixture DNS hosts. A successful harness prints a bounded summary of engine/run IDs and origin, without secrets.

The browser uses no trace, video, HAR, screenshot, persistent context or saved storage-state output. Token entry uses a private main-frame binding, keeping the token out of Playwright locator action arguments and failure call logs. Debug/protocol logging is refused. Do not enable recording/debug tools around a run that handles the real proof token.

## Evidence boundaries and preservation

A pass demonstrates one built local package's UI login/navigation, shared-origin HTTP/MCP contracts, packaged native worker, separate metadata and real PostgreSQL 17/MariaDB 11 round trips. It does not establish all eight engines, SQL Server/DacFx packaging, production deployment, cross-architecture support, load, physical/PITR recovery, visual/a11y acceptance or complete application-level recovery. Existing dedicated UI/failure suites provide separate evidence and should not be silently counted as packaged acceptance.

The harness retains every generated target, role/user, bucket/object, connection, plan, job, reservation and audit/history row. Failed/partial targets remain available for review. No source database, application metadata, artifact, volume or existing target is dropped, reset or truncated. To pause this proof later, stop only project `steelkeep-proof` with these explicit files; retain its volume and private key/password/token. Do not publish images, expose ports publicly, accept new third-party terms or purchase infrastructure as part of this proof.
