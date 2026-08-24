import { App, Modal, Notice, Setting } from "obsidian";
import { server } from "src/config";
import { Repo, type RepoDownloadInfo } from "src/server";
import { debug } from "src/utils";
import prettyBytes from "pretty-bytes";

export interface SelectedRepo {
  repoName: string
  repoId: string
	permission: string
  info: RepoDownloadInfo
}

export default class RepoModal extends Modal {

	constructor(app: App, private callback: (selected: SelectedRepo) => void | Promise<void>) {
		super(app);
	}

	// Returns whether the repo was selected successfully, so the caller knows
	// whether it's safe to close the modal (closing after a failure would
	// discard the error context and leave the user unable to retry).
	async loadRepoToken(repo: Repo): Promise<boolean> {
		try {
			const info = await server.getRepoDownloadInfo(repo.repo_id);
			await this.callback({ repoName: repo.repo_name, repoId: repo.repo_id, permission: repo.permission, info });
			return true;
		}
		catch (error) {
			new Notice("Failed to load repository token. " + (error as Error).message);
			debug.error(error);
			return false;
		}
	}

	async loadRepos(contentEl: HTMLElement) {
		const repoList = await server.getRepoList();

		for (const repo of repoList) {
			new Setting(contentEl)
				.setName(repo.repo_name)
				.setDesc(`Access: ${repo.permission === "rw" ? "read and write" : "read only"}. Size: ${prettyBytes(repo.size)}. Last modified: ${new Date(repo.last_modified).toLocaleString()}.`)
				.addButton(button => button.onClick(async () => {
					button.setDisabled(true);
					const selected = await this.loadRepoToken(repo);
					if (selected) {
						this.close();
					} else {
						button.setDisabled(false);
					}
				}).setButtonText("Select"));
		}

		if (repoList.length == 0) {
			contentEl.createEl("p", { text: "No repositories found." });
		}
	}

	onOpen() {
		const { contentEl } = this;
		this.titleEl.textContent = "Choose a repository to sync";

		const loading = contentEl.createEl("p", { text: "Loading repositories..." });
		this.loadRepos(contentEl).then(() => loading.remove()).catch(error => {
			loading.textContent = "Failed to load repositories. " + (error as Error).message;
			debug.error(error);
		});
	}
}
