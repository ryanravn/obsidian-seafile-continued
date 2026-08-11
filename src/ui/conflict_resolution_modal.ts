import { Modal, Notice, Setting, type Stat } from "obsidian";
import type SeafilePlugin from "../main";
import { compactLineDiff, createLineDiffResult, groupDiffLines } from "../history/text_diff";
import { formatHistoryText, historyTextDiffLimit, isLikelyTextContent } from "../history/text_format";
import type { SyncIssue } from "../sync/issues";
import styles from "./history.module.css";

interface ReviewedConflict {
	current: Stat | null
	conflict: Stat | null
	currentContent?: ArrayBuffer
	conflictContent?: ArrayBuffer
}

export class ConflictResolutionModal extends Modal {
	private reviewed: ReviewedConflict | null = null;

	constructor(
		private readonly plugin: SeafilePlugin,
		private readonly issue: SyncIssue,
		private readonly onResolved: () => void
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.titleEl.textContent = "Resolve sync conflict";
		this.contentEl.empty();
		this.contentEl.createDiv({ text: "Loading both versions…", cls: styles.meta });
		void this.load();
	}

	private async load(): Promise<void> {
		try {
			const currentPath = this.issue.path ?? "";
			const conflictPath = this.issue.relatedPath ?? "";
			const [current, conflict] = await Promise.all([
				this.plugin.app.vault.adapter.stat(currentPath),
				this.plugin.app.vault.adapter.stat(conflictPath)
			]);
			const [currentContent, conflictContent] = await Promise.all([
				current?.type === "file" ? this.plugin.app.vault.adapter.readBinary(currentPath) : undefined,
				conflict?.type === "file" ? this.plugin.app.vault.adapter.readBinary(conflictPath) : undefined
			]);
			this.reviewed = { current, conflict, currentContent, conflictContent };
			this.renderReview();
		} catch (error) {
			this.contentEl.empty();
			this.contentEl.createDiv({ text: `Conflict could not be loaded: ${(error as Error).message}`, cls: styles.danger });
		}
	}

	private renderReview(): void {
		if (!this.reviewed) return;
		this.contentEl.empty();
		this.contentEl.createDiv({ text: "Current library version", cls: styles.meta });
		this.contentEl.createDiv({ text: this.issue.path ?? "Unavailable", cls: styles.conflictPath });
		this.contentEl.createDiv({ text: "Preserved local version", cls: styles.meta });
		this.contentEl.createDiv({ text: this.issue.relatedPath ?? "Unavailable", cls: styles.conflictPath });
		this.renderComparison();

		const actions = new Setting(this.contentEl).setClass(styles.conflictActions);
		actions.addButton(button => button
			.setButtonText("Use current")
			.setTooltip("Keep the current library version and remove the preserved local copy")
			.setDestructive()
			.onClick(() => { void this.resolve("current"); }));
		actions.addButton(button => button
			.setButtonText("Use preserved local")
			.setTooltip("Replace the current file with the preserved local version")
			.setCta()
			.onClick(() => { void this.resolve("conflict"); }));
		actions.addButton(button => button
			.setButtonText("Keep both")
			.setTooltip("Leave both files unchanged and mark the issue resolved")
			.onClick(() => { void this.resolve("both"); }));
	}

	private renderComparison(): void {
		if (!this.reviewed) return;
		const { current, conflict, currentContent, conflictContent } = this.reviewed;
		if (!conflictContent) {
			this.contentEl.createDiv({ text: "The preserved local copy no longer exists.", cls: styles.danger });
			return;
		}
		const limit = historyTextDiffLimit(this.issue.path ?? "");
		const canDiff = limit !== null
			&& (currentContent?.byteLength ?? 0) <= limit
			&& conflictContent.byteLength <= limit
			&& (!currentContent || isLikelyTextContent(currentContent))
			&& isLikelyTextContent(conflictContent);
		if (!canDiff) {
			this.contentEl.createDiv({
				text: `Inline comparison unavailable · current ${current?.size ?? 0} bytes · preserved ${conflict?.size ?? 0} bytes`,
				cls: styles.meta
			});
			return;
		}
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const currentText = formatHistoryText(this.issue.path ?? "", currentContent ? decoder.decode(currentContent) : "");
		const conflictText = formatHistoryText(this.issue.path ?? "", decoder.decode(conflictContent));
		const comparison = createLineDiffResult(currentText, conflictText);
		this.contentEl.createDiv({
			text: `Preserved local changes · +${comparison.additions ?? 0} −${comparison.deletions ?? 0}`,
			cls: styles.conflictSummary
		});
		const diff = this.contentEl.createDiv({ cls: `${styles.diff} ${styles.conflictDiff}` });
		for (const run of groupDiffLines(compactLineDiff(comparison.lines))) {
			const prefix = run.type === "add" ? "+ " : run.type === "remove" ? "− " : "  ";
			diff.createDiv({
				text: run.lines.map(line => prefix + line).join("\n"),
				cls: run.type === "add" ? styles.added : run.type === "remove" ? styles.removed : undefined
			});
		}
	}

	private async resolve(resolution: "current" | "conflict" | "both"): Promise<void> {
		if (!this.reviewed) return;
		for (const button of Array.from(this.contentEl.querySelectorAll("button"))) button.disabled = true;
		try {
			await this.plugin.resolveSyncConflict(this.issue, resolution, this.reviewed);
			new Notice(resolution === "both" ? "Conflict marked resolved; both files were kept." : "Conflict resolved and synchronization scheduled.");
			this.onResolved();
			this.close();
		} catch (error) {
			new Notice(`Conflict could not be resolved: ${(error as Error).message}`, 0);
			for (const button of Array.from(this.contentEl.querySelectorAll("button"))) button.disabled = false;
		}
	}
}
