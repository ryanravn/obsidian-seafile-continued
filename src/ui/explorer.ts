import { setIcon, setTooltip } from "obsidian";
import { ExplorerLeaf, FileItem } from "src/@types/obsidian";
import SeafilePlugin from "src/main";
import { SyncController, SyncStatus } from "src/sync/controller";
import { SyncNode, SyncState } from "src/sync/node";
import { debug } from "src/utils";
import type { NotificationStatus } from "src/notification";
import styles from "./explorer.module.css";
import { formatSyncActivity, shouldShowSyncStatusText } from "./sync_progress";

export class Explorer {

	constructor(private plugin: SeafilePlugin, private sync: SyncController) {
		this.plugin.register(() => {
			this.onPluginUnload();
		});
		this.plugin.app.workspace.onLayoutReady(() => {
			this.registerFileExplorer().catch(error => {
				debug.error("Failed to hook into the file explorer; sync status icon and file badges will not be shown", error);
			});
		});

		sync.onNodeStateChanged = node => { this.nodeStateChanged(node); };
		sync.onNodeStatesChanged = nodes => { this.nodeStatesChanged(nodes); };
		this.plugin.register(sync.subscribeStatus(status => this.syncStatusChanged(status)));
		this.plugin.register(this.plugin.notifications.subscribeStatus(status => {
			this.notificationStatus = status;
			if (this.sync.status.type === "idle") this.syncStatusChanged(this.sync.status);
		}));
	}


	private fileExplorer: ExplorerLeaf;
	private fileItems: Record<string, FileItem> = {};
	private statusContainter: HTMLElement;
	private statusText: HTMLElement;
	private statusIcon: HTMLElement;
	private isRootNodeSynced = false;
	private notificationStatus: NotificationStatus = { type: "disabled" };

	private async registerFileExplorer() {
		// Find the file explorer
		const fileExplorers = this.plugin.app.workspace.getLeavesOfType("file-explorer");
		if (fileExplorers.length == 0) throw new Error("No file explorer found");
		else if (fileExplorers.length > 1) {
			debug.warn("Multiple file explorers found, using the first one");
		}
		this.fileExplorer = fileExplorers[0];

		// Wait till file items loaded
		await new Promise<void>((resolve) => {
			const id = this.plugin.registerInterval(window.setInterval(() => {
				this.fileItems = this.fileExplorer.view.fileItems;
				if (this.fileItems) {
					window.clearInterval(id);
					resolve();
				}
			}, 100));
		});

		// Register file items
		this.fileExplorer.view.fileItems = new Proxy(this.fileItems, {
			set: (target: Record<string, FileItem>, prop: string | symbol, value: FileItem): boolean => {
				const ret = Reflect.set(target, prop, value);
				void this.fileItemChanged(value, prop as string);
				return ret;
			}
		});

		// Init all file items
		for (const path in this.fileItems) {
			void this.fileItemChanged(this.fileItems[path], path);
		}

		this.statusContainter = this.fileExplorer.containerEl.createDiv({ cls: styles.syncStatus });

		this.statusIcon = this.statusContainter.createDiv({ cls: ["nav-action-button", "clickable-icon"] });
		this.statusIcon.addEventListener("click", () => {
			void (async () => {
				if (!this.plugin.settings.enableSync) {
					this.plugin.settings.enableSync = true;
					await this.plugin.saveSettings();
					void this.plugin.enableSync();
				}
				else {
					await this.plugin.triggerManualSync();
				}
			})();
		});
		this.statusText = this.statusContainter.createDiv({ cls: styles.syncStatusText });

		this.fileExplorer.containerEl.getElementsByClassName("nav-files-container")[0].after(this.statusContainter);
		this.syncStatusChanged(this.sync.status);
	}

	private statesBuffer: Map<string, SyncState> = new Map();
	private nodeStatesChanged(nodes: SyncNode[]): void {
		for (const node of nodes) this.nodeStateChanged(node);
	}

	private nodeStateChanged(node: SyncNode): void {
		const path = node.path === "" ? "/" : node.path.slice(1); // remove leading slash

		const item = this.fileItems[path];
		if (item) {
			this.renderFileItem(item, node.state);
		}
		else {
			this.statesBuffer.set(path, node.state);
		}

		// Update isRootNodeSynced
		if (path === "/") {
			this.isRootNodeSynced = node.state.type === "sync";

			// Node state changes also occur while a sync is running. Only derive
			// the summary from the root node while the controller is actually
			// idle, otherwise this would overwrite Downloading/Uploading with a
			// stale Pending sync status.
			if (this.sync.status.type === "idle") {
				this.syncStatusChanged(this.sync.status);
			}
		}
	}

	private fileItemChanged(item: FileItem, path: string): void {
		if (this.statesBuffer.has(path)) {
			this.renderFileItem(item, this.statesBuffer.get(path)!);
		}
		else {
			this.renderFileItem(item, { type: "init" });
		}
	}

	private renderFileItem(item: FileItem, state: SyncState): void {
		if (!item.iconWrapper) {
			// Create icon wrapper div
			const iconWrapper = item.selfEl.createDiv({ cls: styles.nodeState });
			item.iconWrapper = iconWrapper;
		}

		const wrapper = item.iconWrapper;
		setTooltip(wrapper, "");
		if (state.type === "sync") {
			wrapper.textContent = "";
		}
		else if (state.type === "upload") {
			setIcon(wrapper, "upload-cloud");
			setTooltip(wrapper, `Uploading — ${Math.round(state.param.progress * 100)}%`);
		}
		else if (state.type === "init") {
			setIcon(wrapper, "refresh-cw");
		}
		else if (state.type === "download") {
			setIcon(wrapper, "download-cloud");
			setTooltip(wrapper, `Downloading — ${Math.round(state.param * 100)}%`);
		}
		else if (state.type === "delete") {
			// don't show delete: may be overwrite rename if delete is delayed after create event
		}
		wrapper.setAttribute("state", state.type);
	}

	setStatus(icon: string, text: string, visibleText = text) {
		setIcon(this.statusIcon, icon);
		setTooltip(this.statusIcon, text, { placement: "right" });
		this.statusText.textContent = visibleText;
	}

	private withRealtimeStatus(text: string): string {
		if (!this.plugin.settings.enableNotifications) return `${text} — realtime disabled`;
		if (this.notificationStatus.type === "connected") return `${text} — realtime connected`;
		if (this.notificationStatus.type === "connecting") return `${text} — realtime connecting`;
		if (this.notificationStatus.type === "fallback") return `${text} — periodic fallback active`;
		return text;
	}

	syncStatusChanged(status: SyncStatus): void {
		if (!this.statusIcon) return;

		if (status.type == "idle") {
			if (status.error) {
				this.setStatus("alert-circle", this.withRealtimeStatus(`Sync failed: ${status.error} — retry scheduled`), "Sync failed — retry scheduled");
			}
			else if (this.isRootNodeSynced) {
				this.setStatus("check", this.withRealtimeStatus("Synced"));
			}
			else {
				this.setStatus("history", this.withRealtimeStatus("Pending sync"));
			}
		}
		else if (status.type == "busy") {
			const activity = formatSyncActivity(status);
			if (status.message == "fetch" || status.message == "download") {
				this.setStatus("download-cloud", activity);
			}
			else if (status.message == "upload") {
				this.setStatus("upload-cloud", activity);
			}
			else {
				// syncCycle enters busy before it knows which phase comes next, so
				// provide immediate feedback for manual sync clicks.
				this.setStatus("refresh-cw", activity);
			}
		}
		else if (status.type == "stop") {
			if (status.message == "repository-unavailable") {
				this.setStatus("archive-x", `${status.error ?? "Repository unavailable"} Local files preserved.`);
			}
			else if (status.message == "error") {
				this.setStatus("alert-circle", "Error");
			}
			else if (status.message == "safety" || status.message == "preflight") {
				this.setStatus("shield-alert", status.error ?? "Sync paused by a safety check");
			}
			else {
				this.setStatus("refresh-cw-off", "Sync stopped");
			}
		}
		else {
			throw new Error("Invalid sync status type");
		}
		// Persistent label visibility is independent from the icon tooltip,
		// which setStatus() always updates with the complete status text.
		this.statusText.hidden = !shouldShowSyncStatusText(this.plugin.settings.syncStatusTextMode, status);
	}

	onPluginUnload() {
		const items: [string, FileItem][] = Object.entries(this.fileItems);
		for (const [, item] of items) {
			if (item.iconWrapper) {
				item.iconWrapper.remove();
				delete item.iconWrapper;
			}
		}
		// registerFileExplorer() may not have completed (still waiting on
		// onLayoutReady, or it failed to find a file-explorer leaf).
		if (this.fileExplorer) {
			this.fileExplorer.view.fileItems = this.fileItems;
		}

		if (this.statusContainter) {
			this.statusContainter.remove();
		}
	}
}
