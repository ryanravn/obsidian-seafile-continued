# Obsidian Seafile Sync

An [Obsidian](https://obsidian.md/) plugin for synchronizing notes across devices using [Seafile](https://www.seafile.com/), an open-source, self-hosted file sync and share solution.

## Fork status

This repository is a maintained fork of [ryanravn/obsidian-seafile-continued](https://github.com/ryanravn/obsidian-seafile-continued), which is itself a community continuation of [conql/obsidian-seafile](https://github.com/conql/obsidian-seafile).

We intend to contribute generally useful fixes and features back upstream. Until those changes are accepted, this fork maintains and releases them independently. If a change does not fit upstream's direction, we will continue maintaining it here rather than removing it from the fork.

## What's different in this fork

Compared with upstream release `0.3.22`, this fork currently adds:

- **Realtime synchronization** through Seafile's notification server, with automatic fallback to periodic synchronization and connection state shown in the UI.
- **Manual API-token authentication** for setups where password or browser-SSO login is not appropriate.
- **Standard Seafile ignore rules** through an editable `seafile-ignore.txt`, shared with official Seafile clients instead of using plugin-specific ignore configuration.
- **Obsidian-aware synchronization policies** with separate controls for main settings, appearance, hotkeys, core plugins, community-plugin activation, installation files, standard plugin settings, and additional plugin data, plus editable per-plugin overrides.
- **Safer automatic conflict merging** using the last synchronized version as a common ancestor. Independent Markdown and text edits, recursive settings-JSON changes, Canvas records, and Bases views are merged automatically; ambiguous changes still produce preserved conflict copies.
- **Safer synchronization**, including upload-object verification before publishing a commit, verified temporary downloads with per-file crash-recovery journals in private plugin storage, preserved conflict copies, mass-deletion confirmation, cross-platform path and permission preflight checks, retry reporting, and explicit handling of deleted or inaccessible repositories without deleting the local vault.
- **Faster large synchronizations** through bounded parallel block transfers, download prefetching, batched remote-object checks and local metadata updates, prepared-block reuse, and reduced finalization overhead.
- **More useful sync feedback** with file-count progress across preparation, transfer, verification, publication, commit, and local-state phases, plus configurable sidebar status text and detailed hover status.
- **Guided new-device onboarding** that walks through the server, account, remote library, and initial synchronization without requiring a preconfigured vault.
- **Integrated version history and recovery** with per-file diffs, grouped library activity, deleted-file recovery, whole-vault snapshot previews and restore, plus optional device-local offline checkpoints.
- **Built-in diagnostics and repair** with a persistent device-local sync-issues center, a read-only vault verification report, and a sync-index rebuild that preserves vault files.
- **Hardened development automation** with pull-request CI across Node.js 20 and 24, strict source linting, reproducible npm installs, tested release preparation, version consistency checks, artifact attestations, and immutable tag-based releases.

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

Each GitHub release also includes `obsidian-seafile-sync-vault-<version>.zip`. It is an optional ready-to-open empty vault with the plugin already installed and enabled. Extract it, open the contained **Obsidian Seafile Sync** folder as an Obsidian vault, allow community plugins if Obsidian asks, and then follow **Initialize from remote**. The template contains no credentials, repository selection, sync state, workspace state, or notes.

## Configuration

After onboarding, the individual server, account, repository, and sync controls remain available in the plugin settings. Manual-token login asks for your account name so synchronized changes have the correct attribution. Account tokens, repository tokens, and remembered encrypted-library passwords are stored with Obsidian SecretStorage and are removed from the plugin's `data.json` during migration.

Obsidian-aware settings separately control main configuration, appearance and snippets, hotkeys, core-plugin configuration, the active community-plugin list, community-plugin installation files, standard `data.json` settings, and additional plugin data. These library-wide selections are stored in the versioned `.obsidian-seafile-sync.json` file at the vault root so every Obsidian Seafile Sync device follows the same content policy. Existing installations seed that shared policy from their current settings when the library does not yet have one; devices joining an existing library adopt its policy. Per-plugin overrides can select `standard`, `all`, or `ignore` behavior where a plugin stores important user content or disposable runtime data outside `data.json`.

Smart conflict handling is enabled by default and remains a device-local preference. It performs bounded three-way merges using the last synchronized Seafile object as the common ancestor: Markdown and ordinary text merge by independent line edits, settings JSON merges recursively by key, Canvas arrays merge by stable object IDs, and Bases views merge by stable names. Concurrent changes to the same value, unparseable data, unavailable merge bases, binary files, and oversized files fall back to conflict copies. Users who prefer manual review can select **Always create conflict copies**.

You can optionally edit `seafile-ignore.txt` from the plugin settings or directly in the library root. It uses Seafile's standard ignore syntax and is shared with standard Seafile clients. Newly generated files contain a clearly marked managed-defaults block followed by a user-owned section; category changes update only the managed block. Fine-grained plugin allowlists cannot be fully represented by Seafile's exclusion-only pattern language, so the plugin's policy layer remains authoritative for those choices.

To trigger a sync immediately, click "Sync now" in the settings, or run "Seafile: Sync now" from the command palette (assign it a hotkey if you use it often).

Realtime sync is enabled by default. It connects to `<server>/notification`; a different notification-server URL can be entered in settings. The status row shows whether the WebSocket is connected or periodic synchronization is currently providing the fallback. The Seafile server must have its notification service enabled and exposed through the reverse proxy.

Per-file sync status and transfer progress are shown next to file names in the explorer. The text next to the sidebar sync button can be shown always, only during active synchronization (the default), or never; its complete hover tooltip is always retained. Development mode logs phase timings, transferred bytes, prepared-block reuse, and aggregate throughput to the developer console.

## Version history and recovery

Open **Seafile history** from the ribbon, plugin settings, or command palette. Its remote-history sections include:

- **Activity** presents Seafile commits as a date-grouped editing-session timeline. Nearby commits by the same author and device are grouped for readability; expanding a session lazily resolves its real commit trees and distinguishes content modifications from metadata-only updates, including the changed metadata fields and exact values on hover. A compact metadata toggle can hide metadata-only file changes and revisions; its additional commit-tree scan runs only while that filter is active and reuses cached comparisons. Long file lists can be progressively revealed or shown completely, and selecting a file opens its version timeline. Grouping is only a UI view and never rewrites server history; each normal sync cycle still creates one Seafile commit containing all changes published by that cycle.
- **File history** loads Seafile's content-version timeline by default. For a live file, an explicit **Scan** action can additionally walk retained library commits for metadata-only versions, with live progress, cancellation, rename-aware path tracking, exact field changes, and a show/hide control after completion. Metadata-only entries are informational because restoring file content cannot reproduce historical timestamps or modifiers.
- **Vault snapshots** renders retained revisions as collapsible commit cards. Expanding a commit compares it with its actual parent and shows an `A`/`M`/`D` file list that can be progressively revealed or shown completely. Clicking a text file lazily loads exact `+`/`−` line counts and an inline diff, including additions against an empty file and deletions to an empty file. Markdown is compared up to 16 MiB; JSON and Canvas files up to 2 MiB are parsed and normalized so formatting and object-key order do not create noise. Common text formats such as iCalendar are recognized directly, while unknown extensions use bounded UTF-8 and control-byte detection. Large line counts use a scalable patience-style diff instead of hiding the comparison. Restoring separately compares the selected commit with the current remote HEAD, reports files that will be modified, restored, or removed, and requires the library name as confirmation. The plugin synchronizes first, verifies that the remote HEAD did not change during review, and records the previous HEAD as an undo point. It uses Seafile's atomic library-revert API when permitted; read/write collaborators, encrypted libraries whose server-side password is unavailable, and older servers fall back to reconstructing the snapshot as a new plugin commit.
- **Deleted files** uses Seafile's library trash, supports multi-select restore, and can open the retained deletion directly even though the path no longer exists at the current HEAD. Earlier versions are derived from the retained commit trees, avoiding Seafile's live-path file-history lookup after deletion. When the trash response omits its object ID, the plugin resolves the file from the deletion commit's parent before recovery.

Use the sidebar's **File versions** tab to select the active file, enter a vault-relative path, or follow a file path from Activity without leaving the history view. **Open Seafile version history** in a file's context menu opens the same timeline in a larger modal. Markdown and other supported text versions show changes from the previous retained version by default; **Current file** switches the comparison to the file now in the vault. JSON and Canvas use the same normalized structured comparison as snapshots. Images show a preview, and other files show revision metadata. Restoring writes through Obsidian's adapter, preserves the historical modification time, and then enters the normal synchronization pipeline.

Seafile only creates server versions when a commit reaches the server. To retain work while offline, enable **Local offline checkpoints** in plugin settings. The plugin periodically stores content-addressed checkpoints for Markdown and Canvas files inside its protected, device-specific plugin data. Interval, retention, and storage limit are configurable, identical content is deduplicated, and local history can be cleared independently. The checkpoint index removes stale entries if an underlying local object is no longer available. These checkpoints are not vault files and do not sync through Seafile.

A local checkpoint can be restored without publication, or restored and published explicitly. Publication is allowed only when the remote HEAD still matches the checkpoint's recorded base; if another device changed the library, the plugin refuses direct publication and asks you to restore locally so ordinary synchronization and conflict handling remain in control. This gives offline recovery points without manufacturing misleading server history while disconnected.

History availability is governed by the Seafile server's file-history and trash retention settings. Expired server versions cannot be reconstructed by the plugin. Local checkpoints complement that retention but remain available only on the device that created them.

The same sidebar also contains **Sync issues**, a device-local record of conflicts, safety stops, interrupted-download recovery, and recurring errors. Repeated identical errors are grouped, paths can be opened directly, and handled entries can be marked resolved and cleared. File conflicts can be reviewed in place: safe text and JSON files show the current library version against the preserved local copy, then let the user keep the current version, restore the preserved local version, or retain both. Resolution verifies that neither reviewed file changed before applying the choice. If the shared policy file is malformed or uses an unsupported version, synchronization stops safely and the issue offers a validated JSON editor or an explicit reset to this device's current policy selections.

## Sync safety and repair

Before changing files, the plugin calculates the complete synchronization plan. By default, it requests explicit confirmation if a sync would delete at least 500 files, or at least 20 files representing 25% of the previously synchronized files. This applies independently to deletion from the local device and the remote library; the absolute threshold is editable and protection can be disabled in settings.

The same preflight rejects filenames that are not portable to Windows, detects case-colliding sibling paths, and prevents uploads or remote deletions when the selected library has become read-only. Read-only libraries can still download remote changes until a local change requires write access.

Use **Verify vault** to compare the current vault, local sync index, and remote metadata without changing files. **Diagnostics report** provides inspectable support JSON containing versions, platform, feature and connection states, policy values, and issue counts while excluding credentials, server and repository identifiers, file paths, issue messages, and commit IDs. If the index is damaged or stale, **Rebuild sync index** removes only the device-local baseline and performs a fresh merge. Existing vault files are preserved, and differing local and remote files enter normal conflict-copy handling. Use destructive **Clear vault** only when you intentionally want to remove local synchronized files.

**Sync issues** retains conflicts, safety and preflight stops, recovery actions, repository loss, and generic failures only after automatic retries are exhausted. Self-healing races such as a file changing during upload or another device replacing Seafile HEAD remain visible in logs and temporary sync status but are not kept as user-facing issues.

`seafile-ignore.txt` is created automatically when absent. Its managed section covers common project state, device-specific workspace layouts, disabled configuration categories that Seafile patterns can express, and this plugin's private operational state. Its rules prevent new matching local files from being uploaded; files already present on the server may still be downloaded by standard Seafile clients. The plugin's Obsidian-aware policy can additionally retain an excluded remote entry without downloading it, and safely downloads it if that category is enabled later. The plugin installation and its device-specific synchronization database are always protected internally.

Downloads are written to a temporary file and verified before replacing an existing local file. If local and remote edits overlap or cannot be merged safely, the local version is preserved as an `SFConflict` copy and synchronized alongside the remote version.

After a commit is published, changed local sync records are persisted with one batched journal append and one coalesced explorer refresh. Large journals are then compacted into the main sync database.

If the configured repository is deleted or access is revoked, synchronization and realtime notifications stop immediately. Local files are preserved while the user restores access or chooses another repository.

## Notes

1. **Use it at your own risk.** This plugin is still under development. There is a risk of data corruption or loss. Keep backups of anything important.
2. **Large files.** Desktop preparation, upload, and ordered download prefetching use bounded worker pools with up to four concurrent 8 MB blocks; mobile transfers use two while preparation remains serial. Desktop also retains at most 32 MB of prepared blocks to avoid duplicate reads, encryption, and hashing. Obsidian's mobile API still requires uploads to be read into memory as a complete file, so files larger than 50 MB trigger a warning and may remain slow or memory-intensive on mobile.
3. **Recovery.** Try **Verify vault** and **Rebuild sync index** first. **Clear vault** removes local synchronized files and should be reserved for an intentional clean download.
4. **Interrupted synchronization.** Closing Obsidian during a sync leaves that cycle incomplete, but remote changes are published atomically and local transfer journals allow the next run to recover or safely repeat unfinished work. Wait for synchronization to finish when practical so other devices receive the latest changes immediately.
5. **Hidden files.** Obsidian does not emit reliable live events for every hidden file, including files below `.obsidian`. Full sync traversal still discovers them, so these changes are synchronized by the next periodic, manual, or startup sync rather than necessarily triggering an immediate sync themselves.

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

CI exercises the current Seafile HTTP contract through a real local HTTP boundary without credentials. Maintainers can additionally run the read-only smoke test against a deployment with `SEAFILE_URL`, `SEAFILE_TOKEN`, `SEAFILE_REPO_ID`, and `SEAFILE_REPO_TOKEN` set: `npm run test:seafile-smoke`.

## Credits

Original plugin by [@conql](https://github.com/conql). The continued version was created and is maintained upstream by [@ryanravn](https://github.com/ryanravn). This fork is maintained by [@tionis](https://github.com/tionis).
