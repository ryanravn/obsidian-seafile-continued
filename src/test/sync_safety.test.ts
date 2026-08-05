import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { rm } from "fs/promises";
import { DOWNLOAD_JOURNAL_PATH, initConfig, SYNC_DLOG_PATH } from "../config";
import { MODE_DIR, MODE_FILE, TYPE_FILE, type DirSeafDirent, type FileSeafDirent, type FileSeafFs } from "../server";
import { SyncController, type NodeChange } from "../sync/controller";
import { SyncNode } from "../sync/node";
import { debug } from "../utils";

const originalPath = "atomic-note.md";

function fullPath(path: string): string {
	return (global.app.vault.adapter as unknown as { getFullPath: (value: string) => string }).getFullPath(path);
}

function setupServer(
	fs: FileSeafFs,
	blocks: Record<string, ArrayBuffer | Error>,
	getBlockOverride?: (id: string) => Promise<ArrayBuffer>
): SyncController {
	const adapter = global.app.vault.adapter;
	const fakeServer = {
		crypto: null,
		getFs: async () => ["fs-id", fs],
		getBlock: getBlockOverride ?? (async (id: string) => {
			const value = blocks[id];
			if (value instanceof Error) throw value;
			return value;
		})
	};
	const fakeApp = {
		vault: {
			configDir: ".obsidian",
			adapter,
			getAbstractFileByPath: () => null
		}
	};
	initConfig(fakeApp as never, fakeServer as never, "seafile");
	return new SyncController(adapter, { ignore: "", account: "person@example.com" } as never);
}

beforeEach(async () => {
	await global.app.vault.adapter.mkdir("");
	await global.app.vault.adapter.mkdir(".obsidian/plugins/seafile");
	await global.app.vault.adapter.write(".obsidian/plugins/seafile/sync_dlog", "");
});

afterEach(async () => {
	jest.restoreAllMocks();
	const listed = await global.app.vault.adapter.list("");
	for (const path of listed.files.filter(path => path.includes("atomic-note.md"))) {
		await rm(fullPath(path));
	}
});

describe("sync data safety", () => {
	test("keeps the original file when a block download fails", async () => {
		const fs: FileSeafFs = { block_ids: ["first", "second"], size: 6, type: TYPE_FILE, version: 1 };
		const sync = setupServer(fs, {
			first: new TextEncoder().encode("abc").buffer,
			second: new Error("connection lost")
		});
		await global.app.vault.adapter.write(originalPath, "original");

		await expect(sync.downloadFile(originalPath, "fs-id", 1700000000, 6)).rejects.toThrow("connection lost");

		expect(await global.app.vault.adapter.read(originalPath)).toBe("original");
		const listed = await global.app.vault.adapter.list("");
		expect(listed.files.filter(path => path.includes("seafile-download"))).toHaveLength(0);
		expect(listed.files.filter(path => path.includes("seafile-backup"))).toHaveLength(0);
	});

	test("replaces the destination only after the complete file is verified", async () => {
		const fs: FileSeafFs = { block_ids: ["first", "second"], size: 6, type: TYPE_FILE, version: 1 };
		const sync = setupServer(fs, {
			first: new TextEncoder().encode("abc").buffer,
			second: new TextEncoder().encode("def").buffer
		});
		await global.app.vault.adapter.write(originalPath, "original");
		const progress: number[] = [];

		await sync.downloadFile(originalPath, "fs-id", 1700000000, 6, completed => progress.push(completed));

		expect(await global.app.vault.adapter.read(originalPath)).toBe("abcdef");
		expect((await global.app.vault.adapter.stat(originalPath))?.mtime).toBe(1700000000 * 1000);
		expect(progress).toEqual([0, 3, 6]);
	});

	test("prefetches desktop blocks concurrently and appends them in order", async () => {
		const blockIds = ["first", "second", "third", "fourth", "fifth"];
		const fs: FileSeafFs = { block_ids: blockIds, size: blockIds.length, type: TYPE_FILE, version: 1 };
		let active = 0;
		let maximumActive = 0;
		const sync = setupServer(fs, {}, async id => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			const index = blockIds.indexOf(id);
			await new Promise(resolve => setTimeout(resolve, (blockIds.length - index) * 5));
			active--;
			return new TextEncoder().encode(String(index)).buffer;
		});

		await sync.downloadFile(originalPath, "fs-id", 1700000000, blockIds.length);

		expect(maximumActive).toBe(4);
		expect(await global.app.vault.adapter.read(originalPath)).toBe("01234");
	});

	test("restores the original when installing the verified replacement fails", async () => {
		const fs: FileSeafFs = { block_ids: ["only"], size: 3, type: TYPE_FILE, version: 1 };
		const sync = setupServer(fs, { only: new TextEncoder().encode("new").buffer });
		await global.app.vault.adapter.write(originalPath, "original");
		const adapter = global.app.vault.adapter;
		const rename = adapter.rename.bind(adapter);
		let calls = 0;
		jest.spyOn(adapter, "rename").mockImplementation(async (from, to) => {
			calls++;
			if (calls === 2) throw new Error("rename failed");
			await rename(from, to);
		});

		await expect(sync.downloadFile(originalPath, "fs-id", 1700000000, 3)).rejects.toThrow("rename failed");

		expect(await adapter.read(originalPath)).toBe("original");
		expect(await adapter.exists(`.${originalPath}.seafile-backup`)).toBe(false);
	});

	test("restores an original file from an interrupted replacement backup at startup", async () => {
		const fs: FileSeafFs = { block_ids: [], size: 0, type: TYPE_FILE, version: 1 };
		const sync = setupServer(fs, {});
		await global.app.vault.adapter.write(`.${originalPath}.seafile-backup`, "recover me");
		await global.app.vault.adapter.write(`.${originalPath}.seafile-download`, "partial");
		await global.app.vault.adapter.write(DOWNLOAD_JOURNAL_PATH, JSON.stringify({
			path: originalPath,
			tempPath: `.${originalPath}.seafile-download`,
			backupPath: `.${originalPath}.seafile-backup`
		}));

		await sync.init();

		expect(await global.app.vault.adapter.read(originalPath)).toBe("recover me");
		expect(await global.app.vault.adapter.exists(`.${originalPath}.seafile-backup`)).toBe(false);
		expect(await global.app.vault.adapter.exists(`.${originalPath}.seafile-download`)).toBe(false);
	});

	test("persists and notifies a batch of applied nodes once", async () => {
		setupServer({ block_ids: [], size: 0, type: TYPE_FILE, version: 1 }, {});
		const root = await SyncNode.deserialize("", {
			prev: null,
			children: {
				"first.md": { prev: null, children: {} },
				"second.md": { prev: null, children: {} }
			}
		});
		const nodes = Object.values(root.getChildren());
		nodes.forEach((node, index) => node.setNext({
			id: String(index), mode: MODE_FILE, modifier: "tester", mtime: 1700000000, name: node.name, size: 1
		}, false));
		const adapter = global.app.vault.adapter;
		const append = jest.spyOn(adapter, "append");
		const batches: SyncNode[][] = [];
		const singles: SyncNode[] = [];
		const previousBatchListener = SyncNode.onStatesChanged;
		const previousListener = SyncNode.onStateChanged;
		SyncNode.onStatesChanged = changed => batches.push(changed);
		SyncNode.onStateChanged = changed => singles.push(changed);
		const progress: number[] = [];

		try {
			await SyncNode.applyNextBatch(nodes, completed => progress.push(completed));
		} finally {
			SyncNode.onStatesChanged = previousBatchListener;
			SyncNode.onStateChanged = previousListener;
		}

		const journalAppends = append.mock.calls.filter(([path]) => path === SYNC_DLOG_PATH);
		expect(journalAppends).toHaveLength(1);
		expect((journalAppends[0][1] as string).trim().split("\n")).toHaveLength(2);
		expect(progress).toEqual([1, 2]);
		expect(batches).toHaveLength(1);
		expect(batches[0]).toEqual(nodes);
		expect(singles).toHaveLength(0);
		expect(nodes.every(node => node.state.type === "sync")).toBe(true);
	});

	test("preserves a locally edited file as a Seafile conflict copy", async () => {
		const remoteContents = "remote changes";
		const fs: FileSeafFs = { block_ids: ["remote-block"], size: remoteContents.length, type: TYPE_FILE, version: 1 };
		const sync = setupServer(fs, {
			"remote-block": new TextEncoder().encode(remoteContents).buffer
		});
		await global.app.vault.adapter.write(originalPath, "local changes", { mtime: 1700000100 * 1000 });

		const previous: FileSeafDirent = {
			id: "previous-fs",
			mode: MODE_FILE,
			modifier: "person@example.com",
			mtime: 1700000000,
			name: originalPath,
			size: 3
		};
		const remote: FileSeafDirent = {
			...previous,
			id: "fs-id",
			modifier: "other@example.com",
			mtime: 1700000200,
			size: remoteContents.length
		};
		const root = await SyncNode.deserialize("", {
			prev: null,
			children: { [originalPath]: { prev: previous, children: {} } }
		});
		const changes: NodeChange[] = [];

		await sync.pull(changes, `/${originalPath}`, root.getChildren()[originalPath], remote);

		expect(await global.app.vault.adapter.read(originalPath)).toBe(remoteContents);
		const listed = await global.app.vault.adapter.list("");
		const conflict = listed.files.find(path => path.includes("SFConflict person@example.com"));
		expect(conflict).toBeDefined();
		expect(await global.app.vault.adapter.read(conflict!)).toBe("local changes");
		expect(changes.some(change => change.type === "add" && change.node.path.includes("SFConflict"))).toBe(true);
	});

	test("clears a stale pending root when reconciliation finds identical content", async () => {
		const sync = setupServer({ block_ids: [], size: 0, type: TYPE_FILE, version: 1 }, {});
		const remote: DirSeafDirent = { id: "root-id", mode: MODE_DIR, mtime: 1700000000, name: "" };
		const childRemote: DirSeafDirent = { id: "child-id", mode: MODE_DIR, mtime: remote.mtime, name: "child" };
		const root = await SyncNode.deserialize("", {
			prev: remote,
			children: { child: { prev: childRemote, children: {} } }
		});
		root.prevDirty = false;
		root.setNext({ ...remote, mtime: remote.mtime - 1 }, false);
		root.children.child.setNext({ ...childRemote, mtime: childRemote.mtime - 1 }, false);

		await sync.pull([], "", root, remote);

		expect(root.next).toBeUndefined();
		expect(root.children.child.next).toBeUndefined();
		expect(root.state.type).toBe("sync");
	});

	test("does not let plugin state writes dirty the vault root", async () => {
		const sync = setupServer({ block_ids: [], size: 0, type: TYPE_FILE, version: 1 }, {});
		await sync.init();
		const internal = sync as unknown as { nodeRoot: SyncNode };
		internal.nodeRoot.prevDirty = false;

		await sync.notifyChange("/.obsidian/plugins/seafile/sync_dlog", "modify");

		expect(internal.nodeRoot.prevDirty).toBe(false);
	});

	test("does not publish a stale pending root without semantic changes", async () => {
		const warn = jest.spyOn(debug, "warn").mockImplementation(() => undefined);
		const adapter = global.app.vault.adapter;
		const createCommit = jest.fn(async () => { throw new Error("must not create a commit"); });
		const fakeServer = {
			crypto: null,
			createCommit,
			describeCommit: () => ""
		};
		const fakeApp = { vault: { configDir: ".obsidian", adapter, getAbstractFileByPath: () => null } };
		initConfig(fakeApp as never, fakeServer as never, "seafile");
		const sync = new SyncController(adapter, { account: "person@example.com" } as never);
		const remote: DirSeafDirent = { id: "root-id", mode: MODE_DIR, mtime: 1700000000, name: "" };
		const root = await SyncNode.deserialize("", { prev: remote, children: {} });
		root.setNext({ ...remote, mtime: remote.mtime + 1 }, false);

		await expect(sync.push(root, [], "parent-commit")).resolves.toBe("parent-commit");
		expect(createCommit).not.toHaveBeenCalled();
		expect(root.next).toBeUndefined();
		expect(warn).toHaveBeenCalledWith("Discarded stale pending state without semantic changes.");
	});

	test("does not publish metadata-only directory changes", async () => {
		const warn = jest.spyOn(debug, "warn").mockImplementation(() => undefined);
		const adapter = global.app.vault.adapter;
		const createCommit = jest.fn(async () => { throw new Error("must not create a commit"); });
		const fakeServer = { crypto: null, createCommit, describeCommit: () => "" };
		const fakeApp = { vault: { configDir: ".obsidian", adapter, getAbstractFileByPath: () => null } };
		initConfig(fakeApp as never, fakeServer as never, "seafile");
		const sync = new SyncController(adapter, { account: "person@example.com" } as never);
		const remote: DirSeafDirent = { id: "old-root", mode: MODE_DIR, mtime: 1700000000, name: "" };
		const root = await SyncNode.deserialize("", { prev: remote, children: {} });
		root.setNext({ ...remote, id: "metadata-only-root", mtime: remote.mtime + 1 }, false);

		await expect(sync.push(root, [{ node: root, type: "modify" }], "parent-commit")).resolves.toBe("parent-commit");
		expect(createCommit).not.toHaveBeenCalled();
		expect(root.next).toBeUndefined();
		expect(root.prevDirty).toBe(false);
		expect(warn).toHaveBeenCalledWith(
			"Discarded a metadata-only synchronization plan instead of publishing an empty commit."
		);
	});
});
