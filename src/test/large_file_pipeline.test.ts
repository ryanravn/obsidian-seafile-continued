import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { rm } from "fs/promises";
import { initConfig } from "../config";
import Server, { TYPE_FILE, type FileSeafFs } from "../server";
import { DEFAULT_SETTINGS } from "../settings";
import { SyncController, type NodeChange, type SyncProgress } from "../sync/controller";
import { SyncNode, type STATE_UPLOAD } from "../sync/node";
import { SEAFILE_BLOCK_SIZE } from "../utils";

const testPath = "large-file-pipeline.bin";
const smallTestPaths = Array.from({ length: 8 }, (_, index) => `upload-small-${index}.bin`);

function makeContents(): ArrayBuffer {
	const bytes = new Uint8Array(SEAFILE_BLOCK_SIZE * 2 + 17);
	bytes.fill(0x11, 0, SEAFILE_BLOCK_SIZE);
	bytes.fill(0x22, SEAFILE_BLOCK_SIZE, SEAFILE_BLOCK_SIZE * 2);
	bytes.fill(0x33, SEAFILE_BLOCK_SIZE * 2);
	return bytes.buffer;
}

function setup(options: {
	storeBlocksAfterAttempt?: number
	storeFs?: boolean
	publishedHead?: string
	uploadDelayMs?: number
	uploadBarrier?: number
	encryptionDelayMs?: number
	fsOperationDelayMs?: number
} = {}) {
	const adapter = global.app.vault.adapter;
	let activeUploads = 0;
	let maximumActiveUploads = 0;
	let activeEncryptions = 0;
	let maximumActiveEncryptions = 0;
	let encryptionCalls = 0;
	let activeFsChecks = 0;
	let maximumActiveFsChecks = 0;
	let activeFsUploads = 0;
	let maximumActiveFsUploads = 0;
	const uploadedIds: string[] = [];
	const storedIds = new Set<string>();
	const uploadAttempts = new Map<string, number>();
	const storedFs = new Set<string>();
	let releaseUploadBarrier = (): void => {};
	const uploadBarrier = new Promise<void>(resolve => { releaseUploadBarrier = resolve; });
	const checkBlocksList = jest.fn(async (ids: string[]) => new Map(ids.map(id => [id, !storedIds.has(id)])));
	const uploadBlock = jest.fn(async (id: string) => {
		activeUploads++;
		maximumActiveUploads = Math.max(maximumActiveUploads, activeUploads);
		if (activeUploads >= (options.uploadBarrier ?? Number.POSITIVE_INFINITY)) releaseUploadBarrier();
		if (options.uploadBarrier !== undefined) {
			await new Promise<void>(resolve => {
				const timeout = setTimeout(resolve, 250);
				void uploadBarrier.then(() => {
					clearTimeout(timeout);
					resolve();
				});
			});
		}
		await new Promise(resolve => setTimeout(resolve, options.uploadDelayMs ?? 5));
		uploadedIds.push(id);
		const attempts = (uploadAttempts.get(id) ?? 0) + 1;
		uploadAttempts.set(id, attempts);
		if (attempts >= (options.storeBlocksAfterAttempt ?? 1)) storedIds.add(id);
		activeUploads--;
	});
	const checkFsList = jest.fn(async (ids: string[]) => {
		activeFsChecks++;
		maximumActiveFsChecks = Math.max(maximumActiveFsChecks, activeFsChecks);
		await new Promise(resolve => setTimeout(resolve, options.fsOperationDelayMs ?? 0));
		activeFsChecks--;
		return new Map(ids.map(id => [id, !storedFs.has(id)]));
	});
	const sendPackFs = jest.fn(async (items: Array<[string, unknown]>, onProgress?: (completed: number, total: number) => void) => {
		activeFsUploads++;
		maximumActiveFsUploads = Math.max(maximumActiveFsUploads, activeFsUploads);
		onProgress?.(items.length, items.length);
		await new Promise(resolve => setTimeout(resolve, options.fsOperationDelayMs ?? 0));
		if (options.storeFs !== false) items.forEach(([id]) => storedFs.add(id));
		activeFsUploads--;
		return new Map();
	});
	const uploadCommit = jest.fn(async () => {});
	const setHeadCommit = jest.fn(async () => {});
	const fakeServer = {
		crypto: options.encryptionDelayMs === undefined ? null : {
			encryptBlock: async (data: ArrayBuffer) => {
				encryptionCalls++;
				activeEncryptions++;
				maximumActiveEncryptions = Math.max(maximumActiveEncryptions, activeEncryptions);
				await new Promise(resolve => setTimeout(resolve, options.encryptionDelayMs));
				activeEncryptions--;
				return data;
			}
		},
		checkBlocksList,
		uploadBlock,
		checkFsList,
		sendPackFs,
		createCommit: async () => ({ commit_id: "verified-commit" }),
		uploadCommit,
		setHeadCommit,
		getHeadCommitId: async () => options.publishedHead ?? "verified-commit",
		describeCommit: () => "test",
	};
	const fakeApp = {
		vault: {
			configDir: ".obsidian",
			adapter,
			getAbstractFileByPath: () => null,
		},
	};
	initConfig(fakeApp as never, fakeServer as never, "seafile");
	const sync = new SyncController(adapter, { ignore: "", account: "tester" } as never);
	return {
		adapter, sync, checkBlocksList, uploadBlock, uploadedIds, checkFsList, sendPackFs, uploadCommit, setHeadCommit,
		getMaximumActiveUploads: () => maximumActiveUploads,
		getMaximumActiveEncryptions: () => maximumActiveEncryptions,
		getEncryptionCalls: () => encryptionCalls,
		getMaximumActiveFsChecks: () => maximumActiveFsChecks,
		getMaximumActiveFsUploads: () => maximumActiveFsUploads,
	};
}

function callUploadFileObjects(sync: SyncController, states: STATE_UPLOAD[]): Promise<void> {
	const internal = sync as unknown as {
		uploadFileObjects: (uploads: Array<{ node: SyncNode, state: STATE_UPLOAD, blockIds: string[] }>) => Promise<void>
	};
	return internal.uploadFileObjects(states.map(state => ({
		node: {} as SyncNode,
		state,
		blockIds: state.param.fs && "block_ids" in state.param.fs ? state.param.fs.block_ids : []
	})));
}

async function makeUploadTree(sync: SyncController): Promise<{ root: SyncNode, changes: NodeChange[] }> {
	const root = await SyncNode.deserialize("", {
		prev: null,
		children: { [testPath]: { prev: null, children: {} } },
	});
	const file = root.getChildren()[testPath];
	const [fileDirent, fileFs, source] = await sync.computeFileDirent(testPath, "tester");
	file.setNext(fileDirent, false);
	file.state = { type: "upload", param: { progress: 0, fs: fileFs, source } };
	const [rootDirent, rootFs] = await sync.computeDirDirent("", [fileDirent]);
	root.setNext(rootDirent, false);
	root.state = { type: "upload", param: { progress: 0, fs: rootFs } };
	return {
		root,
		changes: [{ node: file, type: "add" }, { node: root, type: "add" }],
	};
}

afterEach(async () => {
	jest.useRealTimers();
	jest.restoreAllMocks();
	for (const path of [testPath, ...smallTestPaths]) {
		if (await global.app.vault.adapter.exists(path)) {
			await rm((global.app.vault.adapter as unknown as { getFullPath: (path: string) => string }).getFullPath(path));
		}
	}
});

beforeEach(async () => {
	await global.app.vault.adapter.mkdir("");
});

describe("bounded large-file upload pipeline", () => {
	test("reads desktop files in ranges and uploads missing blocks with bounded concurrency", async () => {
		const { adapter, sync, checkBlocksList, uploadedIds, getMaximumActiveUploads } = setup({ uploadBarrier: 3 });
		await adapter.writeBinary(testPath, makeContents());
		const readBinary = jest.spyOn(adapter, "readBinary");

		const [, rawFs, source] = await sync.computeFileDirent(testPath, "tester");
		const fs = rawFs as FileSeafFs;
		expect(fs.block_ids).toHaveLength(3);
		expect(readBinary).not.toHaveBeenCalled();

		const state: STATE_UPLOAD = { type: "upload", param: { progress: 0, fs, source } };
		const uploadProgress: number[] = [];
		sync.onNodeStateChanged = () => uploadProgress.push(state.param.progress);
		await callUploadFileObjects(sync, [state]);

		expect(checkBlocksList).toHaveBeenCalledTimes(2);
		expect(checkBlocksList).toHaveBeenCalledWith(fs.block_ids);
		expect(uploadedIds).toEqual(expect.arrayContaining(fs.block_ids));
		expect(uploadedIds).toHaveLength(fs.block_ids.length);
		expect(getMaximumActiveUploads()).toBeGreaterThan(2);
		expect(getMaximumActiveUploads()).toBeLessThanOrEqual(4);
		expect(state.param.progress).toBe(1);
		expect(uploadProgress.some(progress => progress > 0 && progress < 1)).toBe(true);
		expect(uploadProgress[uploadProgress.length - 1]).toBe(1);
		expect(readBinary).not.toHaveBeenCalled();
	});

	test("batches availability checks and deduplicates blocks across files", async () => {
		const { adapter, sync, checkBlocksList, uploadBlock } = setup();
		await adapter.writeBinary(testPath, makeContents());
		const [, rawFs, source] = await sync.computeFileDirent(testPath, "tester");
		const fs = rawFs as FileSeafFs;
		const states: STATE_UPLOAD[] = [
			{ type: "upload", param: { progress: 0, fs, source } },
			{ type: "upload", param: { progress: 0, fs, source } },
		];

		await callUploadFileObjects(sync, states);

		expect(checkBlocksList).toHaveBeenCalledTimes(2);
		expect(checkBlocksList).toHaveBeenNthCalledWith(1, fs.block_ids);
		expect(checkBlocksList).toHaveBeenNthCalledWith(2, fs.block_ids);
		expect(uploadBlock).toHaveBeenCalledTimes(fs.block_ids.length);
		expect(states.every(state => state.param.progress === 1)).toBe(true);
	});

	test("uses the shared worker pool across several small files", async () => {
		const { adapter, sync, uploadBlock, getMaximumActiveUploads } = setup({ uploadDelayMs: 30 });
		const states: STATE_UPLOAD[] = [];
		for (let index = 0; index < smallTestPaths.length; index++) {
			const path = smallTestPaths[index];
			await adapter.writeBinary(path, new Uint8Array([index + 1]).buffer);
			const [, fs, source] = await sync.computeFileDirent(path, "tester");
			states.push({ type: "upload", param: { progress: 0, fs, source } });
		}

		await callUploadFileObjects(sync, states);

		expect(uploadBlock).toHaveBeenCalledTimes(smallTestPaths.length);
		expect(getMaximumActiveUploads()).toBe(4);
		expect(states.every(state => state.param.progress === 1)).toBe(true);
	});

	test("reports small files as soon as their uploads finish", async () => {
		const { adapter, sync, uploadedIds } = setup({ uploadDelayMs: 30 });
		const states: STATE_UPLOAD[] = [];
		for (let index = 0; index < smallTestPaths.length; index++) {
			const path = smallTestPaths[index];
			await adapter.writeBinary(path, new Uint8Array([index + 1]).buffer);
			const [, fs, source] = await sync.computeFileDirent(path, "tester");
			states.push({ type: "upload", param: { progress: 0, fs, source } });
		}

		const reported: Array<{ completedFiles: number, uploadedBlocks: number }> = [];
		const internal = sync as unknown as {
			progressCounts: { downloads: number, uploadsPrepared: number, uploads: number, plan: { downloads: number, uploads: number } }
			reportProgress: (progress: { operation: string, completedFiles?: number }) => void
		};
		internal.progressCounts = {
			downloads: 0, uploadsPrepared: 0, uploads: 0,
			plan: { downloads: 0, uploads: states.length }
		};
		internal.reportProgress = progress => {
			if (progress.operation === "upload" && progress.completedFiles) {
				reported.push({ completedFiles: progress.completedFiles, uploadedBlocks: uploadedIds.length });
			}
		};

		await callUploadFileObjects(sync, states);

		expect(reported[0].completedFiles).toBe(1);
		expect(reported[0].uploadedBlocks).toBeLessThan(smallTestPaths.length);
		expect(reported[reported.length - 1].completedFiles).toBe(smallTestPaths.length);
	});

	test("prepares several desktop files with bounded concurrency", async () => {
		const { adapter, sync, getMaximumActiveEncryptions } = setup({ encryptionDelayMs: 30 });
		for (let index = 0; index < smallTestPaths.length; index++) {
			await adapter.writeBinary(smallTestPaths[index], new Uint8Array([index + 1]).buffer);
		}

		await Promise.all(smallTestPaths.map(async path => await sync.computeFileDirent(path, "tester")));

		expect(getMaximumActiveEncryptions()).toBeGreaterThan(1);
		expect(getMaximumActiveEncryptions()).toBeLessThanOrEqual(4);
	});

	test("reuses bounded prepared ciphertext during upload", async () => {
		const { adapter, sync, getEncryptionCalls } = setup({ encryptionDelayMs: 0 });
		const internal = sync as unknown as {
			preparedBlockCacheEnabled: boolean
			preparedBlockBytes: number
		};
		internal.preparedBlockCacheEnabled = true;
		await adapter.writeBinary(testPath, makeContents());
		const [, rawFs, source] = await sync.computeFileDirent(testPath, "tester");
		const fs = rawFs as FileSeafFs;
		const callsAfterPreparation = getEncryptionCalls();
		const state: STATE_UPLOAD = { type: "upload", param: { progress: 0, fs, source } };

		await callUploadFileObjects(sync, [state]);

		expect(callsAfterPreparation).toBe(fs.block_ids.length);
		expect(getEncryptionCalls()).toBe(callsAfterPreparation);
		expect(internal.preparedBlockBytes).toBe(0);
	});

	test("caps prepared block reuse at 32 MB", () => {
		const { sync } = setup();
		const internal = sync as unknown as {
			preparedBlockCacheEnabled: boolean
			preparedBlockBytes: number
			preparedBlocks: Map<string, ArrayBuffer>
			cachePreparedBlock: (id: string, data: ArrayBuffer) => void
		};
		internal.preparedBlockCacheEnabled = true;
		for (let index = 0; index < 5; index++) {
			internal.cachePreparedBlock(String(index), new ArrayBuffer(SEAFILE_BLOCK_SIZE));
		}

		expect(internal.preparedBlockBytes).toBe(32 * 1024 * 1024);
		expect(internal.preparedBlocks.size).toBe(4);
	});

	test("refuses to upload a file whose snapshot is stale", async () => {
		const { adapter, sync, uploadBlock } = setup();
		await adapter.writeBinary(testPath, makeContents());

		const [, rawFs, source] = await sync.computeFileDirent(testPath, "tester");
		const fs = rawFs as FileSeafFs;
		const state: STATE_UPLOAD = {
			type: "upload",
			param: { progress: 0, fs: { ...fs, type: TYPE_FILE }, source: { ...source, mtime: source.mtime - 1 } },
		};

		await expect(callUploadFileObjects(sync, [state])).rejects.toThrow("changed while it was being synchronized");
		expect(uploadBlock).not.toHaveBeenCalled();
	});

	test("rechecks and retries blocks that were not stored after a successful response", async () => {
		const { adapter, sync, uploadBlock } = setup({ storeBlocksAfterAttempt: 2 });
		await adapter.writeBinary(testPath, makeContents());
		const [, rawFs, source] = await sync.computeFileDirent(testPath, "tester");
		const fs = rawFs as FileSeafFs;
		const state: STATE_UPLOAD = { type: "upload", param: { progress: 0, fs, source } };

		await callUploadFileObjects(sync, [state]);

		expect(uploadBlock).toHaveBeenCalledTimes(fs.block_ids.length * 2);
		expect(state.param.progress).toBe(1);
	});

	test("does not return success while uploaded blocks remain missing", async () => {
		const { adapter, sync, uploadBlock } = setup({ storeBlocksAfterAttempt: Number.POSITIVE_INFINITY });
		await adapter.writeBinary(testPath, makeContents());
		const [, rawFs, source] = await sync.computeFileDirent(testPath, "tester");
		const fs = rawFs as FileSeafFs;
		const state: STATE_UPLOAD = { type: "upload", param: { progress: 0, fs, source } };

		await expect(callUploadFileObjects(sync, [state])).rejects.toThrow("commit was not published");
		expect(uploadBlock).toHaveBeenCalledTimes(fs.block_ids.length * 2);
	});

	test("does not publish a commit while a filesystem object remains missing", async () => {
		const { adapter, sync, uploadCommit, setHeadCommit } = setup({ storeFs: false });
		await adapter.writeBinary(testPath, makeContents());
		const { root, changes } = await makeUploadTree(sync);

		await expect(sync.push(root, changes, "parent")).rejects.toThrow("filesystem object");
		expect(uploadCommit).not.toHaveBeenCalled();
		expect(setHeadCommit).not.toHaveBeenCalled();
	});

	test("detects when the server does not retain the published HEAD", async () => {
		const { adapter, sync, checkBlocksList, checkFsList, sendPackFs, uploadCommit, setHeadCommit } = setup({ publishedHead: "different-commit" });
		await adapter.writeBinary(testPath, makeContents());
		const { root, changes } = await makeUploadTree(sync);

		await expect(sync.push(root, changes, "parent")).rejects.toThrow("HEAD verification failed");
		expect(uploadCommit).toHaveBeenCalledTimes(1);
		expect(setHeadCommit).toHaveBeenCalledTimes(1);
		expect(checkBlocksList).toHaveBeenCalledTimes(2);
		expect(checkFsList).toHaveBeenCalledTimes(2);
		expect(sendPackFs).toHaveBeenCalledTimes(1);
		expect(sendPackFs.mock.calls[0][0]).toHaveLength(2);
	});

	test("does not accept a redirect as a successful block write", async () => {
		jest.spyOn(global, "fetch").mockResolvedValue(new Response("", { status: 302 }));
		const client = new Server(
			{ ...DEFAULT_SETTINGS, host: "https://example.test", repoId: "repo", repoToken: "token" },
			{ manifest: { version: "test" } } as never
		);

		await expect(client.uploadBlock("block", new ArrayBuffer(1))).rejects.toThrow("HTTP 302");
	});

	test("aborts a fetch upload that stops responding", async () => {
		Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
		jest.useFakeTimers();
		let requestSignal: AbortSignal | undefined;
		jest.spyOn(global, "fetch").mockImplementation(async (_input, init) => {
			requestSignal = init?.signal ?? undefined;
			return await new Promise<Response>((_resolve, reject) => {
				requestSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
			});
		});
		const client = new Server(
			{ ...DEFAULT_SETTINGS, host: "https://example.test", repoId: "repo", repoToken: "token", useFetch: true },
			{ manifest: { version: "test" } } as never
		);

		try {
			const rejection = expect(client.uploadBlock("block", new ArrayBuffer(1)))
				.rejects.toThrow("timed out after 120 seconds");
			await jest.advanceTimersByTimeAsync(120 * 1000);
			await rejection;
			expect(requestSignal?.aborted).toBe(true);
		} finally {
			delete (globalThis as { window?: unknown }).window;
		}
	});

	test("packs multiple filesystem objects into one request", async () => {
		Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
		const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(new Response("", { status: 200 }));
		const client = new Server(
			{ ...DEFAULT_SETTINGS, host: "https://example.test", repoId: "repo", repoToken: "token", useFetch: true },
			{ manifest: { version: "test" } } as never
		);
		const firstId = "a".repeat(40);
		const secondId = "b".repeat(40);
		const fs: FileSeafFs = { block_ids: ["block"], size: 1, type: TYPE_FILE, version: 1 };
		const preparationProgress: Array<[number, number]> = [];

		try {
			await client.sendPackFs([[firstId, fs], [secondId, fs]], (completed, total) => preparationProgress.push([completed, total]));

			const body = fetchMock.mock.calls[0][1]?.body as ArrayBuffer;
			const decoder = new TextDecoder();
			expect(decoder.decode(body.slice(0, 40))).toBe(firstId);
			const firstSize = new DataView(body, 40, 4).getUint32(0);
			const secondOffset = 44 + firstSize;
			expect(decoder.decode(body.slice(secondOffset, secondOffset + 40))).toBe(secondId);
			const secondSize = new DataView(body, secondOffset + 40, 4).getUint32(0);
			expect(secondOffset + 44 + secondSize).toBe(body.byteLength);
			expect(preparationProgress).toEqual([[2, 2]]);
		} finally {
			delete (globalThis as { window?: unknown }).window;
		}
	});

	test("checks and uploads filesystem-object batches concurrently", async () => {
		const { sync, getMaximumActiveFsChecks, getMaximumActiveFsUploads } = setup({ fsOperationDelayMs: 10 });
		const fs: FileSeafFs = { block_ids: ["block"], size: 1, type: TYPE_FILE, version: 1 };
		const nodes = Array.from({ length: 2501 }, (_, index) => ({
			path: `file-${index}.md`,
			next: { id: index.toString(16).padStart(40, "0") },
			state: { type: "upload", param: { progress: 0, fs } }
		}));
		const internal = sync as unknown as {
			uploadFilesystemObjects: (uploads: SyncNode[], onProgress: (progress: SyncProgress) => void) => Promise<void>
		};
		const progress: SyncProgress[] = [];

		await internal.uploadFilesystemObjects(nodes as unknown as SyncNode[], value => progress.push(value));

		expect(getMaximumActiveFsChecks()).toBe(3);
		expect(getMaximumActiveFsUploads()).toBe(4);
		expect(progress[0]).toEqual({ operation: "check-metadata", completedItems: 0, totalItems: nodes.length });
		expect(progress.some(value => value.operation === "prepare-metadata" && "completedItems" in value && value.completedItems > 0)).toBe(true);
		expect(progress.some(value => value.operation === "verify-metadata")).toBe(true);
		expect(progress[progress.length - 1]).toEqual({ operation: "publish-metadata", completedItems: nodes.length, totalItems: nodes.length });
	});
});
