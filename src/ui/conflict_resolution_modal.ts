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
			const limit = historyTextDiffLimit(currentPath);
			const loadComparison = limit !== null
				&& (current?.size ?? 0) <= limit
				&& (conflict?.size ?? 0) <= limit;
			const [currentContent, conflictContent] = loadComparison ? await Promise.all([
				current?.type === "file" ? this.plugin.app.vault.adapter.readBinary(currentPath) : undefined,
				conflict?.type === "file" ? this.plugin.app.vault.adapter.readBinary(conflictPath) : undefined
			]) : [undefined, undefined];
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
		this.contentEl.createDiv({
			text: "Sync downloaded the Seafile version to the original path and saved this device's pre-sync version as a separate file. Compare them before choosing what remains at the original path.",
			cls: styles.conflictExplanation
		});
		const versions = this.contentEl.createDiv({ cls: styles.conflictVersions });
		this.renderVersion(
			versions,
			"CURRENT · Downloaded from Seafile",
			"This is now at the original path.",
			this.issue.path ?? "Unavailable",
			this.reviewed.current
		);
		this.renderVersion(
			versions,
			"LOCAL · Preserved from this device",
			"This is the file as it was here before the conflicting sync.",
			this.issue.relatedPath ?? "Unavailable",
			this.reviewed.conflict
		);
		this.renderComparison();

		this.contentEl.createDiv({
			text: "Keeping either single version removes the separate conflict copy. Keeping both files leaves CURRENT at the original path and LOCAL under its conflict filename.",
			cls: styles.conflictActionHelp
		});
		const actions = new Setting(this.contentEl).setClass(styles.conflictActions);
		actions.addButton(button => button
			.setButtonText("Keep downloaded version")
			.setTooltip("Keep CURRENT at the original path and delete the preserved LOCAL copy")
			.onClick(() => { void this.resolve("current"); }));
		actions.addButton(button => button
			.setButtonText("Restore my local version")
			.setTooltip("Replace CURRENT at the original path with LOCAL, then delete the separate conflict copy")
			.onClick(() => { void this.resolve("conflict"); }));
		actions.addButton(button => button
			.setButtonText("Keep both files")
			.setTooltip("Leave both files unchanged and mark the issue resolved")
			.onClick(() => { void this.resolve("both"); }));
	}

	private renderVersion(
		container: HTMLElement,
		title: string,
		description: string,
		path: string,
		stat: Stat | null
	): void {
		const card = container.createDiv({ cls: styles.conflictVersion });
		card.createEl("strong", { text: title });
		card.createDiv({ text: description, cls: styles.conflictVersionDescription });
		card.createDiv({ text: path, cls: styles.conflictPath });
		if (stat?.type === "file") {
			card.createDiv({
				text: `${stat.size.toLocaleString()} bytes · modified ${new Date(stat.mtime).toLocaleString()}`,
				cls: styles.meta
			});
		}
	}

	private renderComparison(): void {
		if (!this.reviewed) return;
		const { current, conflict, currentContent, conflictContent } = this.reviewed;
		if (conflict?.type !== "file") {
			this.contentEl.createDiv({ text: "The preserved local copy no longer exists.", cls: styles.danger });
			return;
		}
		const limit = historyTextDiffLimit(this.issue.path ?? "");
		const canDiff = limit !== null
			&& conflictContent !== undefined
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
		this.contentEl.createEl("strong", { text: "Line-by-line comparison", cls: styles.conflictComparisonTitle });
		this.contentEl.createDiv({
			text: `Compared with CURRENT, LOCAL has ${comparison.additions ?? 0} added line${comparison.additions === 1 ? "" : "s"} and ${comparison.deletions ?? 0} removed line${comparison.deletions === 1 ? "" : "s"}. Labels on each line show which version contains it.`,
			cls: styles.conflictSummary
		});
		const diff = this.contentEl.createDiv({ cls: `${styles.diff} ${styles.conflictDiff}` });
		for (const run of groupDiffLines(compactLineDiff(comparison.lines))) {
			const prefix = run.type === "add" ? "LOCAL   + " : run.type === "remove" ? "CURRENT − " : "BOTH      ";
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
			if (resolution === "conflict" && !this.reviewed.conflictContent) {
				const conflictPath = this.issue.relatedPath ?? "";
				this.reviewed.conflictContent = await this.plugin.app.vault.adapter.readBinary(conflictPath);
			}
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
