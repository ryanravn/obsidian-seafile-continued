import { App, DataAdapter } from "obsidian";
import Server from "./server";
import { createDefaultIgnoreFile } from "./ignore";

export let PLUGIN_DIR: string;
export let SYNC_DLOG_PATH: string;
export let SYNC_DATA_PATH: string;
export let HEAD_COMMIT_PATH: string;
export let DOWNLOAD_JOURNAL_PATH: string;
export let PLUGIN_GITIGNORE_PATH: string;
export let DEFAULT_SEAFILE_IGNORE: string;
export let app: App;
export let adapter: DataAdapter;
export let server: Server;

export function initConfig(app_: App, server_: Server, pluginId: string) {
	app = app_;
	server = server_;
	adapter = app.vault.adapter;
	PLUGIN_DIR = app.vault.configDir + "/plugins/" + pluginId;
	SYNC_DLOG_PATH = PLUGIN_DIR + "/" + "sync_dlog";
	SYNC_DATA_PATH = PLUGIN_DIR + "/" + "sync_data";
	HEAD_COMMIT_PATH = PLUGIN_DIR + "/" + "head_commit";
	DOWNLOAD_JOURNAL_PATH = PLUGIN_DIR + "/" + "download_journal";
	PLUGIN_GITIGNORE_PATH = PLUGIN_DIR + "/" + ".gitignore";

	DEFAULT_SEAFILE_IGNORE = createDefaultIgnoreFile(app.vault.configDir, pluginId);
}

export const PLUGIN_GITIGNORE_CONTENT = "head_commit\nsync_data\nsync_dlog\n";

export async function ensurePluginGitignore(): Promise<void> {
	if (!await adapter.exists(PLUGIN_GITIGNORE_PATH)) {
		await adapter.write(PLUGIN_GITIGNORE_PATH, PLUGIN_GITIGNORE_CONTENT);
	}
}
