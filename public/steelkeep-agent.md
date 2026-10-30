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
