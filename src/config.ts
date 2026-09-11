import { App, DataAdapter } from "obsidian";
import Server from "./server";
import { createDefaultIgnoreFile } from "./ignore";
import type { SeafileSettings } from "./settings";

export let PLUGIN_DIR: string;
export let SYNC_DLOG_PATH: string;
export let SYNC_DATA_PATH: string;
export let HEAD_COMMIT_PATH: string;
export let DOWNLOAD_JOURNAL_PATH: string;
export let DOWNLOAD_STAGING_PATH: string;
export let PLUGIN_GITIGNORE_PATH: string;
export let DEFAULT_SEAFILE_IGNORE: string;
export let app: App;
export let adapter: DataAdapter;
export let server: Server;

export function initConfig(app_: App, server_: Server, pluginId: string, settings?: SeafileSettings) {
	app = app_;
	server = server_;
	adapter = app.vault.adapter;
	PLUGIN_DIR = app.vault.configDir + "/plugins/" + pluginId;
	SYNC_DLOG_PATH = PLUGIN_DIR + "/" + "sync_dlog";
	SYNC_DATA_PATH = PLUGIN_DIR + "/" + "sync_data";
	HEAD_COMMIT_PATH = PLUGIN_DIR + "/" + "head_commit";
	DOWNLOAD_JOURNAL_PATH = PLUGIN_DIR + "/" + "download_journal";
	DOWNLOAD_STAGING_PATH = PLUGIN_DIR + "/" + "download_staging";
	PLUGIN_GITIGNORE_PATH = PLUGIN_DIR + "/" + ".gitignore";

	DEFAULT_SEAFILE_IGNORE = createDefaultIgnoreFile(app.vault.configDir, pluginId, settings);
}

export const PLUGIN_GITIGNORE_CONTENT = "head_commit\nsync_data\nsync_dlog\ndownload_journal\ndownload_staging\nhistory\n";

export async function ensurePluginGitignore(): Promise<void> {
	if (!await adapter.exists(PLUGIN_GITIGNORE_PATH)) {
		await adapter.write(PLUGIN_GITIGNORE_PATH, PLUGIN_GITIGNORE_CONTENT);
		return;
	}
	const existing = await adapter.read(PLUGIN_GITIGNORE_PATH);
	const entries = new Set(existing.split(/\r?\n/).filter(Boolean));
	const required = PLUGIN_GITIGNORE_CONTENT.trimEnd().split("\n");
	const missing = required.filter(entry => !entries.has(entry));
	if (missing.length === 0) return;
	await adapter.write(PLUGIN_GITIGNORE_PATH, `${existing.replace(/\s*$/, "")}\n${missing.join("\n")}\n`);
}
