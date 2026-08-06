import { ItemView, Notice, Setting, normalizePath, type WorkspaceLeaf } from "obsidian";
import type SeafilePlugin from "../main";
import { groupHistory } from "../history/grouping";
import { compactLineDiff, groupDiffLines } from "../history/text_diff";
import { historyTextDiffLimit } from "../history/text_format";
import type { CommitSnapshotChanges, DeletedEntry, FileRevision, HistoryGroup, HistoryOperation, LibraryRevision, SnapshotFileChange } from "../history/types";
import { debug } from "../utils";
import { SnapshotRestoreModal } from "./snapshot_restore_modal";
import { FileHistoryPanel } from "./file_history_panel";
import styles from "./history.module.css";

export const HISTORY_VIEW_TYPE = "seafile-sync-history";
type HistoryTab = "activity" | "file" | "snapshots" | "deleted" | "issues";

export class HistoryView extends ItemView {
	private static readonly FILE_LIST_INITIAL = 20;
	private static readonly FILE_LIST_BATCH = 30;
	private static readonly RESTORED_TRASH_SUPPRESSION_MS = 60_000;
	private tab: HistoryTab = "activity";
	private page = 1;
	private revisions: LibraryRevision[] = [];
	private more = false;
	private search = "";
	private showActivityMetadataOnly = true;
	private deletedPage = 1;
	private deletedTotal = 0;
	private deletedEntries: DeletedEntry[] = [];
	private deletedLoaded = false;
	private readonly selectedDeleted = new Map<string, DeletedEntry>();
	private readonly recentlyRestoredDeleted = new Map<string, number>();
	private deletedRestoreStatus: { tone: "success" | "warning" | "error", message: string, details?: string[] } | undefined;
	private filePath = "";
	private fileSeededRevision: FileRevision | undefined;
	private filePanel: FileHistoryPanel | null = null;
	private readonly snapshotChanges = new Map<string, Promise<CommitSnapshotChanges>>();
	private renderGeneration = 0;

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

	async showFileHistory(path: string, seededRevision?: FileRevision): Promise<void> {
		this.filePath = normalizePath(path.replace(/^\/+/, ""));
		this.fileSeededRevision = seededRevision;
		this.tab = "file";
		await this.render();
	}

	private async render(): Promise<void> {
		const generation = ++this.renderGeneration;
		this.filePanel?.dispose();
		this.filePanel = null;
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.createEl("h2", { text: "History", cls: styles.viewTitle });
		const toolbar = container.createEl("nav", { cls: styles.toolbar, attr: { "aria-label": "History sections" } });
		for (const [tab, label, title] of [
			["activity", "Activity", "Library activity"],
			["file", "Files", "File versions"],
			["snapshots", "Snapshots", "Vault snapshots"],
			["deleted", "Deleted", "Deleted files"],
			["issues", "Issues", "Sync issues"]
		] as const) {
			const button = toolbar.createEl("button", { text: label, attr: { title, "aria-label": title } });
			if (tab === this.tab) button.addClass("mod-cta");
			button.addEventListener("click", () => { void this.showTab(tab); });
		}
		try {
			if (this.tab === "activity") await this.renderActivity(container, generation);
			else if (this.tab === "file") await this.renderFileHistory(container);
			else if (this.tab === "snapshots") await this.renderSnapshots(container);
			else if (this.tab === "deleted") await this.renderDeleted(container);
			else this.renderIssues(container);
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

	private async renderActivity(container: HTMLElement, generation: number): Promise<void> {
		if (this.revisions.length === 0) await this.loadHistory(true);
		if (generation !== this.renderGeneration) return;
		new Setting(container)
			.setName("Filter history")
			.addSearch(search => search
				.setPlaceholder("File, author, device, or description")
				.setValue(this.search)
				.onChange(value => {
					this.search = value.toLowerCase();
					void this.render();
				}))
			.addButton(button => {
				const updateButton = (): void => {
					button
						.setButtonText("Metadata")
						.setTooltip(this.showActivityMetadataOnly ? "Hide metadata-only changes" : "Show metadata-only changes");
					button.buttonEl.toggleClass("mod-cta", this.showActivityMetadataOnly);
					button.buttonEl.setAttribute("aria-pressed", String(this.showActivityMetadataOnly));
				};
				updateButton();
				button.onClick(() => {
					this.showActivityMetadataOnly = !this.showActivityMetadataOnly;
					void this.render();
				});
			});
		let groups = groupHistory(this.revisions, this.plugin.settings.historyGroupingMinutes)
			.filter(group => !this.search || JSON.stringify(group).toLowerCase().includes(this.search));
		if (!this.showActivityMetadataOnly && groups.length > 0) {
			const status = container.createDiv({ text: "Filtering revisions…", cls: styles.meta });
			groups = await this.filterMetadataOnlyGroups(groups, (completed, total) => {
				status.setText(`Filtering revisions ${completed}/${total}`);
			});
			status.remove();
			if (generation !== this.renderGeneration) return;
		}
		if (groups.length === 0) {
			container.createDiv({
				text: this.showActivityMetadataOnly ? "No matching activity" : "No matching content-changing activity",
				cls: styles.meta
			});
			return;
		}
		let date = "";
		let timeline: HTMLElement | null = null;
		for (const group of groups) {
			const groupDate = this.dateLabel(group.createdAt);
			if (groupDate !== date || !timeline) {
				date = groupDate;
				container.createDiv({ text: date, cls: styles.dateDivider });
				timeline = container.createDiv({ cls: styles.historyTimeline });
			}
			const element = timeline.createEl("details", { cls: `${styles.activity} ${styles.timelineCard} ${styles.activityCard}` });
			const summary = element.createEl("summary", { cls: styles.commitSummary });
			const heading = summary.createDiv({ cls: styles.cardHeading });
			const operation = group.activities[0].operation;
			const latestDescription = group.activities[0].description || "Library update";
			const groupedRevisions = group.activities.length > 1;
			heading.createSpan({ text: this.operationMarker(operation), cls: `${styles.operationMarker} ${styles[operation]}` });
			heading.createDiv({
				text: this.shortDescription(latestDescription, "Library update"),
				cls: styles.cardTitle,
				attr: {
					title: groupedRevisions
						? `${latestDescription}\n${group.activities.length} Seafile revisions grouped into one activity session.`
						: latestDescription
				}
			});
			if (groupedRevisions) heading.createSpan({
				text: `${group.activities.length} revisions`,
				cls: styles.revisionCount,
				attr: { title: `${group.activities.length} Seafile revisions grouped into this activity session` }
			});
			const actor = group.authorName || "Unknown author";
			const meta = summary.createDiv({
				text: `${actor} · ${this.relativeTime(group.createdAt)}`,
				cls: styles.meta,
				attr: { title: this.fullMetadata(group.createdAt, actor, group.deviceName) }
			});
			meta.setAttribute("aria-label", this.fullMetadata(group.createdAt, actor, group.deviceName));
			const body = element.createDiv({ cls: styles.commitBody });
			let loaded = false;
			element.addEventListener("toggle", () => {
				if (!element.open || loaded) return;
				loaded = true;
				void this.renderActivityDetails(body, group);
			});
		}
		if (this.more) new Setting(container).addButton(button => button.setButtonText("Load older activity").onClick(async () => {
			button.setDisabled(true);
			await this.loadHistory(false);
			await this.render();
		}));
	}

	private async renderActivityDetails(container: HTMLElement, group: HistoryGroup): Promise<void> {
		container.empty();
		container.createDiv({ text: "Loading changes…", cls: styles.meta });
		try {
			const commits = new Array<CommitSnapshotChanges | null>(group.activities.length).fill(null);
			let unavailable = 0;
			let nextCommit = 0;
			const worker = async (): Promise<void> => {
				while (nextCommit < group.activities.length) {
					const index = nextCommit++;
					try {
						commits[index] = await this.getSnapshotChanges(group.activities[index]);
					} catch {
						unavailable++;
					}
				}
			};
			await Promise.all(Array.from(
				{ length: Math.min(3, group.activities.length) },
				async () => await worker()
			));
			const files = new Map<string, { change: SnapshotFileChange, commit: CommitSnapshotChanges }>();
			for (const commit of commits) {
				if (!commit) continue;
				for (const file of commit.files) {
					const existing = files.get(file.path);
					if (existing) existing.change = this.mergeActivityFileChange(existing.change, file);
					else files.set(file.path, { change: file, commit });
				}
			}
			let changes = Array.from(files.values()).sort((left, right) => left.change.path.localeCompare(right.change.path));
			if (!this.showActivityMetadataOnly) changes = changes.filter(item => !this.isMetadataOnly(item.change));
			container.empty();
			container.createDiv({
				text: this.fileChangeSummary(changes.map(item => item.change), this.showActivityMetadataOnly),
				cls: styles.changeSummary
			});
			if (unavailable > 0) container.createDiv({ text: `${unavailable} older revision${unavailable === 1 ? "" : "s"} unavailable`, cls: styles.meta });
			if (changes.length === 0) {
				container.createDiv({ text: "No file-content changes", cls: styles.meta });
				return;
			}
			const list = container.createDiv({ cls: styles.changedFileList });
			const reveal = container.createDiv({ cls: styles.revealControls });
			const more = reveal.createEl("button");
			const all = reveal.createEl("button", { text: "Show all" });
			let visible = 0;
			const updateControls = (): void => {
				const remaining = changes.length - visible;
				reveal.hidden = remaining <= 0;
				more.setText(`Show ${Math.min(HistoryView.FILE_LIST_BATCH, remaining)} more`);
			};
			const append = (count: number): void => {
				const end = Math.min(changes.length, visible + count);
				for (const item of changes.slice(visible, end)) this.renderActivityFile(list, item.commit, item.change);
				visible = end;
				updateControls();
			};
			more.addEventListener("click", () => append(HistoryView.FILE_LIST_BATCH));
			all.addEventListener("click", () => append(changes.length - visible));
			append(HistoryView.FILE_LIST_INITIAL);
		} catch (error) {
			container.empty();
			container.createDiv({ text: `Changes unavailable: ${(error as Error).message}`, cls: styles.danger });
		}
	}

	private async renderFileHistory(container: HTMLElement): Promise<void> {
		let requestedPath = this.filePath;
		const activePath = this.app.workspace.getActiveFile()?.path ?? "";
		new Setting(container)
			.setName("File")
			.addText(text => {
				text.setPlaceholder("folder/note.md").setValue(this.filePath).onChange(value => { requestedPath = value; });
				text.inputEl.addEventListener("keydown", event => {
					if (event.key === "Enter") void this.showFileHistory(requestedPath);
				});
			})
			.addButton(button => button.setButtonText("Show").setCta().onClick(() => { void this.showFileHistory(requestedPath); }))
			.addButton(button => button
				.setButtonText("Active")
				.setTooltip("Use the active file")
				.setDisabled(!activePath)
				.onClick(() => { if (activePath) void this.showFileHistory(activePath); }));

		if (!this.filePath) {
			container.createEl("p", { text: "Choose a file to view its retained cloud versions and local checkpoints.", cls: styles.meta });
			return;
		}
		container.createEl("h3", { text: this.filePath, cls: styles.fileHeading, attr: { title: this.filePath } });
		const panelContainer = container.createDiv({ cls: styles.embeddedPanel });
		this.filePanel = new FileHistoryPanel(this.plugin, panelContainer, this.filePath, true, this.fileSeededRevision, () => { void this.render(); });
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
					if (revision) void this.openSnapshotRestore(revision);
					else new Notice("Load older snapshots until the undo point is visible.");
				}));
		}
		const timeline = container.createDiv({ cls: styles.historyTimeline });
		for (const revision of this.revisions) {
			const card = timeline.createEl("details", { cls: `${styles.activity} ${styles.timelineCard} ${styles.commitCard}` });
			const summary = card.createEl("summary", { cls: styles.commitSummary });
			summary.createDiv({
				text: this.shortDescription(revision.description, "Library snapshot"),
				cls: styles.commitTitle,
				attr: { title: revision.description || "Library snapshot" }
			});
			const actor = revision.authorName || "Unknown author";
			summary.createDiv({
				text: `${actor} · ${this.relativeTime(revision.createdAt)}`,
				cls: styles.meta,
				attr: { title: `${this.fullMetadata(revision.createdAt, actor, revision.deviceName)} · ${revision.commitId}` }
			});
			const body = card.createDiv({ cls: styles.commitBody });
			let loaded = false;
			card.addEventListener("toggle", () => {
				if (!card.open || loaded) return;
				loaded = true;
				void this.renderSnapshotChanges(body, revision);
			});
		}
		if (this.more) new Setting(container).addButton(button => button.setButtonText("Load older snapshots").onClick(async () => {
			button.setDisabled(true);
			await this.loadHistory(false);
			await this.render();
		}));
	}

	private async renderSnapshotChanges(container: HTMLElement, revision: LibraryRevision): Promise<void> {
		container.empty();
		container.createEl("p", { text: "Loading commit changes…", cls: styles.meta });
		try {
			const changes = await this.getSnapshotChanges(revision);
			container.empty();
			const fileCount = changes.files.length;
			container.createDiv({ text: this.fileChangeSummary(changes.files), cls: styles.changeSummary });
			if (fileCount === 0) {
				container.createEl("p", { text: "This commit contains no file-content changes.", cls: styles.meta });
			} else {
				const list = container.createDiv({ cls: styles.changedFileList });
				const reveal = container.createDiv({ cls: styles.revealControls });
				const more = reveal.createEl("button");
				const all = reveal.createEl("button", { text: "Show all" });
				let visible = 0;
				const updateControls = (): void => {
					const remaining = fileCount - visible;
					reveal.hidden = remaining <= 0;
					more.setText(`Show ${Math.min(HistoryView.FILE_LIST_BATCH, remaining)} more`);
				};
				const append = (count: number): void => {
					const end = Math.min(fileCount, visible + count);
					for (const change of changes.files.slice(visible, end)) {
						this.renderSnapshotFileChange(list.createDiv({ cls: styles.fileChange }), changes, change);
					}
					visible = end;
					updateControls();
				};
				more.addEventListener("click", () => append(HistoryView.FILE_LIST_BATCH));
				all.addEventListener("click", () => append(fileCount - visible));
				append(HistoryView.FILE_LIST_INITIAL);
			}
			new Setting(container).addButton(button => button.setButtonText("Restore this snapshot…").setDestructive().onClick(() => {
				void this.openSnapshotRestore(revision);
			}));
		} catch (error) {
			this.snapshotChanges.delete(revision.commitId);
			container.empty();
			container.createEl("p", { text: `Commit changes could not be loaded: ${(error as Error).message}`, cls: styles.danger });
		}
	}

	private renderSnapshotFileChange(
		container: HTMLElement,
		commit: CommitSnapshotChanges,
		change: SnapshotFileChange
	): void {
		const metadataOnly = this.isMetadataOnly(change);
		const supportsDiff = !metadataOnly && historyTextDiffLimit(change.path) !== null;
		const marker = change.kind === "added" ? "A" : metadataOnly ? "i" : change.kind === "modified" ? "M" : "D";
		const markerClass = change.kind === "added" ? styles.created : metadataOnly ? styles.metadataChanged : change.kind === "modified" ? styles.modified : styles.deleted;
		const changeTitle = this.fileChangeTitle(change);
		if (!supportsDiff) {
			const row = container.createDiv({
				cls: styles.fileChangeStatic,
				attr: { title: metadataOnly ? changeTitle : `${changeTitle}\nNo inline text diff is available for this file type.` }
			});
			const header = row.createDiv({ cls: styles.fileChangeHeader });
			header.createSpan({ text: marker, cls: `${styles.changeMarker} ${markerClass}` });
			header.createSpan({ text: change.path, cls: styles.filePath, attr: { title: change.path } });
			header.createSpan({ text: this.fileChangeScope(change), cls: styles.diffHint });
			return;
		}
		const row = container.createEl("details", { cls: styles.fileChangeDetails });
		const header = row.createEl("summary", { cls: styles.fileChangeHeader, attr: { title: `${changeTitle}\nShow exact line changes.` } });
		header.createSpan({ text: marker, cls: `${styles.changeMarker} ${markerClass}` });
		header.createSpan({ text: change.path, cls: styles.filePath, attr: { title: change.path } });
		const stats = header.createSpan({ text: "", cls: styles.lineStats });
		header.createSpan({ text: this.fileChangeScope(change), cls: styles.diffHint });
		const diff = row.createDiv({ cls: `${styles.diff} ${styles.inlineDiff}` });
		diff.createDiv({ text: "Loading diff…", cls: styles.meta });
		let loaded = false;
		row.addEventListener("toggle", () => {
			if (!row.open || loaded) return;
			loaded = true;
			void this.loadSnapshotFileDiff(diff, stats, commit, change).catch(() => { loaded = false; });
		});
	}

	private renderActivityFile(container: HTMLElement, commit: CommitSnapshotChanges, change: SnapshotFileChange): void {
		const metadataOnly = this.isMetadataOnly(change);
		const button = container.createEl("button", {
			cls: styles.activityFile,
			attr: { title: `${this.fileChangeTitle(change)}\nOpen version history for ${change.path}`, "aria-label": `Open version history for ${change.path}` }
		});
		const marker = change.kind === "added" ? "A" : metadataOnly ? "i" : change.kind === "modified" ? "M" : "D";
		const markerClass = change.kind === "added" ? styles.created : metadataOnly ? styles.metadataChanged : change.kind === "modified" ? styles.modified : styles.deleted;
		button.createSpan({ text: marker, cls: `${styles.changeMarker} ${markerClass}` });
		button.createSpan({ text: change.path, cls: styles.filePath });
		button.createSpan({ text: this.fileChangeScope(change), cls: styles.diffHint });
		button.addEventListener("click", () => {
			if (change.kind === "deleted") void this.showDeletedFileHistory(commit.commitId, change.path);
			else void this.showFileHistory(change.path);
		});
	}

	private async showDeletedFileHistory(commitId: string, path: string): Promise<void> {
		try {
			const revision = await this.plugin.history.getDeletedRevision(commitId, path);
			await this.showFileHistory(path, revision);
		} catch (error) {
			new Notice(`Deleted file history could not be opened: ${(error as Error).message}`, 0);
		}
	}

	private async loadSnapshotFileDiff(
		container: HTMLElement,
		stats: HTMLElement,
		commit: CommitSnapshotChanges,
		change: SnapshotFileChange
	): Promise<void> {
		container.empty();
		container.createDiv({ text: "Loading diff…", cls: styles.meta });
		try {
			const comparison = await this.plugin.history.compareTextFile(commit.parentCommitId, commit.commitId, change.path, change.kind);
			container.empty();
			stats.empty();
			if (!comparison) {
				container.createDiv({ text: "This file is too large for an inline diff.", cls: styles.meta });
				return;
			}
			if (comparison.additions !== null && comparison.deletions !== null) {
				stats.createSpan({ text: `+${comparison.additions}`, cls: styles.additionCount });
				stats.createSpan({ text: ` −${comparison.deletions}`, cls: styles.deletionCount });
			}
			for (const run of groupDiffLines(compactLineDiff(comparison.lines))) {
				const prefix = run.type === "add" ? "+ " : run.type === "remove" ? "− " : "  ";
				container.createDiv({
					text: run.lines.map(line => prefix + line).join("\n"),
					cls: run.type === "add" ? styles.added : run.type === "remove" ? styles.removed : undefined
				});
			}
		} catch (error) {
			container.empty();
			container.createDiv({ text: `Diff unavailable: ${(error as Error).message}`, cls: styles.danger });
			throw error;
		}
	}

	private getSnapshotChanges(revision: LibraryRevision): Promise<CommitSnapshotChanges> {
		let request = this.snapshotChanges.get(revision.commitId);
		if (!request) {
			request = this.plugin.history.compareCommitToParent(revision.commitId);
			this.snapshotChanges.set(revision.commitId, request);
			void request.catch(() => this.snapshotChanges.delete(revision.commitId));
		}
		return request;
	}

	private async filterMetadataOnlyGroups(
		groups: HistoryGroup[],
		onProgress: (completed: number, total: number) => void
	): Promise<HistoryGroup[]> {
		const activities = groups.flatMap(group => group.activities);
		const visible = new Map<string, boolean>();
		let next = 0;
		let completed = 0;
		const worker = async (): Promise<void> => {
			while (next < activities.length) {
				const activity = activities[next++];
				try {
					const changes = await this.getSnapshotChanges(activity);
					visible.set(activity.commitId, this.hasContentChanges(changes));
				} catch {
					// An unavailable revision must remain visible so the filter cannot hide unknown changes.
					visible.set(activity.commitId, true);
				} finally {
					onProgress(++completed, activities.length);
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(3, activities.length) }, async () => await worker()));

		return groups.flatMap(group => {
			const filtered = group.activities.filter(activity => visible.get(activity.commitId));
			if (filtered.length === 0) return [];
			const first = filtered[0];
			return [{
				id: first.commitId,
				createdAt: first.createdAt,
				authorName: first.authorName,
				deviceName: first.deviceName,
				activities: filtered,
				paths: Array.from(new Set(filtered.flatMap(activity => activity.paths)))
			}];
		});
	}

	private hasContentChanges(changes: CommitSnapshotChanges): boolean {
		return changes.files.some(change => !this.isMetadataOnly(change))
			|| changes.diff.addedDirectories.length > 0
			|| changes.diff.deletedDirectories.length > 0;
	}

	private shortDescription(description: string, fallback: string): string {
		return description.split("\n").map(line => line.trim()).find(Boolean) ?? fallback;
	}

	private fileChangeSummary(changes: SnapshotFileChange[], includeMetadata = true): string {
		const created = changes.filter(change => change.kind === "added").length;
		const contentModified = changes.filter(change => change.kind === "modified" && !this.isMetadataOnly(change)).length;
		const metadataUpdated = changes.filter(change => this.isMetadataOnly(change)).length;
		const deleted = changes.filter(change => change.kind === "deleted").length;
		const metadata = includeMetadata ? ` · ${metadataUpdated} metadata updated` : "";
		return `${created} created · ${contentModified} content modified${metadata} · ${deleted} deleted`;
	}

	private mergeActivityFileChange(newer: SnapshotFileChange, older: SnapshotFileChange): SnapshotFileChange {
		if (older.kind === "added") return { path: newer.path, kind: "added" };
		if (newer.kind !== "modified" || older.kind !== "modified") return newer;
		const metadata = (newer.metadataChanges ?? []).map(change => ({ ...change }));
		for (const olderChange of older.metadataChanges ?? []) {
			const current = metadata.find(change => change.field === olderChange.field);
			if (current) current.before = olderChange.before;
			else metadata.push({ ...olderChange });
		}
		return {
			path: newer.path,
			kind: "modified",
			contentChanged: newer.contentChanged !== false || older.contentChanged !== false,
			metadataChanges: metadata.filter(change => change.before !== change.after)
		};
	}

	private isMetadataOnly(change: SnapshotFileChange): boolean {
		return change.kind === "modified" && change.contentChanged === false;
	}

	private fileChangeScope(change: SnapshotFileChange): string {
		if (this.isMetadataOnly(change)) {
			const fields = (change.metadataChanges ?? []).map(item => this.metadataFieldLabel(item.field));
			return `metadata${fields.length ? ` · ${fields.join(", ")}` : ""}`;
		}
		return change.kind === "modified" ? "content" : change.kind === "added" ? "created" : "deleted";
	}

	private fileChangeTitle(change: SnapshotFileChange): string {
		const lines = [change.kind === "added" ? "File created." : change.kind === "deleted" ? "File deleted." : change.contentChanged ? "File content changed." : "File metadata changed; content is unchanged."];
		for (const metadata of change.metadataChanges ?? []) {
			lines.push(`${this.metadataFieldTitle(metadata.field)}: ${this.metadataValue(metadata.field, metadata.before)} → ${this.metadataValue(metadata.field, metadata.after)}`);
		}
		return lines.join("\n");
	}

	private metadataFieldLabel(field: "mtime" | "modifier" | "size"): string {
		return field === "mtime" ? "time" : field;
	}

	private metadataFieldTitle(field: "mtime" | "modifier" | "size"): string {
		return field === "mtime" ? "Modified time" : field === "modifier" ? "Modifier" : "Size";
	}

	private metadataValue(field: "mtime" | "modifier" | "size", value: string | number): string {
		if (field === "mtime" && typeof value === "number") return new Date(value * 1000).toLocaleString();
		if (field === "size" && typeof value === "number") return `${value.toLocaleString()} bytes`;
		return String(value || "—");
	}

	private operationMarker(operation: HistoryOperation): string {
		return ({ create: "+", modify: "●", rename: "↪", delete: "−", restore: "↶", snapshot: "◇", unknown: "·" })[operation];
	}

	private dateLabel(timestamp: number): string {
		const date = new Date(timestamp);
		const today = new Date();
		const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
		const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
		const days = Math.round((startToday - startDate) / (24 * 60 * 60 * 1000));
		if (days === 0) return "Today";
		if (days === 1) return "Yesterday";
		return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
	}

	private relativeTime(timestamp: number): string {
		const delta = timestamp - Date.now();
		const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
		const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
			["year", 365 * 24 * 60 * 60 * 1000],
			["month", 30 * 24 * 60 * 60 * 1000],
			["day", 24 * 60 * 60 * 1000],
			["hour", 60 * 60 * 1000],
			["minute", 60 * 1000]
		];
		for (const [unit, milliseconds] of units) {
			if (Math.abs(delta) >= milliseconds || unit === "minute") return formatter.format(Math.round(delta / milliseconds), unit);
		}
		return "now";
	}

	private fullMetadata(timestamp: number, actor: string, deviceName?: string): string {
		return `${new Date(timestamp).toLocaleString()} · ${actor}${deviceName ? ` · ${deviceName}` : ""}`;
	}

	private async openSnapshotRestore(revision: LibraryRevision): Promise<void> {
		const notice = new Notice("Comparing vault snapshots…", 0);
		try {
			const current = await this.plugin.server.getHeadCommitId();
			const diff = await this.plugin.history.compareSnapshots(current, revision.commitId);
			new SnapshotRestoreModal(this.app, this.plugin, revision, diff).open();
		} catch (error) {
			new Notice(`Could not compare snapshots: ${(error as Error).message}`);
		} finally {
			notice.hide();
		}
	}

	private async renderDeleted(container: HTMLElement): Promise<void> {
		if (!this.deletedLoaded) await this.loadDeleted(true);
		let restoreButtonEl: HTMLButtonElement | undefined;
		const updateRestoreButton = (): void => {
			if (!restoreButtonEl) return;
			const count = this.selectedDeleted.size;
			restoreButtonEl.disabled = count === 0;
			restoreButtonEl.setText(count === 0 ? "Restore selected" : `Restore selected (${count})`);
		};
		new Setting(container)
			.setName(`${this.deletedTotal} retained deleted items`)
			.setDesc("Restoring creates a new Seafile revision and synchronizes it to connected devices.")
			.addButton(button => {
				restoreButtonEl = button.buttonEl;
				button.setButtonText("Restore selected").setCta().onClick(async () => {
					const selected = Array.from(this.selectedDeleted.entries());
					const entries = selected.map(([, entry]) => ({ commitId: entry.commitId, path: this.deletedPath(entry) }));
					if (entries.length === 0) return;
					button.setDisabled(true).setButtonText(`Restoring ${entries.length}…`);
					this.deletedRestoreStatus = undefined;
					try {
						const restored = await this.plugin.server.restoreDeletedEntries(entries);
						const successfulPaths = new Set(restored.success.map(path => this.normalizedDeletedPath(path)));
						const failedPaths = new Map(restored.failed.map(item => [this.normalizedDeletedPath(item.path), item.error]));
						const restoredIds = new Set<string>();
						const failedSelections = new Map<string, DeletedEntry>();
						for (const [selectionId, entry] of selected) {
							const path = this.normalizedDeletedPath(this.deletedPath(entry));
							if (successfulPaths.has(path)) {
								restoredIds.add(selectionId);
								this.recentlyRestoredDeleted.set(selectionId, Date.now() + HistoryView.RESTORED_TRASH_SUPPRESSION_MS);
							} else if (failedPaths.has(path)) {
								failedSelections.set(selectionId, entry);
							}
						}

						if (restoredIds.size > 0) {
							this.deletedEntries = this.deletedEntries.filter(entry => !restoredIds.has(this.deletedSelectionId(entry)));
							this.deletedTotal = Math.max(this.deletedEntries.length, this.deletedTotal - restoredIds.size);
							if (this.plugin.settings.enableSync) this.plugin.sync.requestSync();
						}
						this.selectedDeleted.clear();
						for (const [selectionId, entry] of failedSelections) this.selectedDeleted.set(selectionId, entry);

						if (restoredIds.size > 0 && restored.failed.length === 0) {
							const itemLabel = restoredIds.size === 1 ? "item" : "items";
							this.deletedRestoreStatus = {
								tone: "success",
								message: this.plugin.settings.enableSync
									? `Restored ${restoredIds.size} ${itemLabel}. Synchronization has been requested; restored files may take a moment to appear in the vault.`
									: `Restored ${restoredIds.size} ${itemLabel} in Seafile. Enable synchronization to download them to this device.`
							};
						} else if (restoredIds.size > 0) {
							this.deletedRestoreStatus = {
								tone: "warning",
								message: `Restored ${restoredIds.size} item${restoredIds.size === 1 ? "" : "s"}, but ${restored.failed.length} could not be restored. Failed items remain selected.`,
								details: restored.failed.map(item => `${item.path}: ${item.error}`)
							};
						} else if (restored.failed.length > 0) {
							debug.warn("[Seafile Improved] Deleted items could not be restored.", restored.failed);
							this.deletedRestoreStatus = {
								tone: "error",
								message: `${restored.failed.length} item${restored.failed.length === 1 ? "" : "s"} could not be restored.`,
								details: restored.failed.map(item => `${item.path}: ${item.error}`)
							};
						} else {
							this.deletedRestoreStatus = {
								tone: "error",
								message: "Seafile did not confirm that any selected items were restored. The selection has been kept so you can try again."
							};
							for (const [selectionId, entry] of selected) this.selectedDeleted.set(selectionId, entry);
						}
						await this.render();
					} catch (error) {
						debug.error("[Seafile Improved] Deleted-item restore failed.", { entries, error });
						this.deletedRestoreStatus = {
							tone: "error",
							message: `Deleted items could not be restored: ${(error as Error).message}`
						};
						await this.render();
					} finally {
						button.setDisabled(false);
					}
				});
				updateRestoreButton();
			})
			.addButton(button => button.setButtonText("Refresh").setTooltip("Refresh deleted items from Seafile").onClick(async () => {
				button.setDisabled(true);
				try {
					await this.loadDeleted(true);
					await this.render();
				} finally {
					button.setDisabled(false);
				}
			}));
		if (this.deletedRestoreStatus) {
			const status = container.createDiv({
				cls: `${styles.restoreStatus} ${styles[this.deletedRestoreStatus.tone]}`,
				attr: { role: this.deletedRestoreStatus.tone === "error" ? "alert" : "status" }
			});
			status.createDiv({ text: this.deletedRestoreStatus.message });
			if (this.deletedRestoreStatus.details?.length) {
				const details = status.createEl("details");
				details.createEl("summary", { text: "Show details" });
				for (const detail of this.deletedRestoreStatus.details) details.createDiv({ text: detail, cls: styles.restoreDetail });
			}
		}
		if (this.deletedEntries.length === 0) {
			container.createDiv({ text: "No retained deleted items.", cls: styles.meta });
			return;
		}
		for (const entry of this.deletedEntries) {
			const row = container.createDiv({ cls: styles.activity });
			const checkbox = row.createEl("input", { type: "checkbox" });
			const path = this.deletedPath(entry);
			const selectionId = this.deletedSelectionId(entry);
			checkbox.checked = this.selectedDeleted.has(selectionId);
			row.createDiv({ text: path, cls: styles.filePath, attr: { title: path } });
			row.createDiv({ text: `${new Date(entry.deletedAt).toLocaleString()}${entry.isDirectory ? " · folder" : ` · ${entry.size.toLocaleString()} bytes`}`, cls: styles.meta });
			checkbox.addEventListener("change", () => {
				if (checkbox.checked) this.selectedDeleted.set(selectionId, entry);
				else this.selectedDeleted.delete(selectionId);
				updateRestoreButton();
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
		this.pruneRestoredTrashSuppressions();
		if (reset) {
			this.deletedPage = 1;
			this.deletedEntries = [];
		}
		const result = await this.plugin.server.getDeletedEntries(this.deletedPage, 100);
		const visibleEntries = result.entries.filter(entry => !this.recentlyRestoredDeleted.has(this.deletedSelectionId(entry)));
		const suppressedCount = result.entries.length - visibleEntries.length;
		const knownEntries = new Set(this.deletedEntries.map(entry => this.deletedSelectionId(entry)));
		this.deletedEntries.push(...visibleEntries.filter(entry => !knownEntries.has(this.deletedSelectionId(entry))));
		this.deletedTotal = Math.max(this.deletedEntries.length, result.totalCount - suppressedCount);
		this.deletedPage++;
		this.deletedLoaded = true;
	}

	private pruneRestoredTrashSuppressions(): void {
		const now = Date.now();
		for (const [selectionId, expiresAt] of this.recentlyRestoredDeleted) {
			if (expiresAt <= now) this.recentlyRestoredDeleted.delete(selectionId);
		}
	}

	private deletedSelectionId(entry: DeletedEntry): string {
		return `${entry.commitId}:${this.normalizedDeletedPath(this.deletedPath(entry))}`;
	}

	private normalizedDeletedPath(path: string): string {
		return `/${path.replace(/^\/+/, "")}`;
	}

	private deletedPath(entry: DeletedEntry): string {
		return `${entry.parentDir.replace(/\/$/, "")}/${entry.name}`;
	}

	private renderIssues(container: HTMLElement): void {
		const issues = this.plugin.issues.list();
		const openCount = issues.filter(issue => !issue.resolved).length;
		new Setting(container)
			.setName(`${openCount} open sync issue${openCount === 1 ? "" : "s"}`)
			.setDesc("Actionable conflicts, safety stops, recovery actions, and errors that exhaust automatic retries are retained on this device.")
			.addButton(button => button.setButtonText("Clear resolved").onClick(() => {
				this.plugin.issues.clearResolved();
				void this.render();
			}));
		if (issues.length === 0) {
			container.createEl("p", { text: "No sync issues have been recorded.", cls: styles.meta });
			return;
		}
		for (const issue of issues) {
			const row = container.createDiv({ cls: styles.activity });
			row.createEl("strong", { text: `${issue.resolved ? "Resolved" : "Open"} · ${issue.kind}` });
			row.createDiv({ text: issue.message, cls: styles.issueMessage });
			row.createDiv({
				text: `${new Date(issue.lastSeenAt).toLocaleString()}${issue.occurrences > 1 ? ` · occurred ${issue.occurrences} times` : ""}`,
				cls: styles.meta
			});
			for (const path of [issue.path, issue.relatedPath].filter((value): value is string => !!value)) {
				const pathButton = row.createEl("button", { text: path });
				pathButton.addEventListener("click", () => { void this.app.workspace.openLinkText(path, "", false); });
			}
			new Setting(row).addButton(button => button
				.setButtonText(issue.resolved ? "Reopen" : "Mark resolved")
				.onClick(() => {
					this.plugin.issues.resolve(issue.id, !issue.resolved);
					void this.render();
				}));
		}
	}
}
