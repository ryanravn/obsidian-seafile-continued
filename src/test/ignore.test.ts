import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { DEFAULT_SEAFILE_IGNORE, initConfig } from "../config";
import { compileIgnoreList, createDefaultIgnoreFile, MANAGED_IGNORE_END, MANAGED_IGNORE_START, replaceManagedIgnoreBlock, SEAFILE_IGNORE_FILE, upsertManagedIgnoreBlock } from "../ignore";
import { DEFAULT_SETTINGS } from "../settings";
import { MODE_DIR, MODE_FILE, TYPE_FILE, type DirSeafFs, type FileSeafDirent, type FileSeafFs } from "../server";
import { SyncController } from "../sync/controller";
import { SyncNode } from "../sync/node";
import { LIBRARY_POLICY_FILE } from "../sync/library_policy";

const remoteIgnoreContents = "*.tmp\ncache/\n";

function setup(remoteIgnore?: string): SyncController {
	const adapter = global.app.vault.adapter;
	const bytes = new TextEncoder().encode(remoteIgnore ?? "");
	const ignoreEntry: FileSeafDirent | undefined = remoteIgnore === undefined ? undefined : {
		id: "ignore-fs",
		mode: MODE_FILE,
		modifier: "tester",
		mtime: 1700000000,
		name: SEAFILE_IGNORE_FILE,
		size: bytes.byteLength,
	};
	const rootFs: DirSeafFs = {
		dirents: ignoreEntry ? [ignoreEntry] : [],
		type: 3,
		version: 1,
	};
	const ignoreFs: FileSeafFs = {
		block_ids: remoteIgnore === "" ? [] : ["ignore-block"],
		size: bytes.byteLength,
		type: TYPE_FILE,
		version: 1,
	};
	const fakeServer = {
		getFs: async (id: string) => id === "root-fs" ? [id, rootFs] : [id, ignoreFs],
		getBlock: async () => bytes.buffer,
	};
	const fakeApp = {
		vault: {
			configDir: ".obsidian",
			adapter,
			getAbstractFileByPath: (path: string) => path === "" ? { children: [] } : null,
		}
	};
	initConfig(fakeApp as never, fakeServer as never, "seafile-continued", DEFAULT_SETTINGS);
	return new SyncController(adapter, { ...DEFAULT_SETTINGS, account: "tester" });
}

async function bootstrap(sync: SyncController): Promise<void> {
	await (sync as unknown as {
		bootstrapIgnoreFile: (root: { id: string, mode: number, mtime: number, name: string }) => Promise<void>
	}).bootstrapIgnoreFile({ id: "root-fs", mode: MODE_DIR, mtime: 1700000000, name: "" });
}

beforeEach(async () => {
	await global.app.vault.adapter.mkdir("");
	await global.app.vault.adapter.mkdir(".obsidian/plugins/seafile-continued");
	if (await global.app.vault.adapter.exists(SEAFILE_IGNORE_FILE)) {
		await global.app.vault.adapter.remove(SEAFILE_IGNORE_FILE);
	}
});

afterEach(async () => {
	for (const path of [SEAFILE_IGNORE_FILE, "draft.tmp", "remote.tmp"]) {
		if (await global.app.vault.adapter.exists(path)) await global.app.vault.adapter.remove(path);
	}
});

describe("Seafile ignore patterns", () => {
	test("matches Seafile wildcards and directory rules", () => {
		const ignore = compileIgnoreList(".git/\n*/.git/\nfoo/*.html\nplain-file\nfolder/\n");

		expect(ignore.denies(".git", true)).toBe(true);
		expect(ignore.denies("notes/.git", true)).toBe(true);
		expect(ignore.denies(".gitignore", false)).toBe(false);
		expect(ignore.denies("foo/templates/page.html", false)).toBe(true);
		expect(ignore.denies("plain-file", false)).toBe(true);
		expect(ignore.denies("plain-file", true)).toBe(false);
		expect(ignore.denies("folder", true)).toBe(true);
		expect(ignore.denies("folder", false)).toBe(false);
		expect(ignore.denies("folder/nested/file.md", false)).toBe(true);
	});

	test("never excludes the control file itself", () => {
		expect(compileIgnoreList("*").denies(SEAFILE_IGNORE_FILE, false)).toBe(false);
		expect(compileIgnoreList("*").denies(LIBRARY_POLICY_FILE, false)).toBe(false);
	});

	test("generates editable recommended defaults", () => {
		const defaults = createDefaultIgnoreFile(".obsidian", "seafile-continued");
		expect(defaults).toContain(MANAGED_IGNORE_START);
		expect(defaults).toContain(MANAGED_IGNORE_END);
		expect(defaults).toContain(".git/");
		expect(defaults).toContain(".vscode/");
		expect(defaults).toContain("*/.git/");
		expect(defaults).toContain(".obsidian/workspace.json");
		expect(defaults).toContain(".obsidian/plugins/seafile-continued/");
	});

	test("updates only the managed defaults when configuration categories change", () => {
		const original = `${createDefaultIgnoreFile(".obsidian", "seafile-continued", DEFAULT_SETTINGS)}*.tmp\n`;
		const updated = replaceManagedIgnoreBlock(original, ".obsidian", "seafile-continued", {
			...DEFAULT_SETTINGS,
			syncHotkeys: false,
			syncCommunityPluginInstallations: false,
			pluginSyncOverrides: { local: "ignore" }
		});
		expect(updated).toContain(".obsidian/hotkeys.json");
		expect(updated).toContain(".obsidian/plugins/*/main.js");
		expect(updated).toContain(".obsidian/plugins/local/");
		expect(updated).toContain("*.tmp\n");
	});

	test("adds managed defaults to an existing custom file without changing its rules", () => {
		const updated = upsertManagedIgnoreBlock("*.tmp\ncache/\n", ".obsidian", "seafile-continued", DEFAULT_SETTINGS);

		expect(updated.startsWith(`${MANAGED_IGNORE_START}\n`)).toBe(true);
		expect(updated).toContain(`\n${MANAGED_IGNORE_END}\n\n*.tmp\ncache/\n`);
	});

	test("replaces the legacy generated defaults instead of duplicating them", () => {
		const legacy = "# Git repositories\n.git/\n*/.git/\n\n"
			+ "# Device-specific Obsidian workspace state\n.obsidian/workspace.json\n.obsidian/workspace-mobile.json\n\n"
			+ "# Seafile Sync plugin installation and device state\n.obsidian/plugins/seafile-continued/\n";
		const updated = upsertManagedIgnoreBlock(legacy, ".obsidian", "seafile-improved", DEFAULT_SETTINGS);

		expect(updated.match(new RegExp(MANAGED_IGNORE_START, "g"))).toHaveLength(1);
		expect(updated).not.toContain("# Git repositories");
		expect(updated).not.toContain(".obsidian/plugins/seafile-continued/");
		expect(updated.match(/^\.git\/$/gm)).toHaveLength(1);
		expect(updated.match(/^\.obsidian\/workspace\.json$/gm)).toHaveLength(1);
	});

	test("removes legacy defaults left below an existing managed section", () => {
		const managed = createDefaultIgnoreFile(".obsidian", "seafile-improved", DEFAULT_SETTINGS);
		const legacy = "# Git repositories\n.git/\n*/.git/\n\n"
			+ "# Device-specific Obsidian workspace state\n.obsidian/workspace.json\n.obsidian/workspace-mobile.json\n\n"
			+ "# Seafile Sync plugin installation and device state\n.obsidian/plugins/seafile-continued/\n";
		const updated = upsertManagedIgnoreBlock(`${managed}${legacy}*.tmp\n`, ".obsidian", "seafile-improved", DEFAULT_SETTINGS);

		expect(updated).not.toContain("# Git repositories");
		expect(updated).not.toContain(".obsidian/plugins/seafile-continued/");
		expect(updated).toContain("# Add your own Seafile ignore patterns below this line.\n*.tmp\n");
	});

	test.each(["Obsidian Seafile Sync", "Seafile Improved"])("renames the legacy %s managed markers without duplicating the section", legacyName => {
		const legacyManaged = createDefaultIgnoreFile(".obsidian", "seafile-improved", DEFAULT_SETTINGS)
			.replace(MANAGED_IGNORE_START, `# BEGIN ${legacyName} managed defaults`)
			.replace(MANAGED_IGNORE_END, `# END ${legacyName} managed defaults`);
		const updated = upsertManagedIgnoreBlock(legacyManaged, ".obsidian", "seafile-improved", DEFAULT_SETTINGS);

		expect(updated.match(new RegExp(MANAGED_IGNORE_START, "g"))).toHaveLength(1);
		expect(updated).not.toContain(`${legacyName} managed defaults`);
	});
});

describe("Seafile ignore file lifecycle", () => {
	test("adopts an existing remote ignore file and adds managed defaults before traversal", async () => {
		const sync = setup(remoteIgnoreContents);

		await bootstrap(sync);

		const contents = await global.app.vault.adapter.read(SEAFILE_IGNORE_FILE);
		expect(contents.startsWith(`${MANAGED_IGNORE_START}\n`)).toBe(true);
		expect(contents).toContain(`\n${MANAGED_IGNORE_END}\n\n${remoteIgnoreContents}`);
		expect(sync.isPathIgnored("notes/cache.tmp", false)).toBe(true);
	});

	test("adds managed defaults to an existing local ignore file before traversal", async () => {
		const sync = setup();
		await global.app.vault.adapter.write(SEAFILE_IGNORE_FILE, "*.local\n");

		await sync.updateManagedIgnoreRules();

		const contents = await global.app.vault.adapter.read(SEAFILE_IGNORE_FILE);
		expect(contents.startsWith(`${MANAGED_IGNORE_START}\n`)).toBe(true);
		expect(contents).toContain(`\n${MANAGED_IGNORE_END}\n\n*.local\n`);
	});

	test("creates the recommended file when neither side has one", async () => {
		const sync = setup();

		await bootstrap(sync);

		expect(await global.app.vault.adapter.read(SEAFILE_IGNORE_FILE)).toBe(DEFAULT_SEAFILE_IGNORE);
	});

	test("does not upload a new local file matched by Seafile rules", async () => {
		const sync = setup();
		await global.app.vault.adapter.write(SEAFILE_IGNORE_FILE, "*.tmp\n");
		await global.app.vault.adapter.write("draft.tmp", "local only");
		await sync.reloadIgnoreFile();
		const root = await SyncNode.deserialize("", { prev: null, children: {} });
		const node = root.createChild("draft.tmp");
		const changes = [];

		await sync.pull(changes, "/draft.tmp", node, undefined);

		expect(changes).toHaveLength(0);
		expect(await global.app.vault.adapter.exists("draft.tmp")).toBe(true);
		expect(node.state.type).toBe("delete");
	});

	test("downloads an ignored file that already exists on the server", async () => {
		const adapter = global.app.vault.adapter;
		const contents = new TextEncoder().encode("from server");
		const fileFs: FileSeafFs = {
			block_ids: ["content-block"],
			size: contents.byteLength,
			type: TYPE_FILE,
			version: 1,
		};
		const fakeServer = {
			getFs: async () => ["content-fs", fileFs],
			getBlock: async () => contents.buffer,
		};
		const fakeApp = {
			vault: {
				configDir: ".obsidian",
				adapter,
				getAbstractFileByPath: (path: string) => path === "" ? { children: [] } : null,
			}
		};
		initConfig(fakeApp as never, fakeServer as never, "seafile-continued");
		const sync = new SyncController(adapter, { account: "tester" } as never);
		await adapter.write(SEAFILE_IGNORE_FILE, "*.tmp\n");
		await sync.reloadIgnoreFile();
		const root = await SyncNode.deserialize("", { prev: null, children: {} });
		const node = root.createChild("remote.tmp");
		const remote: FileSeafDirent = {
			id: "content-fs",
			mode: MODE_FILE,
			modifier: "tester",
			mtime: 1700000000,
			name: "remote.tmp",
			size: contents.byteLength,
		};

		await sync.pull([], "/remote.tmp", node, remote);

		expect(await adapter.read("remote.tmp")).toBe("from server");
		expect(node.state.type).toBe("sync");
	});

	test("does not upload local edits when the tracked server file is unchanged", async () => {
		const sync = setup();
		await global.app.vault.adapter.write(SEAFILE_IGNORE_FILE, "*.tmp\n");
		await global.app.vault.adapter.write("draft.tmp", "local edit");
		await sync.reloadIgnoreFile();
		const remote: FileSeafDirent = {
			id: "existing-fs",
			mode: MODE_FILE,
			modifier: "tester",
			mtime: 1700000000,
			name: "draft.tmp",
			size: 8,
		};
		const root = await SyncNode.deserialize("", {
			prev: null,
			children: { "draft.tmp": { prev: remote, children: {} } },
		});
		const node = root.getChildren()["draft.tmp"];
		const changes = [];

		await sync.pull(changes, "/draft.tmp", node, remote);

		expect(changes).toHaveLength(0);
		expect(await global.app.vault.adapter.read("draft.tmp")).toBe("local edit");
		expect(node.state.type).toBe("sync");
	});
});
