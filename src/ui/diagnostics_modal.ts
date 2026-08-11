import { Modal, Notice, Setting } from "obsidian";

export class DiagnosticsModal extends Modal {
	constructor(app: import("obsidian").App, private readonly report: Record<string, unknown>) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.textContent = "Obsidian Seafile Sync diagnostics";
		this.contentEl.createEl("p", {
			text: "Review before sharing. Credentials, server and repository identifiers, file paths, issue messages, and commit IDs are excluded."
		});
		const text = `${JSON.stringify(this.report, null, 2)}\n`;
		let area: HTMLTextAreaElement;
		new Setting(this.contentEl).addTextArea(component => {
			area = component.inputEl;
			area.rows = 24;
			area.readOnly = true;
			component.setValue(text);
		});
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Copy report").setCta().onClick(() => {
				void this.copyReport(text, area);
			}))
			.addButton(button => button.setButtonText("Close").onClick(() => this.close()));
	}

	private async copyReport(text: string, area: HTMLTextAreaElement): Promise<void> {
		try {
			if (!window.navigator.clipboard) throw new Error("Clipboard access is unavailable.");
			await window.navigator.clipboard.writeText(text);
			new Notice("Diagnostics report copied");
		} catch (error) {
			area.select();
			new Notice(`Could not copy automatically: ${(error as Error).message}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
