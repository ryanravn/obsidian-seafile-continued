import { Notice, Setting } from "obsidian";
import type SeafilePlugin from "../main";
import type { FileMetadataChange, FileRevision, LibraryRevision, LocalCheckpoint } from "../history/types";
import { compactLineDiff, createLineDiffResult, groupDiffLines } from "../history/text_diff";
import { formatHistoryText, historyTextDiffLimit, historyTextKind, isLikelyTextContent } from "../history/text_format";
import { HttpError } from "../server";
import styles from "./history.module.css";

type HistorySelection =
	| { source: "remote", revision: FileRevision }
	| { source: "metadata", revision: FileRevision }
	| { source: "local", checkpoint: LocalCheckpoint };
type RestorableHistorySelection = Exclude<HistorySelection, { source: "metadata" }>;

type MetadataScanState = "idle" | "scanning" | "complete";
type RemoteRevisionKind = "created" | "modified" | "renamed" | "deleted" | "unknown";

export class FileHistoryPanel {
	private static readonly CONTENT_CACHE_LIMIT_BYTES = 32 * 1024 * 1024;
	private selections: HistorySelection[] = [];
	private selected: HistorySelection | null = null;
	private comparisonMode: "previous" | "current" = "previous";
	private readonly contentCache = new Map<string, ArrayBuffer>();
	private contentCacheBytes = 0;
	private readonly versionEntries = new Map<string, HTMLElement>();
	private readonly versionButtons = new Map<string, HTMLButtonElement>();
	private readonly remoteRevisionKinds = new Map<string, RemoteRevisionKind>();
	private nextCommit: string | null = null;
	private previewEl: HTMLElement;
	private timelineEl: HTMLElement;
	private objectUrl: string | null = null;
	private remoteError = "";
	private deletedHistorySkipNewest = true;
	private remoteLoading = false;
	private deletedHistoryScanned = 0;
	private deletedHistoryBatchEmpty = false;
	private metadataScanState: MetadataScanState = "idle";
	private metadataScanCancelled = false;
	private metadataScanChecked = 0;
	private metadataScanFound = 0;
	private metadataScanFailures = 0;
	private metadataScanPhase = "";
	private metadataScanProgressEl: HTMLElement | null = null;
	private showMetadataRevisions = true;
	private selectionGeneration = 0;
	private readonly relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });

	constructor(
		private readonly plugin: SeafilePlugin,
		private readonly container: HTMLElement,
		private readonly path: string,
		private readonly embedded = false,
		private seededRevision?: FileRevision,
		private readonly onRestored?: () => void
	) {}

	async open(): Promise<void> {
		this.container.empty();
		const layout = this.container.createDiv({ cls: `${styles.layout} ${this.embedded ? styles.embeddedLayout : styles.modalLayout}` });
		this.timelineEl = layout.createDiv({ cls: styles.timeline });
		this.previewEl = layout.createDiv({ cls: styles.preview });
		this.timelineEl.createEl("p", { text: "Loading versions…", cls: styles.meta });
		await this.loadInitial();
	}

	dispose(): void {
		this.selectionGeneration++;
		this.metadataScanCancelled = true;
		this.revokeObjectUrl();
		this.contentCache.clear();
		this.contentCacheBytes = 0;
	}

	private revokeObjectUrl(): void {
		if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
		this.objectUrl = null;
	}

	private async loadInitial(): Promise<void> {
		try {
			const remotePath = "/" + this.path.replace(/^\/+/, "");
			const local = await this.plugin.checkpoints.list(this.path);
			this.selections = this.sortSelections([
				...(this.seededRevision ? [{ source: "remote" as const, revision: this.seededRevision }] : []),
				...local.map(checkpoint => ({ source: "local" as const, checkpoint }))
			]);
			this.remoteLoading = true;
			this.renderTimeline();
			if (this.selections[0]) void this.select(this.selections[0]);

			const remote = await this.loadRemoteHistory(remotePath);
			this.remoteLoading = false;
			this.nextCommit = remote.nextCommit;
			this.selections = this.sortSelections([
				...this.selections,
				...remote.revisions.map(revision => ({ source: "remote" as const, revision }))
			]);
			this.classifyRemoteRevisions();
			this.renderTimeline();
			if (!this.selected && this.selections[0]) void this.select(this.selections[0]);
		} catch (error) {
			this.remoteLoading = false;
			this.timelineEl.empty();
			this.timelineEl.createEl("p", { text: `Failed to load history: ${(error as Error).message}`, cls: styles.danger });
		}
	}

	private async loadRemoteHistory(remotePath: string, startCommit?: string): Promise<{ revisions: FileRevision[], nextCommit: string | null }> {
		try {
			if (this.seededRevision?.deleted) {
				const page = await this.plugin.history.getDeletedFileHistory(
					this.seededRevision,
					startCommit,
					this.deletedHistorySkipNewest
				);
				this.deletedHistorySkipNewest = page.skipNewestVersion;
				this.deletedHistoryScanned += page.scannedCommits;
				this.deletedHistoryBatchEmpty = page.revisions.length === 0;
				return page;
			}
			return await this.plugin.server.getFileHistory(remotePath, startCommit ?? this.seededRevision?.commitId ?? "");
		} catch (error) {
			let failure = error;
			if (!this.seededRevision && error instanceof HttpError && error.status === 404) {
				try {
					const retained = await this.plugin.history.findRetainedDeletedRevision(remotePath);
					if (retained) {
						this.seededRevision = retained;
						this.remoteError = "";
						return await this.loadRemoteHistory(remotePath, startCommit);
					}
				} catch (recoveryError) {
					failure = recoveryError;
				}
			}
			this.remoteError = (failure as Error).message;
			console.warn(`[Seafile Improved] ${this.seededRevision?.deleted ? "Deleted file" : "File"} history scan failed`, {
				path: remotePath,
				commit: this.seededRevision?.commitId.slice(0, 12),
				error: failure
			});
			return { revisions: [], nextCommit: null };
		}
	}

	private renderMetadataScanControl(): void {
		const setting = new Setting(this.timelineEl)
			.setName("Metadata changes")
			.setDesc(this.metadataScanDescription());
		setting.settingEl.addClass(styles.metadataScanControl);
		this.metadataScanProgressEl = setting.descEl;
		setting.addButton(button => {
			if (this.metadataScanState === "scanning") {
				button.setButtonText("Cancel").setTooltip("Stop scanning after the current requests finish").onClick(() => {
					this.metadataScanCancelled = true;
					button.setDisabled(true).setButtonText("Stopping…");
				});
				return;
			}
			if (this.metadataScanState === "complete" && this.metadataScanFound > 0) {
				button
					.setButtonText(this.showMetadataRevisions ? "Hide" : "Show")
					.setTooltip(`${this.showMetadataRevisions ? "Hide" : "Show"} scanned metadata-only revisions`)
					.onClick(() => {
						this.showMetadataRevisions = !this.showMetadataRevisions;
						if (!this.showMetadataRevisions && this.selected?.source === "metadata") {
							const fallback = this.selections.find(selection => selection.source !== "metadata");
							this.renderTimeline();
							if (fallback) void this.select(fallback);
							else {
								this.selected = null;
								this.previewEl.empty();
							}
						} else this.renderTimeline();
					});
				return;
			}
			button
				.setButtonText(this.metadataScanState === "complete" ? "Scan again" : "Scan")
				.setTooltip("Scan retained library commits for metadata-only changes to this file")
				.onClick(() => { void this.scanMetadataHistory(); });
		});
	}

	private metadataScanDescription(): string {
		if (this.metadataScanState === "scanning") {
			const results = `${this.metadataScanChecked.toLocaleString()} checked · ${this.metadataScanFound.toLocaleString()} found`;
			const failures = this.metadataScanFailures ? ` · ${this.metadataScanFailures.toLocaleString()} unavailable` : "";
			return `${this.metadataScanPhase || "Scanning retained revisions"} · ${results}${failures}`;
		}
		if (this.metadataScanState === "complete") {
			const failures = this.metadataScanFailures ? ` · ${this.metadataScanFailures.toLocaleString()} unavailable` : "";
			return `${this.metadataScanFound.toLocaleString()} metadata-only revision${this.metadataScanFound === 1 ? "" : "s"} found · ${this.metadataScanChecked.toLocaleString()} library revisions checked${failures}`;
		}
		return this.metadataScanPhase || "Run an explicit commit-tree scan to include metadata-only revisions.";
	}

	private updateMetadataScanProgress(): void {
		this.metadataScanProgressEl?.setText(this.metadataScanDescription());
	}

	private async scanMetadataHistory(): Promise<void> {
		this.selections = this.selections.filter(selection => selection.source !== "metadata");
		this.metadataScanState = "scanning";
		this.metadataScanCancelled = false;
		this.metadataScanChecked = 0;
		this.metadataScanFound = 0;
		this.metadataScanFailures = 0;
		this.metadataScanPhase = "Loading complete file history";
		this.showMetadataRevisions = true;
		this.renderTimeline();
		try {
			await this.loadAllRemoteVersionsForMetadataScan();
			if (this.metadataScanCancelled) {
				this.finishCancelledMetadataScan();
				return;
			}
			this.classifyRemoteRevisions();
			const remoteRevisions = this.selections
				.filter((selection): selection is Extract<HistorySelection, { source: "remote" }> => selection.source === "remote")
				.map(selection => selection.revision)
				.sort((left, right) => right.createdAt - left.createdAt);
			if (remoteRevisions.length === 0) throw new Error("No retained file versions are available to bound the metadata scan.");

			const renamedPaths = new Map(remoteRevisions.flatMap(revision => revision.renamedFrom
				? [[revision.commitId, this.normalizeRemotePath(revision.renamedFrom)] as const]
				: []));
			const seen = new Set<string>();
			let historicalPath = this.normalizeRemotePath(this.path);
			let page = 1;
			let more = true;
			let reachedCreationBoundary = false;
			while (more && !reachedCreationBoundary && !this.metadataScanCancelled) {
				this.metadataScanPhase = `Loading library history page ${page}`;
				this.updateMetadataScanProgress();
				const result = await this.plugin.server.getLibraryHistory(page, 50);
				const batch: Array<{ revision: LibraryRevision, path: string, parentPath: string }> = [];
				for (const revision of result.revisions) {
					if (seen.has(revision.commitId)) continue;
					seen.add(revision.commitId);
					const renamedFrom = renamedPaths.get(revision.commitId);
					batch.push({ revision, path: historicalPath, parentPath: renamedFrom ?? historicalPath });
					if (renamedFrom) historicalPath = renamedFrom;
				}
				this.metadataScanPhase = "Comparing file metadata";
				reachedCreationBoundary = await this.scanMetadataBatch(batch);
				page++;
				more = result.more;
			}
			if (this.metadataScanCancelled) {
				this.finishCancelledMetadataScan();
				return;
			}
			this.metadataScanState = "complete";
			this.metadataScanPhase = "";
			this.renderTimeline();
		} catch (error) {
			this.selections = this.selections.filter(selection => selection.source !== "metadata");
			this.metadataScanState = "idle";
			this.metadataScanFound = 0;
			this.metadataScanPhase = `Last scan stopped: ${(error as Error).message}`;
			this.renderTimeline();
			new Notice(`Metadata history scan failed: ${(error as Error).message}`, 0);
		}
	}

	private async loadAllRemoteVersionsForMetadataScan(): Promise<void> {
		const seenCursors = new Set<string>();
		while (this.nextCommit && !this.metadataScanCancelled) {
			const cursor = this.nextCommit;
			if (seenCursors.has(cursor)) throw new Error("File-history pagination repeated the same revision.");
			seenCursors.add(cursor);
			const page = await this.loadRemoteHistory(this.normalizeRemotePath(this.path), cursor);
			if (this.remoteError) throw new Error(this.remoteError);
			this.nextCommit = page.nextCommit;
			this.selections = this.sortSelections([
				...this.selections,
				...page.revisions.map(revision => ({ source: "remote" as const, revision }))
			]);
		}
	}

	private async scanMetadataBatch(
		batch: Array<{ revision: LibraryRevision, path: string, parentPath: string }>
	): Promise<boolean> {
		let next = 0;
		const results = new Array<{ revision: FileRevision | null, creationBoundary: boolean } | null>(batch.length).fill(null);
		const failed = new Set<number>();
		const worker = async (): Promise<void> => {
			while (next < batch.length && !this.metadataScanCancelled) {
				const index = next++;
				const candidate = batch[index];
				try {
					results[index] = await this.plugin.history.scanFileMetadataRevision(candidate.revision, candidate.path, candidate.parentPath);
				} catch {
					failed.add(index);
					this.metadataScanFailures++;
				} finally {
					this.metadataScanChecked++;
					this.updateMetadataScanProgress();
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(3, batch.length) }, async () => await worker()));
		let stopIndex = batch.length;
		for (let index = 0; index < batch.length; index++) {
			if (failed.has(index) || results[index]?.creationBoundary) {
				stopIndex = index;
				break;
			}
		}
		const found = results.slice(0, stopIndex + 1).flatMap(result => result?.revision ? [result.revision] : []);
		this.metadataScanFound += found.length;
		this.updateMetadataScanProgress();
		this.selections = this.sortSelections([
			...this.selections,
			...found.map(revision => ({ source: "metadata" as const, revision }))
		]);
		return stopIndex < batch.length;
	}

	private finishCancelledMetadataScan(): void {
		this.selections = this.selections.filter(selection => selection.source !== "metadata");
		this.metadataScanState = "idle";
		this.metadataScanPhase = "Scan cancelled. Metadata-only results were discarded.";
		this.metadataScanFound = 0;
		this.renderTimeline();
	}

	private renderTimeline(): void {
		this.timelineEl.empty();
		this.versionEntries.clear();
		this.versionButtons.clear();
		this.metadataScanProgressEl = null;
		if (this.remoteError) this.timelineEl.createEl("p", { text: `Cloud history unavailable: ${this.remoteError}`, cls: styles.danger });
		if (this.remoteLoading) {
			this.timelineEl.createEl("p", {
				text: this.selections.length === 0 ? "Loading cloud versions…" : "Loading cloud versions in the background…",
				cls: styles.meta
			});
		} else if (this.seededRevision?.deleted && this.deletedHistoryScanned > 0) {
			const message = this.deletedHistoryBatchEmpty && this.nextCommit
				? `No older content change in this batch · ${this.deletedHistoryScanned.toLocaleString()} commits checked`
				: `${this.deletedHistoryScanned.toLocaleString()} older commit${this.deletedHistoryScanned === 1 ? "" : "s"} checked`;
			this.timelineEl.createEl("p", { text: message, cls: styles.meta });
		}
		if (!this.seededRevision?.deleted) this.renderMetadataScanControl();
		const visibleSelections = this.selections.filter(selection => this.showMetadataRevisions || selection.source !== "metadata");
		if (visibleSelections.length === 0) {
			if (!this.remoteLoading) this.timelineEl.createEl("p", { text: "No retained versions were found.", cls: styles.meta });
			return;
		}
		for (const selection of visibleSelections) {
			const entry = this.timelineEl.createDiv({
				cls: `${styles.versionEntry} ${selection.source === "metadata" ? styles.metadataVersion : ""}`
			});
			const button = entry.createEl("button", { cls: styles.entry });
			if (this.selected && this.selectionId(this.selected) === this.selectionId(selection)) {
				entry.addClass(styles.selectedVersion);
				button.addClass(styles.selected);
			}
			const revision = this.remoteRevision(selection);
			const title = selection.source === "metadata"
				? "Metadata updated"
				: revision
					? this.remoteRevisionTitle(revision)
					: "Local checkpoint";
			button.createDiv({
				text: title,
				cls: styles.cardTitle,
				attr: revision?.description ? { title: revision.description } : undefined
			});
			if (selection.source === "metadata") {
				button.createDiv({
					text: this.metadataFieldSummary(revision?.metadataChanges ?? []),
					cls: styles.metadataSummary,
					attr: { title: this.metadataChangesTitle(revision?.metadataChanges ?? []) }
				});
			}
			const source = selection.source === "metadata"
				? "Metadata-only revision"
				: revision?.deleted ? "Retained deletion" : revision ? "Cloud version" : "Local checkpoint";
			const author = revision ? revision.authorName : "This device";
			button.createDiv({
				text: `${author || source} · ${this.relativeTime(this.createdAt(selection))}`,
				cls: styles.meta,
				attr: { title: `${new Date(this.createdAt(selection)).toLocaleString()} · ${source}` }
			});
			button.addEventListener("click", () => { void this.select(selection); });
			const id = this.selectionId(selection);
			this.versionEntries.set(id, entry);
			this.versionButtons.set(id, button);
		}
		if (this.nextCommit && this.metadataScanState !== "scanning") {
			const buttonText = this.remoteLoading
				? "Scanning older history…"
				: this.seededRevision?.deleted ? "Continue scanning older history" : "Load older versions";
			new Setting(this.timelineEl).addButton(button => {
				button.setButtonText(buttonText).setDisabled(this.remoteLoading).onClick(async () => {
					const cursor = this.nextCommit!;
					try {
						this.remoteLoading = true;
						this.renderTimeline();
						const page = await this.loadRemoteHistory("/" + this.path.replace(/^\/+/, ""), cursor);
						this.nextCommit = page.nextCommit;
						this.selections = this.sortSelections([
							...this.selections,
							...page.revisions.map(revision => ({ source: "remote" as const, revision }))
						]);
						this.classifyRemoteRevisions();
					} catch (error) {
						new Notice(`Older versions could not be loaded: ${(error as Error).message}`);
					} finally {
						this.remoteLoading = false;
						this.renderTimeline();
					}
				});
			});
		}
		if (this.embedded && this.selected) this.versionEntries.get(this.selectionId(this.selected))?.append(this.previewEl);
	}

	private async select(selection: HistorySelection): Promise<void> {
		const generation = ++this.selectionGeneration;
		this.selected = selection;
		this.updateTimelineSelection();
		this.previewEl.empty();
		this.revokeObjectUrl();
		if (selection.source === "metadata") {
			this.renderMetadataRevision(selection.revision);
			return;
		}
		this.previewEl.createEl("p", { text: "Loading revision…", cls: styles.meta });
		try {
			const content = await this.readSelection(selection);
			if (!this.isSelectionCurrent(selection, generation)) return;
			this.previewEl.empty();
			await this.renderContent(selection, content, generation);
			if (this.isSelectionCurrent(selection, generation)) this.renderActions(selection);
		} catch (error) {
			if (!this.isSelectionCurrent(selection, generation)) return;
			if (selection.source === "local") {
				this.selections = this.selections.filter(candidate =>
					candidate.source !== "local" || candidate.checkpoint.objectId !== selection.checkpoint.objectId
				);
				const fallback = this.selections.find(candidate => candidate.source !== "metadata") ?? this.selections[0];
				this.renderTimeline();
				console.warn("[Seafile Improved] Local checkpoint unavailable", { path: this.path, checkpoint: selection.checkpoint.id, error });
				if (fallback) {
					new Notice("Local checkpoint unavailable; showing the next retained version.");
					await this.select(fallback);
					return;
				}
			}
			this.previewEl.empty();
			this.previewEl.createEl("p", { text: `Failed to load revision: ${(error as Error).message}`, cls: styles.danger });
		}
	}

	private updateTimelineSelection(): void {
		const selectedId = this.selected ? this.selectionId(this.selected) : "";
		for (const [id, entry] of this.versionEntries) {
			const active = id === selectedId;
			entry.toggleClass(styles.selectedVersion, active);
			this.versionButtons.get(id)?.toggleClass(styles.selected, active);
		}
		if (this.embedded && selectedId) this.versionEntries.get(selectedId)?.append(this.previewEl);
	}

	private isSelectionCurrent(selection: HistorySelection, generation: number): boolean {
		return generation === this.selectionGeneration
			&& this.selected !== null
			&& this.selectionId(this.selected) === this.selectionId(selection);
	}

	private async renderContent(selection: HistorySelection, content: ArrayBuffer, generation: number): Promise<void> {
		const lower = this.path.toLowerCase();
		const textLimit = historyTextDiffLimit(this.path);
		const isText = historyTextKind(this.path) !== null || isLikelyTextContent(content);
		if (textLimit !== null && content.byteLength <= textLimit && isText) {
			const selected = formatHistoryText(this.path, new TextDecoder().decode(content));
			const deleted = selection.source === "remote" && selection.revision.deleted === true;
			const index = this.selections.findIndex(candidate => this.selectionId(candidate) === this.selectionId(selection));
			const previous = index >= 0
				? this.selections.slice(index + 1).find(candidate => candidate.source !== "metadata")
				: undefined;
			let before = "";
			let after = selected;
			let comparisonLabel = "No older retained version; showing this version as newly created.";
			if (deleted) {
				before = selected;
				after = "";
				comparisonLabel = "File deletion compared with the retained content.";
			} else if (this.comparisonMode === "current") {
				const current = await this.plugin.app.vault.adapter.read(this.path).catch(() => "");
				if (!this.isSelectionCurrent(selection, generation)) return;
				if (new TextEncoder().encode(current).byteLength > textLimit) {
					this.previewEl.createDiv({ text: "The current file is too large for an inline comparison.", cls: styles.meta });
					return;
				}
				before = formatHistoryText(this.path, current);
				comparisonLabel = "Compared with the file currently in the vault.";
			} else if (previous) {
				const previousContent = await this.readSelection(previous);
				if (!this.isSelectionCurrent(selection, generation)) return;
				if (previousContent.byteLength > textLimit) {
					this.previewEl.createDiv({ text: "The previous version is too large for an inline comparison.", cls: styles.meta });
					return;
				}
				before = formatHistoryText(this.path, new TextDecoder().decode(previousContent));
				comparisonLabel = `Compared with the previous retained version from ${new Date(this.createdAt(previous)).toLocaleString()}.`;
			}
			const result = createLineDiffResult(before, after);
			const controls = this.previewEl.createDiv({ cls: styles.comparisonControls, attr: { title: comparisonLabel } });
			controls.createSpan({ text: deleted ? "Deleted" : "Compare", cls: styles.meta });
			if (!deleted) {
				const previousButton = controls.createEl("button", {
					text: "Previous",
					attr: { title: "Compare with the previous retained version" }
				});
				previousButton.disabled = !previous;
				if (this.comparisonMode === "previous") previousButton.addClass("mod-cta");
				previousButton.addEventListener("click", () => {
					this.comparisonMode = "previous";
					void this.select(selection);
				});
				const currentButton = controls.createEl("button", {
					text: "Current",
					attr: { title: "Compare with the file currently in the vault" }
				});
				if (this.comparisonMode === "current") currentButton.addClass("mod-cta");
				currentButton.addEventListener("click", () => {
					this.comparisonMode = "current";
					void this.select(selection);
				});
			}
			if (result.additions !== null && result.deletions !== null) {
				const stats = controls.createSpan({ cls: styles.lineStats });
				stats.createSpan({ text: `+${result.additions}`, cls: styles.additionCount });
				stats.createSpan({ text: ` −${result.deletions}`, cls: styles.deletionCount });
			}
			const diffEl = this.previewEl.createDiv({ cls: styles.diff });
			for (const run of groupDiffLines(compactLineDiff(result.lines))) {
				const prefix = run.type === "add" ? "+ " : run.type === "remove" ? "− " : "  ";
				diffEl.createDiv({
					text: run.lines.map(line => prefix + line).join("\n"),
					cls: run.type === "add" ? styles.added : run.type === "remove" ? styles.removed : undefined
				});
			}
			return;
		}
		if (textLimit !== null && isText) {
			this.previewEl.createEl("p", { text: `Text revision too large for an inline diff · ${content.byteLength.toLocaleString()} bytes`, cls: styles.meta });
			return;
		}
		if (/\.(png|jpe?g|gif|webp|svg)$/i.test(lower)) {
			this.objectUrl = URL.createObjectURL(new Blob([content]));
			this.previewEl.createEl("img", { attr: { src: this.objectUrl, alt: `Historical preview of ${this.path}` } });
			return;
		}
		this.previewEl.createEl("p", { text: `Binary revision · ${content.byteLength.toLocaleString()} bytes`, cls: styles.meta });
	}

	private renderActions(selection: HistorySelection): void {
		if (selection.source === "metadata") return;
		const actions = this.previewEl.createDiv({ cls: styles.previewActions });
		const restore = actions.createEl("button", {
			text: "Restore this version",
			cls: "mod-cta",
			attr: { title: `Replace ${this.path} with this version and synchronize it` }
		});
		restore.addEventListener("click", () => {
			void this.restoreSelection(selection, restore);
		});
		if (selection.source !== "local" || selection.checkpoint.publishedCommitId) return;
		const publish = actions.createEl("button", {
			text: "Publish checkpoint",
			attr: { title: "Restore this local checkpoint and wait until Seafile has committed it" }
		});
		publish.addEventListener("click", () => {
			void this.publishCheckpoint(selection.checkpoint, publish);
		});
	}

	private async restoreSelection(selection: RestorableHistorySelection, button: HTMLButtonElement): Promise<void> {
		button.disabled = true;
		try {
			if (selection.source === "remote") await this.plugin.restoreHistoricalFile(this.path, selection.revision);
			else await this.plugin.restoreLocalCheckpoint(selection.checkpoint, false);
			new Notice(`Restored ${this.path}`);
			this.onRestored?.();
		} catch (error) {
			new Notice(`Restore failed: ${(error as Error).message}`, 0);
		} finally {
			button.disabled = false;
		}
	}

	private async publishCheckpoint(checkpoint: LocalCheckpoint, button: HTMLButtonElement): Promise<void> {
		button.disabled = true;
		try {
			await this.plugin.restoreLocalCheckpoint(checkpoint, true);
			new Notice("Local checkpoint published to Seafile");
			this.onRestored?.();
		} catch (error) {
			new Notice(`Checkpoint publication failed: ${(error as Error).message}`, 0);
		} finally {
			button.disabled = false;
		}
	}

	private renderMetadataRevision(revision: FileRevision): void {
		this.previewEl.createEl("h4", { text: "Metadata-only revision" });
		this.previewEl.createDiv({ text: revision.path, cls: styles.filePath, attr: { title: revision.path } });
		this.previewEl.createEl("p", { text: "File content is unchanged in this revision.", cls: styles.meta });
		const details = this.previewEl.createDiv({ cls: styles.metadataDetails });
		for (const change of revision.metadataChanges ?? []) {
			const row = details.createDiv({ cls: styles.metadataDetail });
			row.createSpan({ text: this.metadataFieldTitle(change.field), cls: styles.metadataField });
			row.createSpan({
				text: `${this.metadataValue(change.field, change.before)} → ${this.metadataValue(change.field, change.after)}`,
				cls: styles.metadataValues
			});
		}
	}

	private remoteRevision(selection: HistorySelection): FileRevision | null {
		return selection.source === "local" ? null : selection.revision;
	}

	private classifyRemoteRevisions(): void {
		const revisions = this.selections
			.filter((selection): selection is Extract<HistorySelection, { source: "remote" }> => selection.source === "remote")
			.map(selection => selection.revision)
			.sort((left, right) => right.createdAt - left.createdAt);
		for (let index = 0; index < revisions.length; index++) {
			const revision = revisions[index];
			if (revision.deleted) {
				this.remoteRevisionKinds.set(revision.commitId, "deleted");
				continue;
			}
			if (revision.renamedFrom) {
				this.remoteRevisionKinds.set(revision.commitId, "renamed");
				continue;
			}
			if (index < revisions.length - 1 || this.nextCommit) {
				this.remoteRevisionKinds.set(revision.commitId, "modified");
				continue;
			}
			// The file-history endpoint does not identify creation explicitly. Avoid an
			// automatic commit-tree scan here: it can be far more expensive than loading
			// the history itself. The explicit metadata scan can identify that boundary.
			this.remoteRevisionKinds.set(revision.commitId, "unknown");
		}
	}

	private remoteRevisionTitle(revision: FileRevision): string {
		if (revision.deleted) return "Deleted";
		if (revision.renamedFrom) return "Renamed";
		const kind = this.remoteRevisionKinds.get(revision.commitId);
		return kind === "created" ? "Created"
			: kind === "modified" ? "Content modified"
				: kind === "renamed" ? "Renamed"
					: kind === "deleted" ? "Deleted"
						: "Content changed";
	}

	private metadataFieldSummary(changes: FileMetadataChange[]): string {
		return changes.map(change => this.metadataFieldTitle(change.field)).join(" · ") || "Metadata";
	}

	private metadataChangesTitle(changes: FileMetadataChange[]): string {
		return changes.map(change =>
			`${this.metadataFieldTitle(change.field)}: ${this.metadataValue(change.field, change.before)} → ${this.metadataValue(change.field, change.after)}`
		).join("\n");
	}

	private metadataFieldTitle(field: FileMetadataChange["field"]): string {
		return field === "mtime" ? "Modified time" : field === "modifier" ? "Modifier" : "Size";
	}

	private metadataValue(field: FileMetadataChange["field"], value: string | number): string {
		if (field === "mtime" && typeof value === "number") return new Date(value * 1000).toLocaleString();
		if (field === "size" && typeof value === "number") return `${value.toLocaleString()} bytes`;
		return String(value || "—");
	}

	private normalizeRemotePath(path: string): string {
		return "/" + path.replace(/^\/+/, "");
	}

	private async readSelection(selection: HistorySelection): Promise<ArrayBuffer> {
		const id = this.selectionId(selection);
		const cached = this.contentCache.get(id);
		if (cached) {
			this.contentCache.delete(id);
			this.contentCache.set(id, cached);
			return cached;
		}
		const content = selection.source !== "local"
			? (await this.plugin.history.readRevision(selection.revision)).content
			: await this.plugin.checkpoints.read(selection.checkpoint);
		this.cacheContent(id, content);
		return content;
	}

	private cacheContent(id: string, content: ArrayBuffer): void {
		if (content.byteLength > FileHistoryPanel.CONTENT_CACHE_LIMIT_BYTES) return;
		const previous = this.contentCache.get(id);
		if (previous) this.contentCacheBytes -= previous.byteLength;
		this.contentCache.delete(id);
		this.contentCache.set(id, content);
		this.contentCacheBytes += content.byteLength;
		while (this.contentCacheBytes > FileHistoryPanel.CONTENT_CACHE_LIMIT_BYTES) {
			const oldestId = this.contentCache.keys().next().value as string | undefined;
			if (!oldestId) break;
			const oldest = this.contentCache.get(oldestId);
			this.contentCache.delete(oldestId);
			this.contentCacheBytes -= oldest?.byteLength ?? 0;
		}
	}

	private sortSelections(selections: HistorySelection[]): HistorySelection[] {
		const seen = new Set<string>();
		return selections.filter(selection => {
			const id = this.selectionId(selection);
			if (seen.has(id)) return false;
			seen.add(id);
			return true;
		}).sort((left, right) => this.createdAt(right) - this.createdAt(left));
	}

	private selectionId(selection: HistorySelection): string {
		return selection.source === "local" ? `local:${selection.checkpoint.id}` : `${selection.source}:${selection.revision.commitId}`;
	}

	private relativeTime(timestamp: number): string {
		const delta = timestamp - Date.now();
		for (const [unit, milliseconds] of [
			["year", 365 * 24 * 60 * 60 * 1000],
			["month", 30 * 24 * 60 * 60 * 1000],
			["day", 24 * 60 * 60 * 1000],
			["hour", 60 * 60 * 1000],
			["minute", 60 * 1000]
		] as Array<[Intl.RelativeTimeFormatUnit, number]>) {
			if (Math.abs(delta) >= milliseconds || unit === "minute") return this.relativeTimeFormatter.format(Math.round(delta / milliseconds), unit);
		}
		return "now";
	}

	private createdAt(selection: HistorySelection): number {
		return selection.source === "local" ? selection.checkpoint.createdAt : selection.revision.createdAt;
	}
}
