# Security

Steelkeep is alpha software. Only the exact documented engine profiles have bounded recovery evidence; no general production certification is claimed.

Please report vulnerabilities privately through the repository maintainer's private security reporting channel when enabled. If that channel is unavailable, contact the maintainer privately before sharing details. Never include working credentials, database contents, private setup links or full connection strings in a public issue.

For a useful report, include the affected revision, engine/tool versions, reproduction using synthetic data and expected impact. Avoid testing destructive actions on a real database. An unknown restore or source-lock outcome must stay reserved for operator reconciliation.

Keep installation keys, metadata credentials, database volumes and archives outside the repository. Backup connection credentials are authenticated-encrypted in metadata; archive encryption is a separate storage configuration. Protect the encryption key and an independent recovery copy. Native dump/read-lock privileges and owner credentials should never be shared with untrusted agents.
