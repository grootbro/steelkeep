# Local worker failure acceptance

`acceptance/worker-failures.test.ts` is an opt-in integration harness using real REST requests, PostgreSQL 17 native tools, the running local S3 pipeline, and the real Compose worker. Root executed it on 31 October 2026: **1 passed, 403 assertions, 42.45 seconds**. The observed checks below were actual runtime checks, not inferred from source.

The run used source `wf_src_7a0c6644ac8e`, target `wf_target_7a0c6644ac8e_1`,
artifact run `d56eaf7a-052d-413b-907e-b1dbc4ccb8ea`. Queued cancellation stayed at
attempt 0; running cancellation and interrupted dump/restore stayed at attempt 1.
The native restore target remained reserved and contained no committed table. The 12-second
observation window is deliberately narrower than full lease/retry coverage. All resources
were retained. A later host disk/Docker incident does not establish their current integrity;
the fixture stack must be checked after environment recovery.

## Scope and guards

Run only after the owner authorizes the local fault-injection review and other local acceptance jobs are finished:

```sh
STEELKEEP_ACCEPTANCE=synthetic-local-failures bun test acceptance/worker-failures.test.ts
```

The harness is skipped without that exact opt-in. It is excluded from the normal `test` command. Run this file alone, never concurrently with UI/MCP/recovery suites: it intentionally stops and kills the single shared local worker.

It refuses anything except `/Users/dobrota/dev/steelkeep`, `http://127.0.0.1:4311`, fixed loopback metadata `127.0.0.1:54371/steelkeep`, and the seeded PostgreSQL 17 fixture at `127.0.0.1:54372/source`. It verifies the source's 1,000-row/sum fixture marker, the API owner identity, and the exact seeded RustFS connection. It accepts no URL/DSN/connection selector from environment variables. It reads the existing installation token from `.steelkeep/token` and never prints it.

Docker must use an existing local Unix-socket context; `DOCKER_HOST` and `DOCKER_CONTEXT` overrides are refused. Before worker control it checks Compose project/service/working-directory/config-file labels, requires exactly one initially running `steelkeep` worker, no current active jobs, and no enabled scheduled plans. A metadata advisory lock serializes this harness with itself. Other suites/operators do not honor that lock, so exclusive local review remains a prerequisite.

Every Compose command names the absolute local `compose.yaml`, project `steelkeep`, and only `worker`. Allowed mutations are `stop`, `kill --signal SIGKILL`, and `up -d --no-deps --no-build --pull never worker`. The harness does not rebuild/pull images or stop API, metadata, source fixtures, or S3. It refuses stacks started using merged/custom Compose files; use the base fixture profile for this test.

## What a passing run establishes

1. **Queued cancellation and duplicate admission.** Stop only the idle worker; queue a newly generated source's manual plan, retry the same request key concurrently, and confirm one job ID. Cancel while `attempt=0`, restart the worker, and verify it remains cancelled with no published artifact.
2. **A real artifact.** Run the same synthetic source through the normal native dump/upload pipeline and require a successful artifact before attempting restore failure injection.
3. **Running native dump cancellation.** Hold an owned source-local catalog lock, wait for actual `pg_dump` to be blocked by that exact backend, request cancellation, and require worker-confirmed cancellation and no published artifact. A `cancelling` API response alone is insufficient.
4. **Native dump SIGKILL and restart.** Kill the worker only after both durable phase `dumping` and an actual blocked native backend are observed. Release the harness lock, wait for native sessions to disappear, restart, and require `WORKER_INTERRUPTED`, one attempt, no completed event, and no artifact. Repeating the original request key must return the original interrupted run.
5. **Native restore SIGKILL and restart.** Generate a distinct empty target and restricted restore role. Prepare/start normally; retry the same intent/key; wait for phase `restoring` plus actual blocked `pg_restore`, then SIGKILL. After native-session shutdown and restart, require `interrupted`, no passing validation, the original target block and refusal of another restore review. The same consumed intent/key returns the original run.
6. **Bounded replay observation.** Transfer worker ownership again and observe the interrupted runs for 12 seconds, longer than the queue's initial 10-second retry delay, with no attempt increment. Independently check request-key row uniqueness, unchanged source row count and empty target catalog. Retain the target block even though this fixture's PostgreSQL transaction left no committed table.

The successful test prints a small credential-free JSON summary containing generated database names, run IDs, outcomes and the observation window. Save that output with the execution date/commit if evidence is needed. Do not replace it with an inferred pass from source inspection.

## Deterministic native gates

The source fixture is newly created for this invocation. A separate admin connection holds `ACCESS EXCLUSIVE` on **that database's** `pg_catalog.pg_description`. The current manifest implementation reads structure/data but not comments. `pg_dump` reads the comment catalog and blocks. The harness requires `pg_stat_activity.application_name='pg_dump'`, `wait_event_type='Lock'`, the generated database/user, and `pg_blocking_pids()` containing the gate backend. A phase label or a sleep never qualifies as proof of native execution.

For restore, another connection holds `SHARE` on **the generated target database's** `pg_catalog.pg_class`. Read-only empty-target checks still proceed, while native table creation needs a conflicting catalog lock. The harness requires an actual blocked `pg_restore` backend and durable `restoring` phase before injection. The original seeded source and metadata databases are never catalog-locked, and no shared cluster catalog is locked. Gate sessions have a 120-second idle-in-transaction timeout as a fallback, and normal `finally` cleanup rolls them back explicitly.

Catalog access/locking is an implementation-sensitive technique. If the installed PostgreSQL native client follows a different catalog path, or catalog locking is refused, the bounded test fails before claiming native kill evidence. Do not substitute direct metadata status edits, a mocked worker, a large fixture with guessed timing, or a fake completed operation to make it pass.

## Limits and cleanup

- The restore is killed while a real native process waits to create its first table. It proves conservative interruption/reservation after restore execution begins; it **does not prove** recovery from committed partial writes. PostgreSQL restore currently uses one transaction, so this fixture expects rollback/empty catalog. MySQL/MariaDB partial-write interruption needs its own engine-specific case.
- There is no deterministic upload-stall injection, forced metadata network partition, worker-lock connection loss, native-child orphan test, or queue-delivery-before-domain-claim kill in this file. Those are separate acceptance gaps.
- The observation window does not cover the queue's full 7,500-second expiry. It proves restart quarantine and no immediate replay during the stated window, not that every future retry/failover state has been exercised.
- This harness uses REST for fault injection. Existing MCP recovery acceptance covers its own real pipeline; MCP/UI cancellation and interruption rendering still need their separate checks.
- New roles, source/target databases, plans, connections, jobs, events, blocks and artifacts are **retained**, including failures. It performs no `DROP`, volume reset, truncation, queue-row rewrite or history deletion. Generated prefixes and the final summary identify the resources.
- `finally` requests cancellation only for this invocation's unfinished jobs, releases owned gate sessions and starts the initially running worker if necessary. API/metadata/Docker outages can prevent full cleanup; such a failure must be reported, not masked as success. If the harness itself is forcibly killed, its PostgreSQL connections close and the gate timeout is a fallback, but the operator must restore the worker explicitly if it remains stopped.

Manual worker recovery, if needed, is scoped to the same local fixture checkout:

```sh
docker compose --file /Users/dobrota/dev/steelkeep/compose.yaml --project-name steelkeep --profile application up -d --no-deps --no-build --pull never worker
```

Never clear a target reservation or retry an interrupted restore simply to rerun this suite; the next invocation creates a fresh target.
