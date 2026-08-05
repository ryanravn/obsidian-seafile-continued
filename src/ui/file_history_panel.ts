import { Notice, Setting } from "obsidian";
import type SeafilePlugin from "../main";
import type { FileRevision, LocalCheckpoint } from "../history/types";
import { createLineDiff } from "../history/text_diff";
import styles from "./history.module.css";

type HistorySelection = { source: "remote", revision: FileRevision } | { source: "local", checkpoint: LocalCheckpoint };

export class FileHistoryPanel {
	private selections: HistorySelection[] = [];
	private nextCommit: string | null = null;
	private previewEl: HTMLElement;
	private timelineEl: HTMLElement;
	private objectUrl: string | null = null;
	private remoteError = "";

	constructor(
		private readonly plugin: SeafilePlugin,
		private readonly container: HTMLElement,
		private readonly path: string,
		private readonly embedded = false,
		private readonly seededRevision?: FileRevision,
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
		if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
		this.objectUrl = null;
	}

	private async loadInitial(): Promise<void> {
		try {
			const [local, remote] = await Promise.all([
				this.plugin.checkpoints.list(this.path),
				this.plugin.server.getFileHistory("/" + this.path.replace(/^\/+/, "")).catch(error => {
					this.remoteError = (error as Error).message;
					return { revisions: [], nextCommit: null };
				})
			]);
			this.nextCommit = remote.nextCommit;
			this.selections = [
				...(this.seededRevision ? [{ source: "remote" as const, revision: this.seededRevision }] : []),
				...remote.revisions.map(revision => ({ source: "remote" as const, revision })),
				...local.map(checkpoint => ({ source: "local" as const, checkpoint }))
			].filter((selection, index, all) => all.findIndex(candidate => candidate.source === selection.source
				&& (candidate.source === "remote" ? candidate.revision.commitId : candidate.checkpoint.id)
					=== (selection.source === "remote" ? selection.revision.commitId : selection.checkpoint.id)) === index)
				.sort((left, right) => this.createdAt(right) - this.createdAt(left));
			this.renderTimeline();
			if (this.selections[0]) await this.select(this.selections[0]);
		} catch (error) {
			this.timelineEl.empty();
			this.timelineEl.createEl("p", { text: `Failed to load history: ${(error as Error).message}`, cls: styles.danger });
		}
	}

	private renderTimeline(): void {
		this.timelineEl.empty();
		if (this.remoteError) this.timelineEl.createEl("p", { text: `Cloud history unavailable: ${this.remoteError}`, cls: styles.danger });
		if (this.selections.length === 0) {
			this.timelineEl.createEl("p", { text: "No retained versions were found.", cls: styles.meta });
			return;
		}
		for (const selection of this.selections) {
			const button = this.timelineEl.createEl("button", { cls: styles.entry });
			button.createDiv({ text: new Date(this.createdAt(selection)).toLocaleString() });
			const source = selection.source === "remote" ? "Cloud version" : "Local checkpoint";
			const author = selection.source === "remote" ? selection.revision.authorName : "This device";
			button.createDiv({ text: `${author || "Unknown author"} · ${source}`, cls: styles.meta });
			button.addEventListener("click", () => { void this.select(selection); });
		}
		if (this.nextCommit) {
			new Setting(this.timelineEl).addButton(button => button.setButtonText("Load older versions").onClick(async () => {
				button.setDisabled(true);
				try {
					const page = await this.plugin.server.getFileHistory("/" + this.path.replace(/^\/+/, ""), this.nextCommit!);
					this.nextCommit = page.nextCommit;
					this.selections.push(...page.revisions.map(revision => ({ source: "remote" as const, revision })));
					this.renderTimeline();
				} catch (error) {
					new Notice(`Older versions could not be loaded: ${(error as Error).message}`);
				} finally {
					button.setDisabled(false);
				}
			}));
		}
	}

	private async select(selection: HistorySelection): Promise<void> {
		this.previewEl.empty();
		this.dispose();
		this.previewEl.createEl("p", { text: "Loading revision…", cls: styles.meta });
		try {
			const content = selection.source === "remote"
				? (await this.plugin.history.readRevision(selection.revision)).content
				: await this.plugin.checkpoints.read(selection.checkpoint);
			this.previewEl.empty();
			await this.renderContent(content);
			new Setting(this.previewEl)
				.addButton(button => button.setButtonText("Restore").setCta().onClick(async () => {
					button.setDisabled(true);
					try {
						if (selection.source === "remote") await this.plugin.restoreHistoricalFile(this.path, selection.revision);
						else await this.plugin.restoreLocalCheckpoint(selection.checkpoint, false);
						new Notice(`Restored ${this.path}`);
						this.onRestored?.();
					} catch (error) {
						new Notice(`Restore failed: ${(error as Error).message}`, 0);
					} finally {
						button.setDisabled(false);
					}
				}))
				.addButton(button => button
					.setButtonText("Restore and publish")
					.setDisabled(selection.source !== "local" || !!selection.checkpoint.publishedCommitId)
					.onClick(async () => {
						if (selection.source !== "local") return;
						button.setDisabled(true);
						try {
							await this.plugin.restoreLocalCheckpoint(selection.checkpoint, true);
							new Notice("Local checkpoint published to Seafile");
							this.onRestored?.();
						} catch (error) {
							new Notice(`Checkpoint publication failed: ${(error as Error).message}`, 0);
						} finally {
							button.setDisabled(false);
						}
					}));
		} catch (error) {
			this.previewEl.empty();
			this.previewEl.createEl("p", { text: `Failed to load revision: ${(error as Error).message}`, cls: styles.danger });
		}
	}

	private async renderContent(content: ArrayBuffer): Promise<void> {
		const lower = this.path.toLowerCase();
		if ((lower.endsWith(".md") || lower.endsWith(".canvas") || lower.endsWith(".txt")) && content.byteLength <= 2 * 1024 * 1024) {
			const selected = new TextDecoder().decode(content);
			const current = await this.plugin.app.vault.adapter.read(this.path).catch(() => "");
			const diffEl = this.previewEl.createDiv({ cls: styles.diff });
			for (const line of createLineDiff(current, selected)) {
				const prefix = line.type === "add" ? "+ " : line.type === "remove" ? "− " : "  ";
				diffEl.createDiv({
					text: prefix + line.text,
					cls: line.type === "add" ? styles.added : line.type === "remove" ? styles.removed : undefined
				});
			}
			return;
		}
		if (/\.(png|jpe?g|gif|webp|svg)$/i.test(lower)) {
			this.objectUrl = URL.createObjectURL(new Blob([content]));
			this.previewEl.createEl("img", { attr: { src: this.objectUrl, alt: `Historical preview of ${this.path}` } });
			return;
		}
		this.previewEl.createEl("p", { text: `Binary revision · ${content.byteLength.toLocaleString()} bytes`, cls: styles.meta });
	}

	private createdAt(selection: HistorySelection): number {
		return selection.source === "remote" ? selection.revision.createdAt : selection.checkpoint.createdAt;
	}
}
