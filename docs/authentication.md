# Owner authentication

An unclaimed installation opens a private one-time setup link generated with `bun run setup:owner`, then creates the owner account with a name, email and password (12–128 characters). An existing account opens email/password sign-in directly. The setup screens also offer a sign-in link. Email is normalized; password whitespace and Unicode are preserved. The database migration creates no owner or default password.

The local setup helper uses the private installation key from `.steelkeep/token` without putting it in the URL. The generated capability expires in five minutes, is stored only as a hash and is consumed atomically once. Its temporary HttpOnly setup cookie has no workspace scopes. The fragment is removed before the browser submits the code as JSON. A raw capability cookie cannot bypass redemption. A separate manual-key form remains available as a fallback.

An unclaimed installation requires proof from its private setup key. An already verified installation session supplies that proof automatically. This prevents someone else from claiming an existing installation simply because its owner-account table is empty. The setup key is needed once; daily browser sign-in uses email and password.

Passwords use Argon2id. Browser cookies contain a random opaque session identifier; metadata stores only its SHA-256 hash. Sessions expire after seven days and use `HttpOnly`, `SameSite=Strict`, and `Secure` when configured for HTTPS. Logout revokes the current session. Configuration → Your account changes the password after checking the current password and signs out owner browser sessions. Legacy raw bearer cookies are refused after the account is claimed. There is no public signup, email-reset service, OAuth or two-factor flow in this slice.

Installation/API/agent bearer tokens remain separate credentials. Scoped browser exchanges retain their issuer's live scopes, expiry and revocation; an actor name cannot confer ownership. Changing an owner password does not rotate independent API keys. Keep the installation key private alongside the encryption-key recovery material.

First-owner creation is serialized and supports only one account. Incorrect credentials have a generic response, password hashing has bounded concurrency, and sign-in attempts are rate-limited. Owner setup, login, logout and password changes have sanitized audit entries. REST, UI and MCP share the same permission enforcement.

## Checked locally

- Dedicated PostgreSQL metadata: setup refusal without ownership, concurrent owner claims, Argon2id storage, opaque session hashes, logout/password revocation and live agent/file-token scope revocation passed.
- A separate real Vite/Bun browser fixture completed setup, wrong-password handling, daily login, logout, password change and a new login; six sections and mobile light/dark states passed. Main installation ownership was not claimed by a test.
- The preview uses the existing Vite server and source-mounted API. These checks install or build no Docker image. Current packaged images predate owner authentication.

31 October layout update: the supplied original PNG lockup keeps the mark and lettering in one row. The form and footnote share a centered stage with symmetric desktop padding; light/dark appearance uses one icon button. The longest normal setup screen fits 1280×720 and 1366×768 without page or nested scrolling. Short screens retain natural page scrolling rather than clipping fields or errors.

The latest real isolated auth fixture passed 1 test / 44 assertions in 5.29s; its synthetic metadata database was removed after identity, empty backup-data and active-client checks. Separate browser layout checks cover claim/setup/sign-in, both themes and five viewport sizes (30 cases); those checks substitute only auth-status responses to render each state and do not establish server authentication. TypeScript checks and the unit group passed (32 tests / 216 assertions).

The one-time setup-link backend passed 1 dedicated metadata test / 82 assertions: real-bearer-only issuance, hash-only storage, zero workspace scopes, expiry, replay/concurrent redemption, raw capability-cookie refusal, installation-key rotation, existing-owner refusal and sanitized audit. The two local helper tests add 30 assertions for origin checks, no key disclosure, existing-owner handling and redirect refusal. Its dedicated test database was removed after synthetic identity/data/client checks.
