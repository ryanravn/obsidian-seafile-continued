# Seafile Sync

An [Obsidian](https://obsidian.md/) plugin for synchronizing notes across devices using [Seafile](https://www.seafile.com/), an open-source, self-hosted file sync and share solution.

This is a community continuation of [conql/obsidian-seafile](https://github.com/conql/obsidian-seafile) with additional features and fixes.

## What's different in this fork

- **Encrypted repositories** are supported (enc_version 2 and 4). Passphrase is prompted on repo selection and on Obsidian restart, never stored in plaintext.
- **Manual sync**: a "Sync now" button in settings and a "Seafile: Sync now" command (assignable to a hotkey) trigger an immediate sync without waiting for the interval tick.
- **Realtime sync** uses Seafile's notification server when available, with periodic synchronization retained as a fallback.
- **Sync progress** reports compact preparation, transfer, verification, metadata-publication, commit, and local-state counts in the file explorer and settings.

## Features

- Supports both desktop and mobile.
- Uses Seafile's internal syncing API for full synchronization (delta upload/download).
- Fast sync speed, performs well even on low-end Android phones.
- End-to-end encrypted libraries (v2 and v4).

## Usage

1. Open the plugin settings.
2. Enter the URL of your Seafile server and log in with your password, browser SSO, or a manually supplied API token. Manual-token login also asks for your account name so synchronized changes have the correct attribution.
3. Choose the repository you want to sync. If it's encrypted, enter the passphrase when prompted.
4. *Optional*: edit `seafile-ignore.txt` from the plugin settings or directly in the library root. It uses Seafile's standard ignore syntax and is shared with standard Seafile clients.
5. Click "Enable" to start syncing.
6. The plugin will now sync at the configured interval.

To trigger a sync immediately, click "Sync now" in the settings, or run "Seafile: Sync now" from the command palette (assign it a hotkey if you use it often).

Realtime sync is enabled by default. It connects to `<server>/notification`; a different notification-server URL can be entered in settings. The status row shows whether the WebSocket is connected or periodic synchronization is currently providing the fallback. The Seafile server must have its notification service enabled and exposed through the reverse proxy.

Per-file sync status and transfer progress are shown next to file names in the explorer. The text next to the sidebar sync button can be shown always, only during active synchronization (the default), or never; its complete hover tooltip is always retained. Development mode logs phase timings, transferred bytes, prepared-block reuse, and aggregate throughput to the developer console.

`seafile-ignore.txt` is created automatically when absent. Its rules prevent new matching local files from being uploaded; files already present on the server may still be downloaded, matching standard Seafile client behavior. The plugin installation and its device-specific synchronization database are always protected internally.

Downloads are written to a temporary file and verified before replacing an existing local file. If local and remote edits conflict, the local version is preserved as an `SFConflict` copy and synchronized alongside the remote version.

After a commit is published, changed local sync records are persisted with one batched journal append and one coalesced explorer refresh. Large journals are then compacted into the main sync database.

If the configured repository is deleted or access is revoked, synchronization and realtime notifications stop immediately. Local files are preserved while the user restores access or chooses another repository.

## Notes

1. **Use it at your own risk.** This plugin is still under development. There is a risk of data corruption or loss. Keep backups of anything important.
2. **Large files.** Desktop preparation, upload, and ordered download prefetching use bounded worker pools with up to four concurrent 8 MB blocks; mobile transfers use two while preparation remains serial. Desktop also retains at most 32 MB of prepared blocks to avoid duplicate reads, encryption, and hashing. Obsidian's mobile API still requires uploads to be read into memory as a complete file, so files larger than 50 MB trigger a warning and may remain slow or memory-intensive on mobile.
3. **Clear vault** if you hit issues. The action removes all local files and resyncs from the server.
4. **Don't interrupt syncing**, especially during upload (upload icon shown). Closing Obsidian mid-sync can corrupt data on the server.
5. **Hidden files** (anything starting with a dot, e.g. `.obsidian`) are not tracked continuously due to API limits. They are only updated at plugin startup.

## Contribution & Support

Open a [GitHub issue](https://github.com/ryanravn/obsidian-seafile-continued/issues) for bugs, feature requests, or questions.

## Credits

Original plugin by [@conql](https://github.com/conql). This continuation maintained by [@ryanravn](https://github.com/ryanravn).
