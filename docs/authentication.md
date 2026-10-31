# Owner authentication

The first screen creates the installation's owner account with a name, email and password (12–128 characters). Email is normalized; password whitespace and Unicode are preserved. The database migration creates no owner or default password.

An unclaimed installation requires its private setup key from `.steelkeep/token`. An already verified installation session supplies that proof automatically. This prevents someone else from claiming an existing installation simply because its owner-account table is empty. The setup key is needed once; daily browser sign-in uses email and password.

Passwords use Argon2id. Browser cookies contain a random opaque session identifier; metadata stores only its SHA-256 hash. Sessions expire after seven days and use `HttpOnly`, `SameSite=Strict`, and `Secure` when configured for HTTPS. Logout revokes the current session. Configuration → Your account changes the password after checking the current password and signs out owner browser sessions. Legacy raw bearer cookies are refused after the account is claimed. There is no public signup, email-reset service, OAuth or two-factor flow in this slice.

Installation/API/agent bearer tokens remain separate credentials. Scoped browser exchanges retain their issuer's live scopes, expiry and revocation; an actor name cannot confer ownership. Changing an owner password does not rotate independent API keys. Keep the installation key private alongside the encryption-key recovery material.

First-owner creation is serialized and supports only one account. Incorrect credentials have a generic response, password hashing has bounded concurrency, and sign-in attempts are rate-limited. Owner setup, login, logout and password changes have sanitized audit entries. REST, UI and MCP share the same permission enforcement.

## Checked locally

- Dedicated PostgreSQL metadata: setup refusal without ownership, concurrent owner claims, Argon2id storage, opaque session hashes, logout/password revocation and live agent/file-token scope revocation passed.
- A separate real Vite/Bun browser fixture completed setup, wrong-password handling, daily login, logout, password change and a new login; six sections and mobile light/dark states passed. Main installation ownership was not claimed by a test.
- The preview uses the existing Vite server and source-mounted API. These checks install or build no Docker image. Current packaged images predate owner authentication.
