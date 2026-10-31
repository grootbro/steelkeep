# Steelkeep agent guide

Connect to this installation's `/mcp` endpoint using Streamable HTTP. Send the
scoped credential in `Authorization: Bearer <token>`, never in a URL or a prompt.
REST clients can inspect the authenticated OpenAPI document at `/openapi/json`.
No AI provider or model subscription is required by Steelkeep.

1. Call `get_capabilities` first. Respect the granted scopes and engine profile
   prerequisites. Implementation capability is not completed runtime acceptance.
2. Inspect connections, plans and existing operations before creating a new one.
   Database secrets cannot be read back. Do not send credentials to another host.
3. For a backup, choose an existing plan and generate one idempotency key. Reuse
   that same key after any ambiguous network result. A returned job means accepted,
   not completed. Poll `get_job` for worker-confirmed outcome and safe events.
4. For a restore, identify the exact artifact and a separate precreated empty
   destination. Prepare a restore review, show its source/target and warnings to
   the operator, then start that review with one stable idempotency key within
   its expiry. A review does not grant an agent permissions it does not hold.
5. Never restore into the source, metadata database, an occupied target or a
   target reserved by another operation. Never clear a target or source block,
   drop data or bypass a failed guard to make a retry pass.
6. Cancellation is cooperative. A server-side operation may still have written
   data. `interrupted` means the outcome is uncertain; keep reservations and ask
   the operator to reconcile before a new operation. Never automatically replay
   a restore after writes or blindly unlock a MongoDB source.
7. Report backup creation, archive SHA-256 verification and restored-data
   validation separately. An uploaded artifact is not proof of recoverability.
8. Request the least permissions and a short token lifetime. Revocation of an
   agent/token also revokes delegated descendants. Never persist a token in logs,
   shared documents, repository files or the conversation.

Tools and REST operations call the same application services. This guide is
workflow documentation; authorization and safety guards are enforced by Steelkeep.

For complete older history, use `browse_job_history`, `browse_snapshot_history`
and `get_backup`; the original list tools return bounded recent windows. Reuse
each opaque cursor with exactly the same filters and order.

Retention is opt-in. Preview candidates first; enabling or changing destructive
cleanup needs `configure`, `backup:delete`, the current policy revision and an
explicit permanent-deletion confirmation. Snapshot locks and restore reservations
remain authoritative. Never enable cleanup merely to complete setup or free space.

Notification inspection needs `read`; channel changes, real tests and retries need
`configure`. Send a test only when the operator requests an outbound message to
that configured destination. Provider acceptance does not mean recipient delivery.
An uncertain send must retain its identity and requires duplicate-risk confirmation
before an explicit retry. Use delivery details to report earlier attempt failures.

Archive downloads require the separate `backup:download` grant; ordinary `read`
access does not expose database contents. Existing agent tokens are not upgraded.
Use `get_backup_download` to obtain a relative authenticated path, filename,
recorded size and SHA-256. Fetch that path from this installation with the same
credential in its Authorization header. Never put a token in the URL or forward
it to a storage host. MCP does not return archive bytes or a presigned URL.

Download complete archives only; ranges/resume are unsupported. Size and the
complete SHA-256 must agree before the final block is sent. Discard an incomplete
or failed transfer and restart it. Independently compare the saved file's SHA-256
with the descriptor before using it. Downloads are not restore validation.
