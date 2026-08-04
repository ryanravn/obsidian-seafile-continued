import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { DEFAULT_SEAFILE_IGNORE, initConfig } from "../config";
import { compileIgnoreList, createDefaultIgnoreFile, SEAFILE_IGNORE_FILE } from "../ignore";
import { MODE_DIR, MODE_FILE, TYPE_FILE, type DirSeafFs, type FileSeafDirent, type FileSeafFs } from "../server";
import { SyncController } from "../sync/controller";
import { SyncNode } from "../sync/node";

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
	initConfig(fakeApp as never, fakeServer as never, "seafile-continued");
	return new SyncController(adapter, { account: "tester" } as never);
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
	});

	test("generates editable recommended defaults", () => {
		const defaults = createDefaultIgnoreFile(".obsidian", "seafile-continued");
		expect(defaults).toContain(".git/");
		expect(defaults).toContain("*/.git/");
		expect(defaults).toContain(".obsidian/workspace.json");
		expect(defaults).toContain(".obsidian/plugins/seafile-continued/");
	});
});

describe("Seafile ignore file lifecycle", () => {
	test("downloads an existing remote ignore file before traversal", async () => {
		const sync = setup(remoteIgnoreContents);

		await bootstrap(sync);

		expect(await global.app.vault.adapter.read(SEAFILE_IGNORE_FILE)).toBe(remoteIgnoreContents);
		expect((await global.app.vault.adapter.stat(SEAFILE_IGNORE_FILE))?.mtime).toBe(1700000000 * 1000);
		expect(sync.isPathIgnored("notes/cache.tmp", false)).toBe(true);
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
