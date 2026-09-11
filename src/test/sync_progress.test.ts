import { describe, expect, jest, test } from "@jest/globals";
import { initConfig } from "../config";
import { MODE_DIR, MODE_FILE, TYPE_DIR, type DirSeafDirent, type DirSeafFs } from "../server";
import { SyncController, type SYNC_BUSY } from "../sync/controller";
import { SyncNode } from "../sync/node";
import { formatSyncActivity, shouldShowSyncStatusText } from "../ui/sync_progress";

describe("sync progress labels", () => {
	test("applies the configured persistent-text visibility independently of status content", () => {
		const idle = { type: "idle" } as const;
		const busy = { type: "busy", message: "upload" } as const;
		const stopped = { type: "stop", message: "user" } as const;

		expect(shouldShowSyncStatusText("always", idle)).toBe(true);
		expect(shouldShowSyncStatusText("always", stopped)).toBe(true);
		expect(shouldShowSyncStatusText("syncing", busy)).toBe(true);
		expect(shouldShowSyncStatusText("syncing", idle)).toBe(false);
		expect(shouldShowSyncStatusText("syncing", stopped)).toBe(false);
		expect(shouldShowSyncStatusText("never", busy)).toBe(false);
	});

	test("shows compact preparation and download file counts", () => {
		expect(formatSyncActivity({
			type: "busy", message: "download",
			progress: { operation: "prepare", completedFiles: 2, totalFiles: 7 }
		})).toBe("Preparing 2/7");

		expect(formatSyncActivity({
			type: "busy", message: "download",
			progress: { operation: "download", completedFiles: 3, totalFiles: 12 }
		})).toBe("Downloading 3/12");
	});

	test("shows compact aggregate upload progress", () => {
		const status: SYNC_BUSY = {
			type: "busy", message: "upload",
			progress: { operation: "upload", completedFiles: 4, totalFiles: 7 }
		};
		expect(formatSyncActivity(status)).toBe("Uploading 4/7");
	});

	test("shows block discovery and verification progress", () => {
		expect(formatSyncActivity({
			type: "busy", message: "upload",
			progress: { operation: "check-blocks", completedBlocks: 1000, totalBlocks: 3319 }
		})).toBe("Checking blocks 1000/3319");

		expect(formatSyncActivity({
			type: "busy", message: "upload",
			progress: { operation: "verify-blocks", completedBlocks: 2000, totalBlocks: 3319 }
		})).toBe("Verifying blocks 2000/3319");
	});

	test("shows metadata publication and local-state progress", () => {
		expect(formatSyncActivity({
			type: "busy", message: "upload",
			progress: { operation: "check-metadata", completedItems: 1000, totalItems: 3320 }
		})).toBe("Checking metadata 1000/3320");
		expect(formatSyncActivity({
			type: "busy", message: "upload",
			progress: { operation: "prepare-metadata", completedItems: 400, totalItems: 3320 }
		})).toBe("Preparing metadata 400/3320");
		expect(formatSyncActivity({
			type: "busy", message: "upload",
			progress: { operation: "publish-metadata", completedItems: 1200, totalItems: 3320 }
		})).toBe("Publishing metadata 1200/3320");
		expect(formatSyncActivity({
			type: "busy", message: "upload",
			progress: { operation: "verify-metadata", completedItems: 2000, totalItems: 3320 }
		})).toBe("Verifying metadata 2000/3320");
		expect(formatSyncActivity({
			type: "busy", message: "upload",
			progress: { operation: "publish-commit", completedItems: 0, totalItems: 1 }
		})).toBe("Publishing commit 0/1");
		expect(formatSyncActivity({
			type: "busy", message: "upload",
			progress: { operation: "save-state", completedItems: 2000, totalItems: 3320 }
		})).toBe("Saving state 2000/3320");
		expect(formatSyncActivity({
			type: "busy", message: "upload",
			progress: { operation: "compact-state", completedItems: 0, totalItems: 1 }
		})).toBe("Compacting state 0/1");
	});

	test("describes phases before exact progress is available", () => {
		expect(formatSyncActivity({ type: "busy", message: "fetch" })).toBe("Checking remote changes");
		expect(formatSyncActivity({ type: "busy", message: "download" })).toBe("Comparing files");
		expect(formatSyncActivity({ type: "busy", message: "upload" })).toBe("Finalizing upload");
	});
});

describe("sync progress planning", () => {
	test("counts upload and download files before transfers begin", async () => {
		const files = new Map([
			["local.md", { type: "file", size: 5, ctime: 0, mtime: 1700000000 * 1000 }],
			["same.md", { type: "file", size: 4, ctime: 0, mtime: 1700000000 * 1000 }],
		]);
		const stat = jest.fn(async (path: string) => path === "/"
			? { type: "folder", size: 0, ctime: 0, mtime: 0 }
			: files.get(path) ?? null);
		const list = jest.fn(async () => ({ files: Array.from(files.keys()), folders: [] }));
		const adapter = {
			stat,
			list,
		};
		const remoteFs: DirSeafFs = {
			type: TYPE_DIR,
			version: 1,
			dirents: [
				{ id: "remote", mode: MODE_FILE, modifier: "remote", mtime: 1700000000, name: "remote.md", size: 6 },
				{ id: "same", mode: MODE_FILE, modifier: "remote", mtime: 1700000000, name: "same.md", size: 4 },
			]
		};
		const server = { getFs: async () => ["root", remoteFs] };
		initConfig({
			vault: { configDir: ".obsidian", adapter, getAbstractFileByPath: () => null }
		} as never, server as never, "seafile");
		const sync = new SyncController(adapter as never, { account: "tester" } as never);
		const root = await SyncNode.deserialize("", { prev: null, children: {} });
		const remoteRoot: DirSeafDirent = { id: "root", mode: MODE_DIR, mtime: 1700000000, name: "" };
		const internal = sync as unknown as {
			planSync: (path: string, node: SyncNode, remote: DirSeafDirent) => Promise<{ downloads: number, uploads: number }>
		};

		await expect(internal.planSync("", root, remoteRoot)).resolves.toMatchObject({ downloads: 1, uploads: 1 });
		const callsAfterFirstPlan = { stats: stat.mock.calls.length, lists: list.mock.calls.length };
		await expect(internal.planSync("", root, remoteRoot)).resolves.toMatchObject({ downloads: 1, uploads: 1 });
		expect(stat).toHaveBeenCalledTimes(callsAfterFirstPlan.stats);
		expect(list).toHaveBeenCalledTimes(callsAfterFirstPlan.lists);
	});
});
