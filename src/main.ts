import { Notice, Plugin, TFile, normalizePath } from "obsidian";
import { ensurePluginGitignore, initConfig, PLUGIN_DIR } from "./config";
import { SEAFILE_IGNORE_FILE } from "./ignore";
import { RepoCrypto } from "./crypto";
import { getPasswordStore } from "./password_store";
import Server from "./server";
import { SeafileNotificationClient } from "./notification";
import { DEFAULT_SETTINGS, type SeafileSettings } from "./settings";
import { SyncController, type MassDeletionWarning } from "./sync/controller";
import { Explorer } from "./ui/explorer";
import PasswordModal from "./ui/password_modal";
import { SeafileSettingTab } from "./ui/setting_tab";
import { debug, disableDebugConsole } from "./utils";
import { HistoryService } from "./history/service";
import { LocalCheckpointStore } from "./history/checkpoint_store";
import type { DeletedEntry, FileRevision, LocalCheckpoint, SnapshotDiff } from "./history/types";
import { FileHistoryModal } from "./ui/file_history_modal";
import { HISTORY_VIEW_TYPE, HistoryView } from "./ui/history_view";
import { HttpError } from "./server";
import Dialog from "./ui/dialog_modal";
import { CredentialStore, withoutPersistedTokens } from "./credential_store";
import { SyncIssueStore } from "./sync/issues";
import { VaultVerificationModal } from "./ui/verification_modal";

export default class SeafilePlugin extends Plugin {
	settings: SeafileSettings;
	server: Server;
	sync: SyncController;
	explorerView: Explorer;
	notifications: SeafileNotificationClient;
	history: HistoryService;
	checkpoints: LocalCheckpointStore;
	private credentialStore: CredentialStore;
	issues: SyncIssueStore;

	async onload(): Promise<void> {
		this.settings = await this.loadSettings();
		this.server = new Server(this.settings, this);
		initConfig(this.app, this.server, this.manifest.id);
		await ensurePluginGitignore();

		this.issues = new SyncIssueStore(this.app);
		this.sync = new SyncController(this.app.vault.adapter, this.settings);
		this.sync.onMassDeletionWarning = async warning => await this.confirmMassDeletion(warning);
		this.sync.onRepositoryPermissionChanged = () => { void this.saveSettings(); };
		this.sync.onIssue = issue => { this.issues.add(issue); };
		this.history = new HistoryService(this.server);
		this.checkpoints = new LocalCheckpointStore(
			this.app, this.app.vault.adapter, this.settings, this.manifest.id,
			() => this.sync.getKnownRemoteHead()
		);
		this.register(() => this.checkpoints.dispose());
		this.notifications = new SeafileNotificationClient(this.settings, this.server, () => this.sync.requestSync());
		this.sync.onRepositoryUnavailable = () => this.notifications.stop();
		this.explorerView = new Explorer(this, this.sync);

		this.registerEvent(this.app.vault.on("create", (file) => {
			this.checkpoints.schedule(file.path);
			if (this.sync.status.type !== "stop") {
				void this.sync.notifyChange("/" + file.path, "create");
			}
		}));
		this.registerEvent(this.app.vault.on("delete", (file) => {
			if (this.sync.status.type !== "stop") {
				void this.sync.notifyChange("/" + file.path, "delete");
			}
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			if (this.sync.status.type !== "stop") {
				void this.sync.notifyChange("/" + oldPath, "delete");
				void this.sync.notifyChange("/" + file.path, "create");
			}
		}));
		this.registerEvent(this.app.vault.on("modify", (file) => {
			this.checkpoints.schedule(file.path);
			if (this.sync.status.type !== "stop") { void this.sync.notifyChange("/" + file.path, "modify"); }
		}));

		this.addSettingTab(new SeafileSettingTab(this.app, this));
		this.registerView(HISTORY_VIEW_TYPE, leaf => new HistoryView(leaf, this));
		this.addRibbonIcon("history", "Open Seafile history", () => { void this.openHistoryView(); });
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (!(file instanceof TFile)) return;
			menu.addItem(item => item
				.setTitle("Open Seafile version history")
				.setIcon("history")
				.onClick(() => this.openFileHistory(file.path)));
		}));

		this.addCommand({
			id: "manual-sync",
			name: "Sync now",
			callback: async () => { await this.triggerManualSync(); },
		});
		this.addCommand({
			id: "open-sync-history",
			name: "Open sync history",
			callback: () => { void this.openHistoryView("activity"); },
		});
		this.addCommand({
			id: "open-file-history",
			name: "Open version history for current file",
			checkCallback: checking => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) void this.openHistoryView("file", file.path);
				return true;
			},
		});
		this.addCommand({
			id: "open-vault-snapshots",
			name: "Open vault snapshots",
			callback: () => { void this.openHistoryView("snapshots"); },
		});
		this.addCommand({
			id: "open-sync-issues",
			name: "Open sync issues",
			callback: () => { void this.openHistoryView("issues"); },
		});

		if (this.settings.devMode) {
			(window as unknown as Record<string, unknown>)["seafile"] = this; // for debug
		} else {
			disableDebugConsole();
		}
		if (this.settings.enableSync && !this.checkSyncReady()) {
			this.settings.enableSync = false;
			await this.saveSettings();
			new Notice("Set up the Seafile plugin before enabling sync.");
		}

		if (this.settings.enableSync) {
			// Don't block onload() on the password prompt or sync init —
			// otherwise Obsidian shows "loading" until the user types the password.
			void this.enableSync();
		}
	}

	openFileHistory(path: string): void {
		new FileHistoryModal(this.app, this, normalizePath(path)).open();
	}

	openDeletedFileHistory(entry: DeletedEntry): void {
		const path = normalizePath(`${entry.parentDir}/${entry.name}`);
		const revision: FileRevision = {
			commitId: entry.commitId,
			path: "/" + path,
			createdAt: entry.deletedAt,
			authorName: "",
			authorEmail: "",
			description: "Deleted file",
			size: entry.size,
			fileId: entry.objectId,
			deleted: true
		};
		new FileHistoryModal(this.app, this, path, revision).open();
	}

	async openHistoryView(tab: "activity" | "file" | "snapshots" | "deleted" | "issues" = "activity", filePath = ""): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: HISTORY_VIEW_TYPE, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
		if (leaf.view instanceof HistoryView) {
			if (tab === "file" && filePath) await leaf.view.showFileHistory(filePath);
			else await leaf.view.showTab(tab);
		}
	}

	async restoreHistoricalFile(path: string, revision: FileRevision): Promise<void> {
		const file = await this.history.readRevision(revision);
		await this.writeRestoredFile(path, file.content, file.mtime * 1000);
	}

	async restoreLocalCheckpoint(checkpoint: LocalCheckpoint, publish: boolean): Promise<void> {
		if (publish) {
			const remoteHead = await this.server.getHeadCommitId();
			if (checkpoint.baseRemoteHead && checkpoint.baseRemoteHead !== remoteHead) {
				throw new Error("The remote library changed after this checkpoint was created. Restore it locally first and let normal conflict handling merge it.");
			}
		}
		await this.writeRestoredFile(checkpoint.path, await this.checkpoints.read(checkpoint), checkpoint.createdAt);
		if (publish) {
			if (this.sync.status.type === "stop") await this.enableSync();
			else this.sync.requestSync();
			await this.sync.waitUntilIdle();
			await this.checkpoints.markPublished(checkpoint.id, await this.server.getHeadCommitId());
		}
	}

	async restoreVaultSnapshot(targetCommitId: string, diff: SnapshotDiff): Promise<void> {
		if (!this.settings.enableSync) throw new Error("Enable synchronization before restoring a vault snapshot.");
		this.sync.requestSync();
		await this.sync.waitUntilIdle();
		if (!this.sync.isLocallySynchronized()) throw new Error("The local vault still has pending changes.");

		const previousHead = await this.server.getHeadCommitId();
		if (previousHead === targetCommitId) throw new Error("This snapshot is already the current library state.");
		this.notifications.stop();
		await this.sync.stopSyncAsync();
		const progress = new Notice("Restoring vault snapshot…", 0);
		try {
			const verifiedHead = await this.server.getHeadCommitId();
			if (verifiedHead !== previousHead) throw new Error("The remote library changed while the snapshot was being reviewed. Refresh and try again.");
			try {
				await this.server.revertToCommit(targetCommitId);
			} catch (error) {
				// Seafile limits the atomic revert endpoint to library owners, and
				// some older deployments do not expose it. A read/write collaborator
				// can still reconstruct the reviewed snapshot as a normal new commit.
				if (!(error instanceof HttpError && [403, 404, 405].includes(error.status))) throw error;
				await this.restoreSnapshotLocally(targetCommitId, diff);
			}
			this.settings.lastSnapshotUndoCommit = previousHead;
			await this.saveSettings();
		} finally {
			progress.hide();
			if (this.settings.enableSync) await this.enableSync();
		}
	}

	private async restoreSnapshotLocally(targetCommitId: string, diff: SnapshotDiff): Promise<void> {
		const changedFiles = [...diff.modifiedFiles, ...diff.addedFiles];
		const progress = new Notice(`Restoring vault snapshot 0/${changedFiles.length + diff.deletedFiles.length}…`, 0);
		try {
			for (const rawPath of [...diff.addedDirectories].sort((a, b) => a.length - b.length)) {
				const path = normalizePath(rawPath.replace(/^\/+/, ""));
				if (path && !await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.mkdir(path);
			}
			let completed = 0;
			for (const rawPath of changedFiles) {
				const path = normalizePath(rawPath.replace(/^\/+/, ""));
				const historical = await this.history.readFile(targetCommitId, rawPath);
				await this.writeRestoredFile(path, historical.content, historical.mtime * 1000, false);
				progress.setMessage(`Restoring vault snapshot ${++completed}/${changedFiles.length + diff.deletedFiles.length}…`);
			}
			for (const rawPath of diff.deletedFiles) {
				const path = normalizePath(rawPath.replace(/^\/+/, ""));
				await this.checkpoints.capture(path, true);
				if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
				progress.setMessage(`Restoring vault snapshot ${++completed}/${changedFiles.length + diff.deletedFiles.length}…`);
			}
			for (const rawPath of [...diff.deletedDirectories].sort((a, b) => b.length - a.length)) {
				const path = normalizePath(rawPath.replace(/^\/+/, ""));
				if (!await this.app.vault.adapter.exists(path)) continue;
				const remaining = await this.app.vault.adapter.list(path);
				if (remaining.files.length === 0 && remaining.folders.length === 0) await this.app.vault.adapter.rmdir(path, false);
			}
		} finally {
			progress.hide();
		}
	}

	private async writeRestoredFile(path: string, content: ArrayBuffer, mtime: number, requestSync = true): Promise<void> {
		path = normalizePath(path.replace(/^\/+/, ""));
		const existed = await this.app.vault.adapter.exists(path);
		await this.checkpoints.capture(path, true);
		await this.ensureParentDirectories(path);
		await this.app.vault.adapter.writeBinary(path, content, { mtime });
		await this.sync.notifyChange("/" + path, existed ? "modify" : "create");
		if (requestSync) this.sync.requestSync();
	}

	private async ensureParentDirectories(path: string): Promise<void> {
		const parts = path.split("/").slice(0, -1);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!await this.app.vault.adapter.exists(current)) await this.app.vault.adapter.mkdir(current);
		}
	}

	async disableSync(): Promise<void> {
		this.settings.enableSync = false;
		await this.saveSettings();
		this.notifications.stop();
		if (this.sync.status.type === "stop") return;
		await this.sync.stopSyncAsync();
	}

	async enableSync(): Promise<void> {
		this.settings.enableSync = true;
		await this.saveSettings();
		if (this.sync.status.type !== "stop") return;

		const ok = await this.ensureUnlocked();
		if (!ok) {
			new Notice("Sync not started: encrypted repository is locked.");
			return;
		}

		// Wait until Obsidian's vault index has finished loading before the first
		// sync. fastStat()/fastList() resolve local files through that index
		// (app.vault.getAbstractFileByPath); if sync runs while it is still
		// populating, every tracked file looks locally deleted and gets removed on
		// the server, then re-added once the index loads -- the "bulk delete
		// followed by bulk reupload" of issue #1. onLayoutReady fires immediately
		// if the layout is already ready, so this is also correct when the user
		// enables sync manually from settings.
		await this.whenLayoutReady();

		await this.sync.init();
		this.sync.startSync();
		this.notifications.start();
	}

	async setNotificationsEnabled(enabled: boolean): Promise<void> {
		this.settings.enableNotifications = enabled;
		await this.saveSettings();
		this.refreshNotifications();
	}

	async setNotificationUrl(url: string): Promise<void> {
		this.settings.notificationUrl = url;
		await this.saveSettings();
		this.refreshNotifications();
	}

	refreshNotifications(): void {
		if (this.settings.enableNotifications && this.settings.enableSync && this.checkSyncReady() && this.sync.status.type !== "stop") {
			this.notifications.start();
		} else {
			this.notifications.stop();
		}
	}

	async resetSyncForRepositoryChange(): Promise<void> {
		this.notifications.stop();
		await this.sync.resetForRepositoryChange();
	}

	async verifyVault(): Promise<void> {
		const notice = new Notice("Verifying Seafile vault…", 0);
		try {
			const report = await this.sync.verifyVault();
			new VaultVerificationModal(this.app, report).open();
		} finally {
			notice.hide();
		}
	}

	async rebuildSyncIndex(): Promise<void> {
		this.notifications.stop();
		await this.sync.rebuildSyncIndex();
		this.issues.add({ kind: "recovery", message: "Rebuilt the local sync index without deleting vault files." });
		if (this.settings.enableSync) await this.enableSync();
	}

	private async whenLayoutReady(): Promise<void> {
		await new Promise<void>((resolve) => {
			this.app.workspace.onLayoutReady(() => { resolve(); });
		});
	}

	async triggerManualSync(): Promise<void> {
		if (!this.settings.enableSync) {
			new Notice("Enable sync first to use manual sync");
			return;
		}
		if (!this.checkSyncReady()) {
			if (!this.settings.authToken) {
				new Notice("Log in first before syncing");
			} else if (!this.settings.repoId) {
				new Notice("Choose a repository first before syncing");
			} else {
				new Notice("Sync is not ready");
			}
			return;
		}
		if (this.sync.status.type === "busy") {
			new Notice("Sync already in progress");
			return;
		}
		this.sync.startSync();
		this.refreshNotifications();
		new Notice("Sync started");
	}

	private async confirmMassDeletion(warning: MassDeletionWarning): Promise<boolean> {
		const location = warning.direction === "local" ? "this device" : "the remote Seafile library";
		return await new Promise<boolean>(resolve => {
			let settled = false;
			const finish = (value: boolean): void => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			new Dialog(this.app,
				"Confirm mass deletion",
				`This sync would delete ${warning.deletions.toLocaleString()} files from ${location} (${warning.percentage.toFixed(1)}% of the ${warning.trackedFiles.toLocaleString()} previously synchronized files).\n\nContinue only if this deletion is expected.`,
				() => { finish(true); },
				() => { finish(false); }
			).open();
		});
	}

	checkSyncReady(): boolean {
		const settings = this.settings;
		if (settings.authToken && settings.repoId) {
			return true;
		}
		return false;
	}

	// Resolves true once the repo is ready to sync (plain repo, or encrypted-and-unlocked).
	// Resolves false if the user cancelled the password prompt.
	async ensureUnlocked(): Promise<boolean> {
		if (!this.settings.encrypted) return true;
		if (this.server.crypto) return true;

		if (this.settings.encVersion !== 2 && this.settings.encVersion !== 4) {
			new Notice(`Encryption version ${this.settings.encVersion} is not supported.`);
			return false;
		}

		const meta = {
			repoId: this.settings.repoId,
			encVersion: this.settings.encVersion,
			repoSalt: this.settings.repoSalt,
			magic: this.settings.repoMagic,
			randomKey: this.settings.randomKey
		};

		const store = getPasswordStore(this.app);
		const stored = await store.load(this.settings.repoId);
		if (stored) {
			try {
				this.server.crypto = await RepoCrypto.unlock(meta, stored);
				return true;
			} catch (e) {
				// Stored password no longer valid (password changed, repo re-keyed, etc).
				// Drop it and fall through to prompt.
				debug.warn("Stored repo password rejected, clearing it", e);
				await store.clear(this.settings.repoId);
			}
		}

		return await new Promise<boolean>((resolve) => {
			new PasswordModal(this.app, meta, async (crypto, password, remember) => {
				this.server.crypto = crypto;
				if (remember) {
					try {
						await store.save(this.settings.repoId, password);
					} catch (e) {
						new Notice("Could not save password: " + (e as Error).message);
						debug.error(e);
					}
				}
				resolve(true);
			}, () => {
				resolve(false);
			}).open();
		});
	}

	async clearVault(): Promise<void> {
		const clearNotice = new Notice("Clearing vault, please wait...", 0);
		const waitForStopNotice = new Notice("Waiting for syncing to stop", 0);

		try {
			await this.disableSync();
		} finally {
			waitForStopNotice.hide();
		}

		try {
			await this.sync.reloadIgnoreFile();

			const remove = async (path: string, isDir: boolean): Promise<void> => {
				if (path === SEAFILE_IGNORE_FILE || this.sync.isPathIgnored(path, isDir)) return;

				if (!isDir) {
					await this.app.vault.adapter.remove(path);
					return;
				}

				let list = await this.app.vault.adapter.list(path);
				for (const path of list.files) {
					await remove(path, false);
				}
				for (const path of list.folders) {
					await remove(path, true);
				}

				list = await this.app.vault.adapter.list(path);
				if (list.files.length === 0 && list.folders.length === 0 && path !== "") {
					await this.app.vault.adapter.rmdir(path, true);
				}
			};

			await remove("", true);

			// Clear own plugin folder
			const list = await this.app.vault.adapter.list(PLUGIN_DIR);
			for (const path of list.files) {
				const basename = path.split("/").pop();
				if (basename === "main.js" || basename === "manifest.json" || basename === "styles.css" || basename === "data.json" || basename === ".gitignore") continue;
				await this.app.vault.adapter.remove(path);
			}
			for (const path of list.folders) {
				await this.app.vault.adapter.rmdir(path, true);
			}

			new Notice("Vault cleared", 3000);
		} finally {
			clearNotice.hide();
		}
	}

	onunload(): void {
		this.notifications?.stop();
		if (this.sync) {
			void this.sync.stopSyncAsync();
		}
	}

	async loadSettings(): Promise<SeafileSettings> {
		const data = await this.loadData() as Partial<SeafileSettings> | null;
		const settings: SeafileSettings = Object.assign({}, DEFAULT_SETTINGS, data);
		this.credentialStore = new CredentialStore(this.app);
		const migratedCredentials = this.credentialStore.hydrate(settings);
		if (!["always", "syncing", "never"].includes(settings.syncStatusTextMode)) {
			settings.syncStatusTextMode = DEFAULT_SETTINGS.syncStatusTextMode;
		}
		if (![0, 1, 5, 15].includes(settings.historyGroupingMinutes)) {
			settings.historyGroupingMinutes = DEFAULT_SETTINGS.historyGroupingMinutes;
		}
		if (!Number.isFinite(settings.localHistoryIntervalMinutes) || settings.localHistoryIntervalMinutes < 1) settings.localHistoryIntervalMinutes = 5;
		if (!Number.isFinite(settings.localHistoryRetentionDays) || settings.localHistoryRetentionDays < 1) settings.localHistoryRetentionDays = 7;
		if (!Number.isFinite(settings.localHistoryMaxBytes) || settings.localHistoryMaxBytes < 1024 * 1024) settings.localHistoryMaxBytes = 250 * 1024 * 1024;
		if (!Number.isFinite(settings.deletionProtectionFileThreshold) || settings.deletionProtectionFileThreshold < 1) settings.deletionProtectionFileThreshold = 500;
		if (!Number.isFinite(settings.deletionProtectionPercentThreshold) || settings.deletionProtectionPercentThreshold <= 0 || settings.deletionProtectionPercentThreshold > 100) settings.deletionProtectionPercentThreshold = 25;
		if (!Number.isFinite(settings.deletionProtectionPercentMinimumFiles) || settings.deletionProtectionPercentMinimumFiles < 1) settings.deletionProtectionPercentMinimumFiles = 20;
		if (migratedCredentials || settings.authToken || settings.repoToken) {
			await this.saveData(withoutPersistedTokens(settings));
		}
		return settings;
	}

	async saveSettings(settings: SeafileSettings = this.settings): Promise<void> {
		this.settings = settings;
		this.credentialStore.persist(settings);
		await this.saveData(withoutPersistedTokens(settings));
	}
}
