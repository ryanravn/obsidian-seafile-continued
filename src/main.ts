import { Notice, Plugin } from "obsidian";
import { initConfig, PLUGIN_DIR } from "./config";
import { SEAFILE_IGNORE_FILE } from "./ignore";
import { RepoCrypto } from "./crypto";
import { getPasswordStore } from "./password_store";
import Server from "./server";
import { DEFAULT_SETTINGS, type SeafileSettings } from "./settings";
import { SyncController } from "./sync/controller";
import { Explorer } from "./ui/explorer";
import PasswordModal from "./ui/password_modal";
import { SeafileSettingTab } from "./ui/setting_tab";
import { debug, disableDebugConsole } from "./utils";

export default class SeafilePlugin extends Plugin {
	settings: SeafileSettings;
	server: Server;
	sync: SyncController;
	explorerView: Explorer;

	async onload(): Promise<void> {
		this.settings = await this.loadSettings();
		this.server = new Server(this.settings, this);
		initConfig(this.app, this.server, this.manifest.id);

		this.sync = new SyncController(this.app.vault.adapter, this.settings);
		this.explorerView = new Explorer(this, this.sync);

		this.registerEvent(this.app.vault.on("create", (file) => {
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
			if (this.sync.status.type !== "stop") { void this.sync.notifyChange("/" + file.path, "modify"); }
		}));

		this.addSettingTab(new SeafileSettingTab(this.app, this));

		this.addCommand({
			id: "manual-sync",
			name: "Sync now",
			callback: async () => { await this.triggerManualSync(); },
		});

		if (this.settings.devMode) {
			(window as unknown as Record<string, unknown>)["seafile"] = this; // for debug
			this.addRibbonIcon("trash-2", "Clear vault", async () => {
				await this.clearVault();
			});
			this.addRibbonIcon("play-circle", "Start sync", async () => {
				this.sync.startSync();
			});

			this.addRibbonIcon("stop-circle", "Stop sync", async () => {
				await this.sync.stopSyncAsync();
			});
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

	async disableSync(): Promise<void> {
		this.settings.enableSync = false;
		await this.saveSettings();
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
		new Notice("Sync started");
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
				if (basename === "main.js" || basename === "manifest.json" || basename === "styles.css" || basename === "data.json") continue;
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
		if (this.sync) {
			void this.sync.stopSyncAsync();
		}
	}

	async loadSettings(): Promise<SeafileSettings> {
		const data = await this.loadData() as Partial<SeafileSettings> | null;
		const settings: SeafileSettings = Object.assign({}, DEFAULT_SETTINGS, data);
		return settings;
	}

	async saveSettings(settings: SeafileSettings = this.settings): Promise<void> {
		this.settings = settings;
		await this.saveData(settings);
	}
}
