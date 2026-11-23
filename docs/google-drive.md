# Google Drive

Steelkeep's native Drive integration has two roles:

- **A backup source:** capture a selected Drive folder into an encrypted file archive,
  stored in S3 or a separate Drive folder.
- **Archive storage:** keep database or file backups in a Drive folder, download them,
  and import them into another Steelkeep installation for reviewed recovery.

The connector uses Drive API v3 directly. No rclone daemon, mounted filesystem or
Google account password is required. Each connection has an explicit purpose and
OAuth grant; routine token refresh does not change a reviewed archive's identity.

## One-time server setup

Use your own Google Cloud project and enable Google Drive API. Create an OAuth
client of type **Web application**. For a Workspace deployment used only within
your organization, configure the appropriate internal audience; other deployments
must follow Google's verification requirements for their audience and scopes.

Register this exact authorized redirect URI, substituting your installation origin:

```text
https://backup.example.com/api/v1/google-drive/oauth/callback
```

Store the client-secret value in `.steelkeep/google-client-secret`, owned by the
service user with mode `0600`. Use a private editor or password manager; do not put
it in a command argument, issue, Git commit or chat. Existing self-host Compose
mounts this private directory read-only into web and worker.

Add to the private `.env`:

```dotenv
STEELKEEP_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
STEELKEEP_GOOGLE_CLIENT_SECRET_FILE=/run/steelkeep/google-client-secret
STEELKEEP_GOOGLE_REDIRECT_URI=https://backup.example.com/api/v1/google-drive/oauth/callback
```

The origin must also be in `STEELKEEP_ALLOWED_ORIGINS`. Apply the additive database
migration and restart web/worker with this configuration in your normal deployment
procedure. No Google connection is enabled merely by installing the code.

## Connect an account and folder

Open **Connections → Google Drive** as the owner. Choose the intended use and press
the Google authorization button. After the callback, confirm the account grant in
Steelkeep, name the connection and choose a folder.

| Purpose | Access | Folder |
| --- | --- | --- |
| Back up Drive files | `drive.readonly` | Existing selected My Drive folder |
| Store new backups | `drive.file` | A new Steelkeep folder, or an already app-accessible folder |
| Restore Drive files | `drive.file` | Separate empty Steelkeep folder |
| Recover existing archives | `drive.readonly` | Existing archive folder, including files created by another OAuth project |

`drive.file` covers app-created or individually authorized files; pasting an arbitrary
folder ID does not grant access. The new-folder action avoids requiring broad write
access. Read-only recovery connections cannot receive new backups. A Drive archive
folder must be outside the selected Drive source tree to prevent recursive capture.

Source and storage connections use the ordinary plans, manual jobs and timezone
schedules. Credentials are sealed in separate OAuth-grant records; reconnect-required
errors stop operations instead of retrying forever. Only an owner can connect or
disconnect Google accounts. Existing scoped API/MCP permissions still govern jobs.

## Recover on another server

Every newly published Drive backup has two files in the storage folder:

1. The native archive (`.dump`, `.sql`, `.bacpac`, etc.) or encrypted Drive-file
   archive (`.skdrive`).
2. A `.recovery.json` descriptor with format, engine/tool versions, archive ID,
   validation manifest, exact size and SHA-256. It contains no database credentials.

Keep both. The archive is verified against Google's content checksum, or by a full
download/hash when that checksum is unavailable. Descriptor contents are checked too.
File names and metadata properties alone do not prove content integrity.

On the replacement server:

1. Install Steelkeep and the native tool profile required by the archive's engine.
2. Connect Google using **Recover existing archives** and select the old archive folder.
   A new OAuth project can use this read-only path; it need not impersonate the old app.
3. Browse the catalog, explicitly acknowledge that you trust this storage, and import
   the selected archive. Steelkeep downloads the entire archive and checks size/SHA
   before adopting its metadata. Importing does not write any restore destination.
4. Add a separate empty database or Drive restore folder. Prepare and confirm the
   ordinary restore review. Native data/file validation follows the actual write.

The original Steelkeep metadata database and source credentials are not required to
import the portable archive. Imported source identities are offline records, not
new live backup connections. Unknown restore outcomes retain their target reservation.

For database-native archives, a download also remains usable with the corresponding
native tools outside Steelkeep, subject to that engine's version requirements.

## Save the Drive-file recovery key

Drive-file `.skdrive` archives use streaming AES-256-GCM. File names, inventory and
payload are encrypted. The owner can explicitly download a dedicated 32-byte Drive
recovery key from the connector panel. This exports a derived archive key, not the
installation's metadata master key. Keep it separately from the archive folder.

On a replacement installation, privately mount the saved key and set:

```dotenv
STEELKEEP_DRIVE_RECOVERY_KEY_FILE=/run/steelkeep/drive-recovery.key
```

This key is needed for old `.skdrive` files. Losing both the original installation
key material and the exported Drive recovery key makes those encrypted files
unrecoverable. Database-native archives keep their existing native format and
encryption behavior; the Drive connector does not claim to encrypt all engine dumps.

## Initial file profile and limits

- My Drive folders; Shared Drives require a separately qualified profile.
- Ordinary files, folder hierarchy, duplicate names and empty files; up to 1,000
  entries, 32 levels and the existing 2 GiB archive ceiling.
- Docs, Sheets and Slides are exported as DOCX, XLSX and PPTX. They restore as
  portable files, not as a complete recreation of Google-native editor state.
- Google export endpoints impose a 10 MB exported-document limit. Unsupported
  Workspace types and shortcuts fail explicitly; content is never silently omitted.
- Permissions, comments, revision history and original Google file IDs are not
  recreated. Restored files receive new IDs in the designated empty target.
- Drive has no atomic tree snapshot. Steelkeep checks versions around each capture
  and repeats the inventory before publication, refusing observed changes. This
  does not establish a database-style point-in-time snapshot.
- Allow temporary disk space for the encrypted archive and a private capture or
  authenticated plaintext copy, potentially about twice the archive size plus reserve.

## Retention and disconnecting

Drive storage currently keeps all archives. Automatic and reviewed conditional
deletion are refused because the provider has not been qualified for the same
identity-fenced delete used by S3. Removing a Drive file manually affects availability;
it does not erase Steelkeep's operation history. Do not remove recovery descriptors
from copies you want to use on another installation.

Disconnecting erases local OAuth credentials first and attempts Google revocation.
It does not delete files or archives. Google's revocation may affect other grants
issued through the same OAuth client; reconnect affected accounts explicitly.

## Google requirements and primary documentation

Google explicitly permits automatic backup of users' Drive files. Its terms require
express prior written consent for backing up app/project content into Drive. Operators
must arrange applicable authorization for their intended use; a paid Workspace
subscription is not represented here as a waiver. See [Drive API terms](https://developers.google.com/workspace/drive/api/terms)
and [Workspace data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy).

Full existing-folder reading requires restricted `drive.readonly`; app-created file
access uses `drive.file`. Public OAuth deployments may require verification and a
security assessment; Google documents personal/internal/testing exceptions. Configure
an accurate privacy policy and disclosure for your own installation and audience.

- [Scopes and least privilege](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Server-side OAuth and offline access](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Restricted scope verification and exceptions](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Downloads and Workspace exports](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [Current quotas](https://developers.google.com/workspace/drive/api/guides/limits)

## Qualification

Implementation and synthetic tests must be checked on the exact source revision.
Mocked Google responses and local archive cycles do not establish a live Workspace
OAuth connection or recovery. No production Google account is contacted by default
tests. Record actual remote test results and any live isolated Drive proof separately.
