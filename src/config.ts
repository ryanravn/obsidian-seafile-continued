import { App, DataAdapter } from "obsidian";
import Server from "./server";
import { createDefaultIgnoreFile } from "./ignore";

export let PLUGIN_DIR: string;
export let SYNC_DLOG_PATH: string;
export let SYNC_DATA_PATH: string;
export let HEAD_COMMIT_PATH: string;
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

	DEFAULT_SEAFILE_IGNORE = createDefaultIgnoreFile(app.vault.configDir, pluginId);
}
