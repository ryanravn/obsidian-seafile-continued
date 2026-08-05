import { ItemView, Notice, Setting, normalizePath, type WorkspaceLeaf } from "obsidian";
import type SeafilePlugin from "../main";
import { groupHistory } from "../history/grouping";
import type { DeletedEntry, LibraryRevision } from "../history/types";
import { SnapshotRestoreModal } from "./snapshot_restore_modal";
import { FileHistoryPanel } from "./file_history_panel";
import styles from "./history.module.css";

export const HISTORY_VIEW_TYPE = "seafile-sync-history";
type HistoryTab = "activity" | "file" | "snapshots" | "deleted";

export class HistoryView extends ItemView {
	private tab: HistoryTab = "activity";
	private page = 1;
	private revisions: LibraryRevision[] = [];
	private more = false;
	private search = "";
	private deletedPage = 1;
	private deletedTotal = 0;
	private deletedEntries: DeletedEntry[] = [];
	private readonly selectedDeleted = new Map<string, DeletedEntry>();
	private filePath = "";
	private filePanel: FileHistoryPanel | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: SeafilePlugin) {
		super(leaf);
	}

	getViewType(): string { return HISTORY_VIEW_TYPE; }
	getDisplayText(): string { return "Seafile sync history"; }
	getIcon(): string { return "history"; }

	async onOpen(): Promise<void> {
		await this.render();
	}

	async onClose(): Promise<void> {
		this.filePanel?.dispose();
		this.filePanel = null;
	}

	async showTab(tab: HistoryTab): Promise<void> {
		this.tab = tab;
		if (tab === "file" && !this.filePath) this.filePath = this.app.workspace.getActiveFile()?.path ?? "";
		await this.render();
	}

	async showFileHistory(path: string): Promise<void> {
		this.filePath = normalizePath(path.replace(/^\/+/, ""));
		this.tab = "file";
		await this.render();
	}

	private async render(): Promise<void> {
		this.filePanel?.dispose();
		this.filePanel = null;
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.createEl("h2", { text: "Seafile history" });
		const toolbar = container.createDiv({ cls: styles.toolbar });
		for (const [tab, label] of [["activity", "Activity"], ["file", "File versions"], ["snapshots", "Vault snapshots"], ["deleted", "Deleted files"]] as const) {
			const button = toolbar.createEl("button", { text: label });
			if (tab === this.tab) button.addClass("mod-cta");
			button.addEventListener("click", () => { void this.showTab(tab); });
		}
		try {
			if (this.tab === "activity") await this.renderActivity(container);
			else if (this.tab === "file") await this.renderFileHistory(container);
			else if (this.tab === "snapshots") await this.renderSnapshots(container);
			else await this.renderDeleted(container);
		} catch (error) {
			container.createEl("p", { text: `History could not be loaded: ${(error as Error).message}`, cls: styles.danger });
			new Setting(container).addButton(button => button.setButtonText("Retry").onClick(() => { void this.render(); }));
		}
	}

	private async loadHistory(reset: boolean): Promise<void> {
		if (reset) {
			this.page = 1;
			this.revisions = [];
		}
		const result = await this.plugin.server.getLibraryHistory(this.page, 50);
		this.revisions.push(...result.revisions);
		this.more = result.more;
		this.page++;
	}

	private async renderActivity(container: HTMLElement): Promise<void> {
		if (this.revisions.length === 0) await this.loadHistory(true);
		new Setting(container).setName("Filter history").addSearch(search => search
			.setPlaceholder("File, author, device, or description")
			.setValue(this.search)
			.onChange(value => {
				this.search = value.toLowerCase();
				void this.render();
			}));
		const groups = groupHistory(this.revisions, this.plugin.settings.historyGroupingMinutes)
			.filter(group => !this.search || JSON.stringify(group).toLowerCase().includes(this.search));
		for (const group of groups) {
			const element = container.createDiv({ cls: styles.activity });
			element.createDiv({ text: group.activities[0].description || "Library update" });
			const actor = group.authorName || "Unknown author";
			element.createDiv({
				text: `${new Date(group.createdAt).toLocaleString()} · ${actor}${group.deviceName ? ` · ${group.deviceName}` : ""}`,
				cls: styles.meta
			});
			if (group.activities.length > 1) element.createSpan({ text: `${group.activities.length} revisions`, cls: styles.badge });
			for (const path of group.paths) {
				const pathButton = element.createEl("button", { text: path });
				pathButton.addEventListener("click", () => { void this.showFileHistory(path); });
			}
		}
		if (this.more) new Setting(container).addButton(button => button.setButtonText("Load older activity").onClick(async () => {
			button.setDisabled(true);
			await this.loadHistory(false);
			await this.render();
		}));
	}

	private async renderFileHistory(container: HTMLElement): Promise<void> {
		let requestedPath = this.filePath;
		const activePath = this.app.workspace.getActiveFile()?.path ?? "";
		new Setting(container)
			.setName("File path")
			.setDesc("Enter a vault-relative path, use the active file, or select a path from Activity.")
			.addText(text => {
				text.setPlaceholder("folder/note.md").setValue(this.filePath).onChange(value => { requestedPath = value; });
				text.inputEl.addEventListener("keydown", event => {
					if (event.key === "Enter") void this.showFileHistory(requestedPath);
				});
			})
			.addButton(button => button.setButtonText("Show").setCta().onClick(() => { void this.showFileHistory(requestedPath); }))
			.addButton(button => button
				.setButtonText("Use active file")
				.setDisabled(!activePath)
				.onClick(() => { if (activePath) void this.showFileHistory(activePath); }));

		if (!this.filePath) {
			container.createEl("p", { text: "Choose a file to view its retained cloud versions and local checkpoints.", cls: styles.meta });
			return;
		}
		container.createEl("h3", { text: this.filePath });
		const panelContainer = container.createDiv({ cls: styles.embeddedPanel });
		this.filePanel = new FileHistoryPanel(this.plugin, panelContainer, this.filePath, true, undefined, () => { void this.render(); });
		await this.filePanel.open();
	}

	private async renderSnapshots(container: HTMLElement): Promise<void> {
		if (this.revisions.length === 0) await this.loadHistory(true);
		if (this.plugin.settings.lastSnapshotUndoCommit) {
			new Setting(container)
				.setName("Undo last vault restore")
				.setDesc("Restore the remote HEAD recorded immediately before the last vault restoration.")
				.addButton(button => button.setButtonText("Preview undo").onClick(() => {
					const revision = this.revisions.find(item => item.commitId === this.plugin.settings.lastSnapshotUndoCommit);
					if (revision) void this.previewSnapshot(container, revision);
					else new Notice("Load older snapshots until the undo point is visible.");
				}));
		}
		for (const revision of this.revisions) {
			const element = container.createDiv({ cls: styles.activity });
			const button = element.createEl("button", { text: revision.description || "Library snapshot", cls: styles.entry });
			button.createDiv({ text: `${new Date(revision.createdAt).toLocaleString()} · ${revision.authorName || "Unknown author"}`, cls: styles.meta });
			button.addEventListener("click", () => { void this.previewSnapshot(container, revision); });
		}
		if (this.more) new Setting(container).addButton(button => button.setButtonText("Load older snapshots").onClick(async () => {
			button.setDisabled(true);
			await this.loadHistory(false);
			await this.render();
		}));
	}

	private async previewSnapshot(container: HTMLElement, revision: LibraryRevision): Promise<void> {
		const notice = new Notice("Comparing vault snapshots…", 0);
		try {
			const current = await this.plugin.server.getHeadCommitId();
			const diff = await this.plugin.history.compareSnapshots(current, revision.commitId);
			const summary = container.createDiv({ cls: styles.activity });
			summary.createEl("h3", { text: `Snapshot ${new Date(revision.createdAt).toLocaleString()}` });
			summary.createEl("p", { text: `${diff.modifiedFiles.length} modified · ${diff.addedFiles.length} restored · ${diff.deletedFiles.length} removed files` });
			const details = summary.createEl("details");
			details.createEl("summary", { text: "Changed paths" });
			for (const path of [...diff.modifiedFiles, ...diff.addedFiles, ...diff.deletedFiles].slice(0, 500)) details.createDiv({ text: path });
			new Setting(summary).addButton(button => button.setButtonText("Restore entire vault").setWarning().onClick(() => {
				new SnapshotRestoreModal(this.app, this.plugin, revision, diff).open();
			}));
			summary.scrollIntoView({ behavior: "smooth" });
		} catch (error) {
			new Notice(`Could not compare snapshots: ${(error as Error).message}`);
		} finally {
			notice.hide();
		}
	}

	private async renderDeleted(container: HTMLElement): Promise<void> {
		if (this.deletedEntries.length === 0) await this.loadDeleted(true);
		new Setting(container)
			.setName(`${this.deletedTotal} retained deleted items`)
			.setDesc("Restoring creates a new Seafile revision and synchronizes it to connected devices.")
			.addButton(button => button.setButtonText("Restore selected").setCta().onClick(async () => {
				button.setDisabled(true);
				try {
					const entries = Array.from(this.selectedDeleted.values()).map(entry => ({ commitId: entry.commitId, path: this.deletedPath(entry) }));
					if (entries.length === 0) return;
					const restored = await this.plugin.server.restoreDeletedEntries(entries);
					if (restored.failed.length) new Notice(`${restored.failed.length} items could not be restored.`);
					else new Notice(`${restored.success.length} items restored.`);
					this.selectedDeleted.clear();
					await this.loadDeleted(true);
					this.plugin.sync.requestSync();
					await this.render();
				} catch (error) {
					new Notice(`Deleted items could not be restored: ${(error as Error).message}`, 0);
				} finally {
					button.setDisabled(false);
				}
			}));
		for (const entry of this.deletedEntries) {
			const row = container.createDiv({ cls: styles.activity });
			const checkbox = row.createEl("input", { type: "checkbox" });
			const path = this.deletedPath(entry);
			const selectionId = `${entry.commitId}:${path}`;
			checkbox.checked = this.selectedDeleted.has(selectionId);
			row.createSpan({ text: path });
			row.createDiv({ text: `${new Date(entry.deletedAt).toLocaleString()}${entry.isDirectory ? " · folder" : ` · ${entry.size.toLocaleString()} bytes`}`, cls: styles.meta });
			checkbox.addEventListener("change", () => {
				if (checkbox.checked) this.selectedDeleted.set(selectionId, entry);
				else this.selectedDeleted.delete(selectionId);
			});
			if (!entry.isDirectory) {
				const history = row.createEl("button", { text: "View version" });
				history.addEventListener("click", () => this.plugin.openDeletedFileHistory(entry));
			}
		}
		if (this.deletedEntries.length < this.deletedTotal) {
			new Setting(container).addButton(button => button.setButtonText("Load more deleted items").onClick(async () => {
				button.setDisabled(true);
				try {
					await this.loadDeleted(false);
					await this.render();
				} finally {
					button.setDisabled(false);
				}
			}));
		}
	}

	private async loadDeleted(reset: boolean): Promise<void> {
		if (reset) {
			this.deletedPage = 1;
			this.deletedEntries = [];
		}
		const result = await this.plugin.server.getDeletedEntries(this.deletedPage, 100);
		this.deletedEntries.push(...result.entries);
		this.deletedTotal = result.totalCount;
		this.deletedPage++;
	}

	private deletedPath(entry: DeletedEntry): string {
		return `${entry.parentDir.replace(/\/$/, "")}/${entry.name}` || `/${entry.name}`;
	}
}
