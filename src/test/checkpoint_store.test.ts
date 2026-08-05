import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { LocalCheckpointStore } from "../history/checkpoint_store";
import type { SeafileSettings } from "../settings";

const pluginId = "checkpoint-store-test";
const root = `.obsidian/plugins/${pluginId}`;

function settings(): SeafileSettings {
	return {
		localHistoryEnabled: true,
		localHistoryIntervalMinutes: 1,
		localHistoryRetentionDays: 7,
		localHistoryMaxBytes: 1024 * 1024
	} as SeafileSettings;
}

beforeEach(async () => {
	Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
	await global.app.vault.adapter.mkdir(root);
});

afterEach(async () => {
	jest.useRealTimers();
	if (await global.app.vault.adapter.exists(root)) await global.app.vault.adapter.rmdir(root, true);
	if (await global.app.vault.adapter.exists("checkpoint-note.md")) await global.app.vault.adapter.remove("checkpoint-note.md");
});

describe("local checkpoint store", () => {
	test("deduplicates content and records the remote base for safe publication", async () => {
		await global.app.vault.adapter.write("checkpoint-note.md", "first");
		const store = new LocalCheckpointStore(
			{ vault: { configDir: ".obsidian" } } as never,
			global.app.vault.adapter,
			settings(),
			pluginId,
			() => "remote-a"
		);

		const first = await store.capture("checkpoint-note.md");
		const duplicate = await store.capture("checkpoint-note.md");
		expect(duplicate?.id).toBe(first?.id);
		expect(await store.list()).toHaveLength(1);
		expect(await store.getStorageBytes()).toBe(first?.size);

		await global.app.vault.adapter.write("checkpoint-note.md", "second");
		const second = await store.capture("checkpoint-note.md");
		expect(second?.baseRemoteHead).toBe("remote-a");
		expect(await store.list("checkpoint-note.md")).toHaveLength(2);
		expect(new TextDecoder().decode(await store.read(second!))).toBe("second");

		await store.markPublished(second!.id, "remote-b");
		expect((await store.list())[0].publishedCommitId).toBe("remote-b");
	});

	test("throttles continuous edits rather than postponing the checkpoint forever", async () => {
		jest.useFakeTimers();
		await global.app.vault.adapter.write("checkpoint-note.md", "draft");
		const store = new LocalCheckpointStore(
			{ vault: { configDir: ".obsidian" } } as never,
			global.app.vault.adapter,
			settings(),
			pluginId,
			() => "remote-a"
		);
		const capture = jest.spyOn(store, "capture").mockResolvedValue(null);
		store.schedule("checkpoint-note.md");
		store.schedule("checkpoint-note.md");

		await jest.advanceTimersByTimeAsync(60_000);
		expect(capture).toHaveBeenCalledTimes(1);
		expect(capture).toHaveBeenCalledWith("checkpoint-note.md");
		store.dispose();
	});
});
