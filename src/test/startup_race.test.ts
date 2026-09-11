import { describe, expect, test } from "@jest/globals";
import { initConfig } from "../config";
import { MODE_FILE } from "../server";
import { SyncController, type NodeChange } from "../sync/controller";
import { SyncNode } from "../sync/node";
import type { FileSeafDirent } from "../server";
import type { App, DataAdapter } from "obsidian";
import type Server from "../server";
import type { SeafileSettings } from "../settings";

// Regression test for issue #1: "Bulk delete followed by bulk reupload".
//
// Root cause: fastStat() resolved local files purely through Obsidian's
// in-memory index (app.vault.getAbstractFileByPath). When the first sync ran
// before that index finished loading at startup, every tracked file looked
// locally deleted -- so pull() queued a remote delete for each one. Once the
// index loaded, the still-present files looked brand new and were re-added.
// Two commits: a bulk delete, then a bulk reupload.
//
// The fix: fastStat() now confirms against the real filesystem (adapter.stat)
// when the index reports a path as absent, so a not-yet-loaded index can no
// longer be mistaken for a deletion.

const remote: FileSeafDirent = {
	id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	mode: MODE_FILE,
	modifier: "tester",
	mtime: 1700000000,
	name: "note.md",
	size: 5,
};

// Fake App whose index visibility we control independently from what is on disk.
// onDisk models the real filesystem (adapter.stat); indexReady models whether
// Obsidian's getAbstractFileByPath has loaded the file yet.
function makeFakeApp(opts: { indexReady: boolean; onDisk: boolean }) {
	return {
		vault: {
			configDir: ".obsidian",
			adapter: {
				append: async () => {},
				read: async () => "",
				write: async () => {},
				exists: async () => true,
				// The filesystem still has the file even while the index is empty.
				stat: async (path: string) => {
					while (path.startsWith("/")) path = path.slice(1);
					if (path === "note.md" && opts.onDisk) {
						return { type: "file", size: remote.size, ctime: 0, mtime: remote.mtime * 1000 };
					}
					return null;
				},
			},
			getAbstractFileByPath(path: string) {
				while (path.startsWith("/")) path = path.slice(1);
				if (path === "") return { children: [] };
				return null; // index not yet aware of note.md (startup window)
			},
		},
	} as unknown as App;
}

async function startupTree() {
	// SyncNode.load() -> deserialize() restores `prev` from disk but leaves
	// prevDirty at its default (true). This is the state of every node on the
	// first sync cycle after Obsidian launches.
	const root = await SyncNode.deserialize("", {
		prev: null,
		children: { "note.md": { prev: remote, children: {} } },
	});
	const fileNode = root.getChildren()["note.md"];
	expect(fileNode.prevDirty).toBe(true);
	return fileNode;
}

describe("Issue #1: startup race must not delete on-disk files", () => {
	const settings = { ignore: "", account: "tester" } as unknown as SeafileSettings;

	test("a genuinely deleted file is still removed on the server", async () => {
		// File absent from BOTH the index and disk -> a real local deletion.
		// The fix must not suppress these, only the false positives.
		const app = makeFakeApp({ indexReady: false, onDisk: false });
		initConfig(app, {} as unknown as Server, "seafile");
		const sync = new SyncController(app.vault.adapter as unknown as DataAdapter, settings);
		const fileNode = await startupTree();

		const changes: NodeChange[] = [];
		await sync.pull(changes, "/note.md", fileNode, remote);

		expect(changes.filter((c) => c.type === "remove-file")).toHaveLength(1);
		expect(fileNode.state.type).toBe("delete");
	});

	test("the fix: a file still on disk is NOT deleted even with an empty index", async () => {
		// Index hasn't loaded note.md yet, but the file is physically present.
		const app = makeFakeApp({ indexReady: false, onDisk: true });
		initConfig(app, {} as unknown as Server, "seafile");
		const sync = new SyncController(app.vault.adapter as unknown as DataAdapter, settings);
		const fileNode = await startupTree();

		const changes: NodeChange[] = [];
		await sync.pull(changes, "/note.md", fileNode, remote);

		// fastStat falls back to adapter.stat, sees the file, treats it as "same".
		expect(changes.filter((c) => c.type === "remove-file")).toHaveLength(0);
		expect(fileNode.state.type).toBe("sync");
	});
});
