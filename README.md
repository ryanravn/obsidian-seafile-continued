# Seafile Sync

An [Obsidian](https://obsidian.md/) plugin for synchronizing notes across devices using [Seafile](https://www.seafile.com/), an open-source, self-hosted file sync and share solution.

## Fork status

This repository is a maintained fork of [ryanravn/obsidian-seafile-continued](https://github.com/ryanravn/obsidian-seafile-continued), which is itself a community continuation of [conql/obsidian-seafile](https://github.com/conql/obsidian-seafile).

We intend to contribute generally useful fixes and features back upstream. Until those changes are accepted, this fork maintains and releases them independently. If a change does not fit upstream's direction, we will continue maintaining it here rather than removing it from the fork.

## What's different in this fork

Compared with upstream release `0.3.22`, this fork currently adds:

- **Realtime synchronization** through Seafile's notification server, with automatic fallback to periodic synchronization and connection state shown in the UI.
- **Manual API-token authentication** for setups where password or browser-SSO login is not appropriate.
- **Standard Seafile ignore rules** through an editable `seafile-ignore.txt`, shared with official Seafile clients instead of using plugin-specific ignore configuration.
- **Safer synchronization**, including upload-object verification before publishing a commit, verified temporary downloads, preserved conflict copies, retry reporting, and explicit handling of deleted or inaccessible repositories without deleting the local vault.
- **Faster large synchronizations** through bounded parallel block transfers, download prefetching, batched remote-object checks and local metadata updates, prepared-block reuse, and reduced finalization overhead.
- **More useful sync feedback** with file-count progress across preparation, transfer, verification, publication, commit, and local-state phases, plus configurable sidebar status text and detailed hover status.
- **Guided new-device onboarding** that walks through the server, account, remote library, and initial synchronization without requiring a preconfigured vault.
- **Hardened development automation** with pull-request CI, reproducible npm installs, tested release preparation, version consistency checks, artifact attestations, and immutable tag-based releases.

## Features

- Supports both desktop and mobile.
- Uses Seafile's internal syncing API for full synchronization (delta upload/download).
- Fast sync speed, performs well even on low-end Android phones.
- End-to-end encrypted libraries (v2 and v4).

## Install and initialize a new device

The recommended setup uses the [Obsidian community plugin marketplace](https://community.obsidian.md/plugins/seafile-improved):

1. Create and open a new empty Obsidian vault.
2. Open **Settings → Community plugins**, install **Seafile Sync Improved**, and enable it.
3. Open the plugin settings and follow **Initialize from remote**.
4. Enter the Seafile server URL and log in with your password, browser SSO, or a manually supplied API token.
5. Choose the existing remote library, unlock it if it is encrypted, and select **Start initial sync**.

The initial synchronization downloads the remote library. If the local vault is not empty, its existing files are merged and may be uploaded; start with an empty vault unless that merge is intentional.

Each GitHub release also includes `seafile-improved-vault-<version>.zip`. It is an optional ready-to-open empty vault with the plugin already installed and enabled. Extract it, open the contained **Seafile Sync Improved** folder as an Obsidian vault, allow community plugins if Obsidian asks, and then follow **Initialize from remote**. The template contains no credentials, repository selection, sync state, workspace state, or notes.

## Configuration

After onboarding, the individual server, account, repository, and sync controls remain available in the plugin settings. Manual-token login asks for your account name so synchronized changes have the correct attribution. You can optionally edit `seafile-ignore.txt` from the plugin settings or directly in the library root; it uses Seafile's standard ignore syntax and is shared with standard Seafile clients.

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

Open an issue in [this fork](https://github.com/tionis/obsidian-seafile-improved/issues) for bugs, feature requests, or questions about the functionality described above. Issues that also affect the upstream version may eventually be forwarded or proposed upstream.

### Preparing a release

Start from a clean working tree and run one of:

```sh
npm run release:prepare -- patch
npm run release:prepare -- minor
npm run release:prepare -- major
npm run release:prepare -- 0.4.0
```

The command updates `package.json`, `package-lock.json`, `manifest.json`, and `versions.json`, then runs the credential-free tests and production build. Review and commit those changes before creating and pushing a tag with the exact same version. The tag triggers the release workflow, which builds and attests the plugin files and ready-to-use vault ZIP; existing tags and releases are never replaced.

## Credits

Original plugin by [@conql](https://github.com/conql). The continued version was created and is maintained upstream by [@ryanravn](https://github.com/ryanravn). This fork is maintained by [@tionis](https://github.com/tionis).
