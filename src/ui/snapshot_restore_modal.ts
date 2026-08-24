import { Modal, Notice, Setting, TextComponent, type App } from "obsidian";
import type SeafilePlugin from "../main";
import type { LibraryRevision, SnapshotDiff } from "../history/types";

export class SnapshotRestoreModal extends Modal {
	private confirmation = "";
	private confirmButton: { setDisabled(disabled: boolean): unknown } | null = null;

	constructor(app: App, private readonly plugin: SeafilePlugin, private readonly revision: LibraryRevision, private readonly diff: SnapshotDiff) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.textContent = "Restore entire vault";
		this.contentEl.createEl("p", {
			text: `This will restore ${this.plugin.settings.repoName} to ${new Date(this.revision.createdAt).toLocaleString()} on every connected device.`
		});
		this.contentEl.createEl("p", {
			text: `${this.diff.modifiedFileChanges.filter(change => change.contentChanged !== false).length} content-modified, ${this.diff.modifiedFileChanges.filter(change => change.contentChanged === false).length} metadata-updated, ${this.diff.addedFiles.length} restored, and ${this.diff.deletedFiles.length} removed files.`,
		});
		this.contentEl.createEl("p", {
			text: "Finish synchronization on other devices first. The current remote HEAD will be retained as an undo point."
		});
		new Setting(this.contentEl)
			.setName(`Type “${this.plugin.settings.repoName}” to confirm`)
			.addText(text => this.configureConfirmation(text));
		new Setting(this.contentEl)
			.addButton(button => {
				this.confirmButton = button;
				button.setButtonText("Restore vault").setDestructive().setCta().setDisabled(true).onClick(async () => {
					button.setDisabled(true);
					try {
						await this.plugin.restoreVaultSnapshot(this.revision.commitId, this.diff);
						new Notice("Vault snapshot restored. Synchronization is updating local files.", 8000);
						this.close();
					} catch (error) {
						new Notice(`Snapshot restore failed: ${(error as Error).message}`, 0);
						button.setDisabled(false);
					}
				});
			})
			.addButton(button => button.setButtonText("Cancel").onClick(() => this.close()));
	}

	private configureConfirmation(text: TextComponent): void {
		text.onChange(value => {
			this.confirmation = value;
			this.confirmButton?.setDisabled(this.confirmation !== this.plugin.settings.repoName);
		});
	}
}
