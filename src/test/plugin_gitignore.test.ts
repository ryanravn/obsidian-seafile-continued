import { describe, expect, test } from "@jest/globals";
import { ensurePluginGitignore, initConfig, PLUGIN_GITIGNORE_CONTENT, PLUGIN_GITIGNORE_PATH } from "../config";

function setup(existing?: string): Map<string, string> {
	const files = new Map<string, string>();
	const path = ".obsidian/plugins/seafile-improved/.gitignore";
	if (existing !== undefined) files.set(path, existing);
	const adapter = {
		exists: async (candidate: string) => files.has(candidate),
		read: async (candidate: string) => files.get(candidate)!,
		write: async (candidate: string, contents: string) => { files.set(candidate, contents); }
	};
	initConfig({ vault: { configDir: ".obsidian", adapter } } as never, {} as never, "seafile-improved");
	return files;
}

describe("plugin runtime-data gitignore", () => {
	test("creates the recommended file in the plugin directory", async () => {
		const files = setup();

		await ensurePluginGitignore();

		expect(PLUGIN_GITIGNORE_PATH).toBe(".obsidian/plugins/seafile-improved/.gitignore");
		expect(files.get(PLUGIN_GITIGNORE_PATH)).toBe("head_commit\nsync_data\nsync_dlog\ndownload_staging\nhistory\n");
		expect(files.get(PLUGIN_GITIGNORE_PATH)).toBe(PLUGIN_GITIGNORE_CONTENT);
	});

	test("preserves existing entries while adding required runtime paths", async () => {
		const files = setup("custom-entry\n");

		await ensurePluginGitignore();

		expect(files.get(PLUGIN_GITIGNORE_PATH)).toBe("custom-entry\nhead_commit\nsync_data\nsync_dlog\ndownload_staging\nhistory\n");
	});

	test("upgrades an existing generated file without replacing its contents", async () => {
		const files = setup("head_commit\nsync_data\nsync_dlog\ndownload_staging\n");

		await ensurePluginGitignore();

		expect(files.get(PLUGIN_GITIGNORE_PATH)).toBe("head_commit\nsync_data\nsync_dlog\ndownload_staging\nhistory\n");
	});
});
