# Server installation

Use the [README self-host instructions](../README.md#self-host) for a new installation.
Run setup as the intended non-root service owner and keep private configuration
outside Git. The default Compose stack supplies PostgreSQL metadata; supply a
separate S3-compatible bucket and provision the native tools for your engine profile.

## Network and credentials

- Set exact database and storage hostnames in `STEELKEEP_ALLOWED_HOSTS`.
- Bind the application to loopback behind an HTTPS reverse proxy. Preserve Host
  and streaming responses; configure the exact public host/origin and secure cookies.
- Keep metadata, archive services and native fixtures off public ports.
- Preserve `.steelkeep` permissions and an independent protected encryption-key
  copy. Existing metadata volumes must retain their original password and key.
- Generate a private five-minute owner setup link only when ready to use it. Do
  not put the link, installation key or credentials in logs, issues or documentation.

## Runtime profiles

The eight adapters have different native tools, consistency requirements and
privileges. Follow [engine profiles](engine-profiles.md), [native tooling](native-tooling.md)
and the per-engine runtime guides before connecting a source. File-based engines
need explicit worker mounts and root allowlists. Optional SQL Server tooling requires
Linux x64 and the applicable Microsoft terms; the default worker does not include it.

The [server runtime ledger](server-runtime.md) records synthetic native qualification
of separately provisioned tool bundles. It does not certify a new Docker build,
every architecture, arbitrary database features or your installation.

## First operation and upgrades

Test both source and storage connections, create a manual plan, and inspect its
actual worker phases and resulting snapshot. Independently test recovery into a
separate empty destination before relying on backups. Archive metadata checks and
complete-byte verification are distinct results.

Allow disk space for native tools, worker scratch and the maximum archive size
(currently 2 GiB). Bound worker CPU/RAM, keep a host free-space reserve and prefer
independent offsite storage. A bucket on the database host is not an offsite copy.

Before upgrading, preserve metadata, encryption keys, archive access and the prior
release. Inspect active jobs and uncertain reservations. Never remove database or
archive volumes as part of routine cleanup. Validate the new source/package at its
actual revision, then verify HTTPS, sign-in, queue processing and a synthetic recovery.
