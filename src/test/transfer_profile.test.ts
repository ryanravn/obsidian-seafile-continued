import { describe, expect, test } from "@jest/globals";
import { getTransferProfile } from "../sync/transfer_profile";
import { FailableSlotPool, SlotPool } from "../sync/work_pool";

describe("platform transfer profiles", () => {
	test("keeps mobile preparation serial and memory cache disabled", () => {
		expect(getTransferProfile(true)).toEqual({
			filePreparationConcurrency: 1,
			downloadPrefetch: 2,
			blockUploadConcurrency: 2,
			preparedBlockCacheBytes: 0
		});
	});

	test("uses bounded desktop parallelism and cache memory", () => {
		expect(getTransferProfile(false)).toEqual({
			filePreparationConcurrency: 4,
			downloadPrefetch: 4,
			blockUploadConcurrency: 4,
			preparedBlockCacheBytes: 32 * 1024 * 1024
		});
	});
});

describe("bounded sync worker pools", () => {
	test("does not admit a waiter until an active slot is released", async () => {
		const pool = new SlotPool(1);
		const first = await pool.acquire();
		let admitted = false;
		const waiting = pool.acquire().then(release => { admitted = true; return release; });
		await Promise.resolve();
		expect(admitted).toBe(false);
		first();
		const second = await waiting;
		expect(admitted).toBe(true);
		second();
	});

	test("rejects queued and future uploads after the first failure", async () => {
		const pool = new FailableSlotPool(1);
		const first = await pool.acquire();
		const waiting = pool.acquire();
		const failure = new Error("upload failed");
		pool.fail(failure);
		await expect(waiting).rejects.toBe(failure);
		await expect(pool.acquire()).rejects.toBe(failure);
		first();
	});
});
