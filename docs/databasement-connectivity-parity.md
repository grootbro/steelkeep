# Databasement connectivity and execution parity

Source review: 23 November 2026. This is an implementation proposal, not a claim
that SSH transport or remote execution workers are implemented or deployed.

The earlier local reference checkout is no longer present. The source below was
read directly through GitHub at upstream commit
[`a9a4b253967168b57033a2a45450420c0c0c20fd`](https://github.com/David-Crty/databasement/tree/a9a4b253967168b57033a2a45450420c0c0c20fd).
Steelkeep's existing interface attribution remains pinned to
`e7535032de8570f97b982c857b809caa7f1f4a24`. The SSH service/model, agent controller,
job model and payload builder are unchanged between those commits; the agent runner
and agent guide have changed. Comparisons below use the newer inspected source.

No upstream application was installed or executed. No application, deployment,
credentials or network settings were changed for this review. Existing MIT
attribution must remain if implementation material is adapted; no Salt.md code is involved.

## What the reference actually implements

| Capability | Source evidence | Behavior |
| --- | --- | --- |
| Direct database connections | [Database connection DTO](https://github.com/David-Crty/databasement/blob/a9a4b253967168b57033a2a45450420c0c0c20fd/app/Services/Backup/DTO/DatabaseConnectionConfig.php) | A database has host, port, credentials, engine-specific options and optional SSH configuration. Native tools run where the job executes. |
| Reusable SSH configurations | [SSH model](https://github.com/David-Crty/databasement/blob/a9a4b253967168b57033a2a45450420c0c0c20fd/app/Models/DatabaseServerSshConfig.php), [request validation](https://github.com/David-Crty/databasement/blob/a9a4b253967168b57033a2a45450420c0c0c20fd/app/Http/Requests/Api/V1/SaveDatabaseServerSshConfigRequest.php), [guide](https://github.com/David-Crty/databasement/blob/a9a4b253967168b57033a2a45450420c0c0c20fd/docs/docs/user-guide/ssh-tunnel.md) | Password or key authentication, optional key passphrase, generated Ed25519 keys, optional compression, write-only credentials and reuse across database servers. Attached configurations cannot be deleted. |
| SSH probes and tunnel lifetime | [Tunnel service](https://github.com/David-Crty/databasement/blob/a9a4b253967168b57033a2a45450420c0c0c20fd/app/Services/SshTunnelService.php), [shared tunnel concern](https://github.com/David-Crty/databasement/blob/a9a4b253967168b57033a2a45450420c0c0c20fd/app/Services/Backup/Concerns/UsesSshTunnel.php) | Starts an SSH forwarding process for an operation, supplies a loopback endpoint to database clients, and closes it afterwards. Separate SSH authentication test and database connection test are available. |
| Tunnel configuration UI | [SSH section](https://github.com/David-Crty/databasement/blob/a9a4b253967168b57033a2a45450420c0c0c20fd/resources/views/livewire/database-server/_ssh-tunnel-config.blade.php) | Direct choice of existing/new SSH configuration, host/port/user, authentication, generated public-key handoff and an explicit Test SSH action. |
| Outbound execution agents | [Agent guide](https://github.com/David-Crty/databasement/blob/a9a4b253967168b57033a2a45450420c0c0c20fd/docs/docs/user-guide/agents.md), [runner](https://github.com/David-Crty/databasement/blob/a9a4b253967168b57033a2a45450420c0c0c20fd/app/Console/Commands/AgentRunCommand.php) | Agent runs beside private databases and polls over outbound HTTPS. It claims assigned work, runs tools locally, transfers archives directly to reachable storage and reports results. It does not connect to the control-plane metadata database. |
| Placement and job protocol | [Agent controller](https://github.com/David-Crty/databasement/blob/a9a4b253967168b57033a2a45450420c0c0c20fd/app/Http/Controllers/Api/V1/AgentController.php#L78), [job model](https://github.com/David-Crty/databasement/blob/a9a4b253967168b57033a2a45450420c0c0c20fd/app/Models/AgentJob.php), [payload builder](https://github.com/David-Crty/databasement/blob/a9a4b253967168b57033a2a45450420c0c0c20fd/app/Services/Agent/AgentJobPayloadBuilder.php) | Claims filter by database-server agent affinity and supported job types. Claims/leases are recorded transactionally. Payloads are encrypted at rest; claimed work contains the execution configuration. Backup, discovery, restore and cleanup are separate job types. |
| Agent state and compatibility | [Agent model](https://github.com/David-Crty/databasement/blob/a9a4b253967168b57033a2a45450420c0c0c20fd/app/Models/Agent.php), [connection status](https://github.com/David-Crty/databasement/blob/a9a4b253967168b57033a2a45450420c0c0c20fd/app/Livewire/DatabaseServer/ConnectionStatus.php) | Agent heartbeat drives online/offline/never state; version/commit are tracked. An agent-backed database's displayed connection state comes from agent liveness, which is not itself a database probe. |

The reference guide recommends direct connectivity or SSH when available; the
distinct benefit of a remote execution agent is operation with no inbound access.
Agent-side storage must be reachable from that agent. Its documented restore
behavior can replace a database; Steelkeep must retain its own separate-empty-target
policy rather than transplanting that behavior.

## Current Steelkeep boundaries

| Surface | Existing implementation | Gap |
| --- | --- | --- |
| Database connectivity | [Connection contracts](../server/contracts.ts), [services](../server/services.ts), [engine adapters](../server/engines/index.ts) accept exact allowlisted remote hosts and engine-specific credentials/TLS. | Reachable remote databases already work through direct network connections. No saved SSH host, tunnel or execution placement exists. |
| Connection probe | `Services.probeConnection()` runs an adapter connection from the API process; `testConnection()` records availability only if the connection revision is still current. | It does not establish worker liveness, worker network access or every native backup privilege. Keep those observations distinct. |
| Worker ownership | [Worker](../server/worker.ts) uses one installation-wide PostgreSQL advisory lock, worker epoch and per-run execution tokens. Loss of its ownership connection aborts native work. | There is one local execution owner, not a fleet. Adding a second process with the same metadata connection is deliberately refused. |
| Liveness | Per-run `heartbeat_at` is updated while work executes. `worker_state` stores an epoch and start time. `/health` confirms the web process. | An idle worker has no periodic liveness observation, and public web health does not show whether queued operations can execute. |
| Native execution | [Process runner](../server/process.ts) uses an explicit executable allowlist, argv, sanitized environment, private credential files, bounded output, resource limits and process-group termination. | No SSH supervisor exists. Do not add arbitrary remote commands or user-supplied executables to this mechanism. |
| Recovery | [Restore](../server/restore.ts), [resources](../server/resources.ts), [source locks](../server/source-locks.ts) bind identity, permissions, source/target separation, checksum and durable reservations. | Transport and remote-worker changes must preserve the original resource identity and uncertain-outcome quarantine. |
| AI access | [AI agents](../server/agents.ts), [authentication](../server/auth.ts), [MCP](../server/mcp.ts) provide scoped automation identities. | These agents call application commands. They do not execute native tools remotely or provide worker heartbeat/placement. |

## Recommended sequence

### P0: expose the actual local worker and truthful probe results

This is the next small complete slice after the current Drive deployment checkpoint.
It does not change scheduling, operation ownership or engine behavior.

- Add a nullable worker heartbeat timestamp in a new metadata migration. Update it
  periodically only while the worker retains its current epoch/ownership connection.
  Keep existing interruption and process-abort behavior on lock loss.
- Add an authenticated read-only worker-status service shared by REST and MCP.
  Report server observation time, last heartbeat/start time and a bounded status
  such as never/online/stale/unknown. An old row with no heartbeat is unknown, not
  evidence of a healthy worker. Do not expose epoch or execution tokens.
- Show worker status beside queued operations and in Configuration. A green web
  health response must not imply a running executor.
- Keep connection checks revision-safe. Identify their observation location as
  the API/control plane; include a sanitized failure code where available. Do not
  invent DNS/TLS/permission stage success from a generic driver error.

Files to touch after authorization: `server/migrate.ts`, `server/db.ts`,
`server/worker.ts`, a small worker-status service/contracts module,
`server/app.ts`, `server/mcp.ts`, and one scoped UI component mounted from
`src/workspace.tsx`/Configuration. Existing connection-test contracts and callers
need updates only if the response receives new optional observation fields.

Qualification: controlled heartbeat freshness/clock boundaries, absent/legacy rows,
epoch-fenced updates and read-scope enforcement using disposable PostgreSQL;
desktop/mobile status rendering; a worker stop/start proof on an isolated stand.
No native database matrix needs repeating for this observation-only slice.

### P1: one complete, narrowly qualified SSH profile

Start with PostgreSQL direct-versus-SSH transport. Add other engines after their
driver and native-client TLS behavior is qualified. SQLite and cloud-file sources
do not acquire a generic database tunnel option.

Proposed files: a dedicated `server/ssh/` configuration/transport module,
`server/migrate.ts`, `server/db.ts`, shared connection contracts, connection
services/history, `server/engines/types.ts`, PostgreSQL driver/native credential
construction in `server/engines/database.ts`, probe/backup/restore session creation,
REST/MCP and `src/forms.tsx`/connection-profile UI. An optional worker toolchain
profile may need the OpenSSH client; avoid rebuilding images for ordinary UI edits.

Required behavior:

1. Store named reusable SSH configurations with encrypted write-only credentials,
   explicit revision and pinned server host-key identity. Referenced configurations
   cannot be removed; active jobs and uncertain source/target state block rotation.
   Credential changes invalidate affected checks and restore reviews deliberately.
2. Validate bastion host/port/user and inner database host/port separately. A
   tunnel is an authorized route to a selected database, not unrestricted access
   to other services on the bastion's network. No arbitrary ProxyCommand, shell
   snippet, dynamic SOCKS listener or forwarded authentication agent.
3. Spawn only owned SSH processes using argv and an explicit configuration.
   Bind the forwarding listener to loopback, bound connection time, require
   forwarding setup to succeed, monitor the child and close it in every outcome.
   Cancellation and SSH death must stop dependent database work promptly.
4. Keep private keys/known-host material in an owner-only temporary directory
   with regular 0600 files; remove only those owned temporary resources. Do not
   put passwords, key passphrases, connection strings or raw stderr in argv/logs.
5. Preserve the configured database's identity and TLS peer name. The dial
   address may become loopback, but restore identity/fingerprints must never
   become an ephemeral forwarding port. A database certificate for its original
   hostname must still be checked; do not silently disable TLS verification.
6. Probe, manifest, native dump/restore and final validation use the same transport
   settings. SSH authentication success, forwarded database reachability and native
   backup permissions have separate labels and timestamps.

Reference implementation choices are not all defaults to copy. Its SSH service uses
`StrictHostKeyChecking=accept-new`; Steelkeep should use an explicitly pinned host
key and refuse unknown/changed keys. OpenSSH documents the configuration and
forwarding controls in [ssh_config](https://man.openbsd.org/ssh_config.5) and
[ssh](https://man.openbsd.org/ssh.1). PostgreSQL's separate host/address semantics
are documented in [libpq connection parameters](https://www.postgresql.org/docs/17/libpq-connect.html).

Qualification: synthetic SSH host and PostgreSQL with a known host key and verified
TLS peer; real backup/upload/download/restore; independent data verification;
wrong/changed host key, rejected authentication, blocked forwarding, TLS mismatch,
port collision, cancellation, SSH death and process cleanup. No uncertain restore
is replayed and no target is reset to make a test pass.

### P2: outbound execution workers as a separate trust boundary

Do not rename the existing AI-agent screen or deploy the metadata-connected worker
in another network and call it an outbound agent. A real remote worker needs:

- Separate execution-agent identities, hash-only revocable credentials, capability
  and version reporting, heartbeat and explicit source/target placement.
- An HTTPS poll/claim/report protocol with per-attempt lease/epoch fencing on every
  heartbeat, log chunk, completion and failure. An agent ID and running status alone
  are insufficient to identify the current attempt after reconnect/reclaim.
- Bounded, assigned-job-only execution payloads and credentials. Never distribute
  the installation encryption key, owner bearer, metadata database access or a full
  Google refresh grant. Define expiring access and secret rotation explicitly.
- Agent-side host/file-root allowlists, native-tool compatibility and storage
  reachability. SQLite paths and ClickHouse shared disks belong to the executor's
  machine; control-plane mounts cannot prove their safety.
- Read-only remote restore preflight bound to the selected executor, target identity,
  grant/config revisions and review deadline, followed by the existing explicit
  confirmation, checksum gate, reservation and no-replay guarantees.
- A single authoritative publication path that verifies the claimed artifact and
  operation ownership. Remote reports do not become optimistic snapshot success.
- An agent/queue state machine that treats lost backup and lost restore outcomes
  differently. Existing immutable backup retry rules and source-lock journals still
  apply; target writes always preserve uncertain recovery reservations.

Likely dedicated module/UI names: `execution-agents`, not the existing `/agents`
automation identity resource. Keep the local worker as the initial execution target.
This is a later platform slice requiring its own fault-injection and native recovery
proofs; it is not included in the proposed P0 observation changes.
