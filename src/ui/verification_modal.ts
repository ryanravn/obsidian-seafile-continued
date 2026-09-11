import { App, Modal, Setting } from "obsidian";
import type { VaultVerificationReport } from "../sync/controller";

export class VaultVerificationModal extends Modal {
	constructor(app: App, private readonly report: VaultVerificationReport) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.textContent = "Seafile vault verification";
		const pending = this.report.downloads + this.report.uploads + this.report.localDeletions + this.report.remoteDeletions;
		this.contentEl.createEl("p", {
			text: pending === 0 && this.report.pathIssues.length === 0
				? "The local vault, sync index, and current remote metadata agree."
				: "The vault is readable, but synchronization has pending work or compatibility issues."
		});
		const rows: Array<[string, string]> = [
			["Sync index", this.report.indexHealthy ? "Healthy" : "Missing or incomplete"],
			["Repository access", this.report.repositoryPermission === "rw" ? "Read and write" : `Read only (${this.report.repositoryPermission})`],
			["Tracked files", this.report.trackedFiles.toLocaleString()],
			["Pending downloads", this.report.downloads.toLocaleString()],
			["Pending uploads", this.report.uploads.toLocaleString()],
			["Pending local deletions", this.report.localDeletions.toLocaleString()],
			["Pending remote deletions", this.report.remoteDeletions.toLocaleString()],
			["Known/remote revision", this.report.knownLocalHead === this.report.remoteHead ? "Match" : "Different"]
		];
		for (const [name, value] of rows) new Setting(this.contentEl).setName(name).setDesc(value);
		if (this.report.pathIssues.length > 0) {
			this.contentEl.createEl("h3", { text: "Path compatibility issues" });
			for (const issue of this.report.pathIssues.slice(0, 100)) {
				this.contentEl.createEl("p", { text: `${issue.path}: ${issue.detail}` });
			}
		}
		new Setting(this.contentEl).addButton(button => button.setButtonText("Close").setCta().onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
