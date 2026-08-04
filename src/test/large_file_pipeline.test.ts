import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { rm } from "fs/promises";
import { initConfig } from "../config";
import { TYPE_FILE, type FileSeafFs } from "../server";
import { SyncController } from "../sync/controller";
import type { STATE_UPLOAD, SyncNode } from "../sync/node";
import { SEAFILE_BLOCK_SIZE } from "../utils";

const testPath = "large-file-pipeline.bin";

function makeContents(): ArrayBuffer {
	const bytes = new Uint8Array(SEAFILE_BLOCK_SIZE * 2 + 17);
	bytes.fill(0x11, 0, SEAFILE_BLOCK_SIZE);
	bytes.fill(0x22, SEAFILE_BLOCK_SIZE, SEAFILE_BLOCK_SIZE * 2);
	bytes.fill(0x33, SEAFILE_BLOCK_SIZE * 2);
	return bytes.buffer;
}

function setup() {
	const adapter = global.app.vault.adapter;
	let activeUploads = 0;
	let maximumActiveUploads = 0;
	const uploadedIds: string[] = [];
	const checkBlocksList = jest.fn(async (ids: string[]) => new Map(ids.map(id => [id, true])));
	const uploadBlock = jest.fn(async (id: string) => {
		activeUploads++;
		maximumActiveUploads = Math.max(maximumActiveUploads, activeUploads);
		await new Promise(resolve => setTimeout(resolve, 5));
		uploadedIds.push(id);
		activeUploads--;
	});
	const fakeServer = {
		crypto: null,
		checkBlocksList,
		uploadBlock,
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
	return { adapter, sync, checkBlocksList, uploadBlock, uploadedIds, getMaximumActiveUploads: () => maximumActiveUploads };
}

function callUploadFileBlocks(sync: SyncController, state: STATE_UPLOAD): Promise<void> {
	const internal = sync as unknown as {
		uploadFileBlocks: (node: SyncNode, uploadState: STATE_UPLOAD) => Promise<void>
	};
	return internal.uploadFileBlocks({} as SyncNode, state);
}

afterEach(async () => {
	if (await global.app.vault.adapter.exists(testPath)) {
		await rm((global.app.vault.adapter as unknown as { getFullPath: (path: string) => string }).getFullPath(testPath));
	}
});

beforeEach(async () => {
	await global.app.vault.adapter.mkdir("");
});

describe("bounded large-file upload pipeline", () => {
	test("reads desktop files in ranges and uploads missing blocks with bounded concurrency", async () => {
		const { adapter, sync, checkBlocksList, uploadedIds, getMaximumActiveUploads } = setup();
		await adapter.writeBinary(testPath, makeContents());
		const readBinary = jest.spyOn(adapter, "readBinary");

		const [, rawFs, source] = await sync.computeFileDirent(testPath, "tester");
		const fs = rawFs as FileSeafFs;
		expect(fs.block_ids).toHaveLength(3);
		expect(readBinary).not.toHaveBeenCalled();

		const state: STATE_UPLOAD = { type: "upload", param: { progress: 0, fs, source } };
		await callUploadFileBlocks(sync, state);

		expect(checkBlocksList).toHaveBeenCalledTimes(1);
		expect(checkBlocksList).toHaveBeenCalledWith(fs.block_ids);
		expect(uploadedIds).toEqual(expect.arrayContaining(fs.block_ids));
		expect(uploadedIds).toHaveLength(fs.block_ids.length);
		expect(getMaximumActiveUploads()).toBeGreaterThan(0);
		expect(getMaximumActiveUploads()).toBeLessThanOrEqual(2);
		expect(state.param.progress).toBe(1);
		expect(readBinary).not.toHaveBeenCalled();
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

		await expect(callUploadFileBlocks(sync, state)).rejects.toThrow("changed while it was being synchronized");
		expect(uploadBlock).not.toHaveBeenCalled();
	});
});
