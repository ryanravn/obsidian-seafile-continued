import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { DOWNLOAD_JOURNAL_PATH, HEAD_COMMIT_PATH, initConfig, SYNC_DATA_PATH, SYNC_DLOG_PATH } from "../config";
import { RepositoryUnavailableError } from "../server";
import { SyncController } from "../sync/controller";
import { debug } from "../utils";

beforeEach(() => {
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: globalThis,
	});
	jest.spyOn(debug, "error").mockImplementation(() => {});
	jest.spyOn(debug, "log").mockImplementation(() => {});
	jest.spyOn(debug, "warn").mockImplementation(() => {});
	jest.spyOn(debug, "time").mockImplementation(() => {});
	jest.spyOn(debug, "timeEnd").mockImplementation(() => {});
});

afterEach(() => {
	jest.restoreAllMocks();
	jest.useRealTimers();
	delete (globalThis as { window?: unknown }).window;
});

describe("sync status", () => {
	test("supports independent UI status subscribers", () => {
		const sync = new SyncController({} as never, { interval: 1000 } as never);
		const first = jest.fn();
		const second = jest.fn();
		const unsubscribeFirst = sync.subscribeStatus(first);
		sync.subscribeStatus(second);

		(sync as unknown as { status: { type: "idle" } }).status = { type: "idle" };
		unsubscribeFirst();
		(sync as unknown as { status: { type: "stop" } }).status = { type: "stop" };

		expect(first).toHaveBeenCalledTimes(2);
		expect(second).toHaveBeenCalledTimes(3);
	});

	test("keeps the first failure visible while scheduling a retry", async () => {
		jest.useFakeTimers();
		const sync = new SyncController({} as never, {
			ignore: "",
			interval: 1000,
		} as never);
		const onIssue = jest.fn();
		sync.onIssue = onIssue;
		jest.spyOn(sync, "sync").mockRejectedValue(new Error("server rejected the request"));

		(sync as unknown as { status: { type: "idle" } }).status = { type: "idle" };
		await sync.syncCycle();

		expect(sync.status).toEqual({
			type: "idle",
			error: "server rejected the request",
		});
		expect(onIssue).not.toHaveBeenCalled();
		await sync.stopSyncAsync();
	});

	test("records a generic failure only after automatic retries are exhausted", async () => {
		jest.useFakeTimers();
		const sync = new SyncController({} as never, { ignore: "", interval: 1000 } as never);
		const onIssue = jest.fn();
		sync.onIssue = onIssue;
		jest.spyOn(sync, "sync").mockRejectedValue(new Error("persistent server failure"));
		(sync as unknown as { status: { type: "idle" } }).status = { type: "idle" };

		for (let attempt = 0; attempt < 5; attempt++) await sync.syncCycle();

		expect(sync.status).toMatchObject({ type: "stop", message: "error" });
		expect(onIssue).toHaveBeenCalledTimes(1);
		expect(onIssue).toHaveBeenCalledWith({ kind: "error", message: "persistent server failure" });
	});

	test("does not record a HEAD race even if retries are exhausted", async () => {
		jest.useFakeTimers();
		const sync = new SyncController({} as never, { ignore: "", interval: 1000 } as never);
		const onIssue = jest.fn();
		sync.onIssue = onIssue;
		jest.spyOn(sync, "sync").mockRejectedValue(new Error("Seafile HEAD verification failed: expected 'ours', received 'theirs'."));
		(sync as unknown as { status: { type: "idle" } }).status = { type: "idle" };

		for (let attempt = 0; attempt < 5; attempt++) await sync.syncCycle();

		expect(sync.status).toMatchObject({ type: "stop", message: "error" });
		expect(onIssue).not.toHaveBeenCalled();
	});

	test("clears an earlier failure after a successful retry", async () => {
		jest.useFakeTimers();
		const sync = new SyncController({} as never, {
			ignore: "",
			interval: 1000,
		} as never);
		jest.spyOn(sync, "sync")
			.mockRejectedValueOnce(new Error("temporary failure"))
			.mockResolvedValueOnce(undefined);

		(sync as unknown as { status: { type: "idle" } }).status = { type: "idle" };
		await sync.syncCycle();
		expect(sync.status).toEqual({ type: "idle", error: "temporary failure" });

		await sync.syncCycle();
		expect(sync.status).toEqual({ type: "idle" });
		await sync.stopSyncAsync();
	});

	test("stops immediately when the repository no longer exists", async () => {
		jest.useFakeTimers();
		const sync = new SyncController({} as never, { interval: 1000 } as never);
		const onUnavailable = jest.fn();
		sync.onRepositoryUnavailable = onUnavailable;
		jest.spyOn(sync, "sync").mockRejectedValue(new RepositoryUnavailableError(444));

		(sync as unknown as { status: { type: "idle" } }).status = { type: "idle" };
		await sync.syncCycle();

		expect(sync.status).toEqual({
			type: "stop",
			message: "repository-unavailable",
			error: "The configured Seafile repository no longer exists or is no longer accessible.",
		});
		expect(onUnavailable).toHaveBeenCalledTimes(1);
		expect(jest.getTimerCount()).toBe(0);
	});

	test("resets repository bookkeeping without deleting vault files", async () => {
		const files = new Map<string, string>([["note.md", "keep me"]]);
		const adapter = {
			exists: async (path: string) => files.has(path),
			read: async (path: string) => {
				if (!files.has(path)) throw new Error("ENOENT");
				return files.get(path)!;
			},
			write: async (path: string, value: string) => { files.set(path, value); },
			remove: async (path: string) => { files.delete(path); },
		};
		initConfig({ vault: { configDir: ".obsidian", adapter } } as never, {} as never, "seafile");
		files.set(SYNC_DATA_PATH, JSON.stringify({ prev: null, children: { "old.md": { prev: null, children: {} } } }));
		files.set(SYNC_DLOG_PATH, "old sync log");
		files.set(HEAD_COMMIT_PATH, "old-head");
		files.set(DOWNLOAD_JOURNAL_PATH, "");

		const sync = new SyncController(adapter as never, { interval: 1000 } as never);
		await sync.resetForRepositoryChange();

		expect(files.get("note.md")).toBe("keep me");
		expect(files.get(SYNC_DATA_PATH)).toBe("");
		expect(files.get(SYNC_DLOG_PATH)).toBe("");
		expect(files.has(HEAD_COMMIT_PATH)).toBe(false);
		expect(files.has(DOWNLOAD_JOURNAL_PATH)).toBe(false);
		expect(sync.status).toEqual({ type: "stop" });
	});
});
