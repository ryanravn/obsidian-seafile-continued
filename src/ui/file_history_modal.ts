import { Modal } from "obsidian";
import type SeafilePlugin from "../main";
import type { FileRevision } from "../history/types";
import { FileHistoryPanel } from "./file_history_panel";
import styles from "./history.module.css";

export class FileHistoryModal extends Modal {
	private panel: FileHistoryPanel | null = null;

	constructor(app: SeafilePlugin["app"], private readonly plugin: SeafilePlugin, private readonly path: string, private readonly seededRevision?: FileRevision) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass(styles.fileHistoryModal);
		this.titleEl.textContent = `Version history — ${this.path}`;
		this.panel = new FileHistoryPanel(this.plugin, this.contentEl, this.path, false, this.seededRevision, () => this.close());
		void this.panel.open();
	}

	onClose(): void {
		this.panel?.dispose();
		this.panel = null;
		this.contentEl.empty();
	}
}
