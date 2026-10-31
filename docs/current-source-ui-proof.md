# Current-source UI and scoped-agent proof

31 October 2026. This is current development-source evidence, not a rebuilt immutable package.

The isolated installation used the existing ARM64 worker image `ed6ac2132f62451299ed661eca043592883431fa11b42ecb5cc62e19cdacce99`, current read-only `server`/`shared` mounts, its own encryption/setup keys, metadata database `steelkeep_ui_proof`, API port 4322 and Vite port 4321. Both containers joined only the existing synthetic fixture network. They never used the main owner or metadata database.

## Native UI recovery

One Playwright scenario passed in **16.9 seconds**. It created a synthetic owner through the real one-time setup link, entered database/storage credentials through the current forms, created a manual plan, ran a native PostgreSQL backup, downloaded its actual S3 object and checked SHA-256/PGDMP, then reviewed and executed a restore into a separate precreated empty target.

The source `ui-postgres-src-6fd82ff89715` and destination `123ui_pg_dst_6fd82ff89715` exercise the newly accepted database-name subset. Independent SQL verified 1,000 rows, sum `625625.00`, Unicode/binary values, a dropped source column, restored sequence/identity behavior and FK/CHECK enforcement. The source totals and sequence remained unchanged. The UI displayed separate HEAD-only availability and successful restore validation.

- Backup: `2d508e46-c9c5-4793-bfb2-26003715ac46`
- Artifact: `e3dbf6bb-bc91-449c-b427-081e7e7be570`
- Restore: `f256ec46-da3a-4a1d-9185-b0e1012f80cd`

## Scoped AI agent through MCP

A second native backup through the official MCP client passed **34 assertions in 2.01 seconds**. The named agent had only `read` and `backup:run`; a configure command was refused without creating a plan. Reusing its request key returned the same job. Independent S3 GET verified 13,664 bytes and SHA-256 `9b05c94163b52ff854ab81fc854fabcd3c6ec7dce45a3bb6ad75002227b65f0b`; the source still contained the same 1,000 rows and totals. MCP returned the earlier restore's protected-target record. Token and agent revocation produced both HTTP and MCP 401 while retaining the completed backup.

- Backup: `80d5e454-a54d-4407-b4b0-5222a089db66`
- Artifact: `47bf804b-9615-44df-9cd5-d5f04614139a`

## Protection UI and boundaries

A separate read-only browser check passed nine assertions against the actual protected destination: desktop 1440px, mobile 390px, no horizontal document overflow or page errors, correct owning-job navigation and displayed validation. Source-hold/target-reservation REST/MCP projections passed 42 dedicated metadata assertions; their temporary database was removed after guards.

The ordinary database-name subset now accepts leading digits and internal hyphens, up to 63 ASCII characters. Connection-string overrides, leading options, namespace patterns and SQL syntax remain refused. Schema/table/column/disk identifiers stay under their stricter validator. Other engines' new name variants have focused code tests, not new native runtime qualification. Unicode, spaces and broader engine-specific name alphabets remain unsupported.

## Reproduction and cleanup

The proof is deliberately a fresh, explicitly opted-in fixture. `scripts/prepare-ui-proof.ts` refuses occupied proof ports, existing private files or an existing proof database; it never resets data automatically.

```sh
bun scripts/prepare-ui-proof.ts
docker compose -f compose.ui-proof.yaml up -d --no-build --pull never api worker
STEELKEEP_DEV_API_PORT=4322 bun run vite --host 127.0.0.1 --port 4321 --strictPort
```

In another terminal, after readiness:

```sh
STEELKEEP_ACCEPTANCE=synthetic-ui-firstbackup DATABASE_URL=postgres://steelkeep:local-metadata-only@127.0.0.1:54371/steelkeep_ui_proof ./node_modules/.bin/playwright test
STEELKEEP_ACCEPTANCE=synthetic-ui-scoped-agent DATABASE_URL=postgres://steelkeep:local-metadata-only@127.0.0.1:54371/steelkeep_ui_proof bun test acceptance/scoped-agent-native.test.ts
```

The harness checks exact container identity, image, mounts, environment, loopback ports and metadata ownership before mutation. It disables traces/video/HAR, uses private in-memory secret bindings and writes public evidence IDs to private `native-ui-result.json` / `scoped-agent-result.json`. Existing result files refuse accidental repetition.

After verifying zero active jobs and scheduled plans, root stopped and removed only `steelkeep-ui-proof-api` / `steelkeep-ui-proof-worker`, and stopped the exact owned Vite process on 4321. No image was built or pulled; BuildKit remained 0 B. The dedicated metadata was about 9.5 MB. Synthetic source/target databases, artifacts and private keys/evidence were retained. The main preview remained on 4310/4311.

Do not weaken these guards or delete retained archives to rerun. Inspect and deliberately prepare a fresh proof boundary. This checkpoint does not qualify every engine/version, crash/partial-write boundary, remote PostgreSQL TLS or SQL Server runtime.
