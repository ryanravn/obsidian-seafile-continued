import { Modal, Notice, Setting } from "obsidian";
import type SeafilePlugin from "../main";

export class LibraryPolicyModal extends Modal {
	constructor(private readonly plugin: SeafilePlugin, private readonly onSaved: () => void) {
		super(plugin.app);
	}

	onOpen(): void {
		this.titleEl.textContent = "Library sync policy";
		this.contentEl.createEl("p", {
			text: "Edit the shared policy JSON. Saving validates the complete document before it can affect synchronization on this or other devices."
		});
		let area!: HTMLTextAreaElement;
		new Setting(this.contentEl).addTextArea(component => {
			area = component.inputEl;
			area.rows = 22;
			area.spellcheck = false;
			component.setPlaceholder("Loading policy…");
		});
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText("Save policy").setCta().onClick(async () => {
				button.setDisabled(true);
				try {
					await this.plugin.repairLibraryPolicy(area.value);
					new Notice("Library sync policy saved; synchronization can resume.");
					this.onSaved();
					this.close();
				} catch (error) {
					new Notice(`Policy was not saved: ${(error as Error).message}`, 0);
				} finally {
					button.setDisabled(false);
				}
			}))
			.addButton(button => button.setButtonText("Close").onClick(() => this.close()));
		void this.plugin.readLibraryPolicy().then(contents => {
			area.value = contents;
		}).catch(error => {
			new Notice(`Policy could not be opened: ${(error as Error).message}`, 0);
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
