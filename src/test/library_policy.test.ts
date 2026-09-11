import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { initConfig } from "../config";
import { MODE_DIR, MODE_FILE, TYPE_FILE, type DirSeafFs, type FileSeafFs } from "../server";
import { DEFAULT_SETTINGS } from "../settings";
import { SyncController } from "../sync/controller";
import { applyLibrarySyncPolicy, createLibrarySyncPolicy, LIBRARY_POLICY_FILE, LibraryPolicyError, parseLibrarySyncPolicy, serializeLibrarySyncPolicy } from "../sync/library_policy";

afterEach(async () => {
	jest.restoreAllMocks();
	if (await global.app.vault.adapter.exists(LIBRARY_POLICY_FILE)) await global.app.vault.adapter.remove(LIBRARY_POLICY_FILE);
});

describe("library-wide synchronization policy", () => {
	test("round-trips a versioned policy without device-local settings", () => {
		const source = {
			...DEFAULT_SETTINGS,
			conflictResolution: "conflict-copy" as const,
			syncHotkeys: false,
			pluginSyncOverrides: { calendar: "all" as const }
		};
		const parsed = parseLibrarySyncPolicy(serializeLibrarySyncPolicy(createLibrarySyncPolicy(source)));

		expect(parsed).toMatchObject({ version: 1, syncHotkeys: false, pluginSyncOverrides: { calendar: "all" } });
		expect(parsed).not.toHaveProperty("conflictResolution");
		expect(parsed).not.toHaveProperty("deviceName");
	});

	test("applies only library-wide values to local settings", () => {
		const settings = { ...DEFAULT_SETTINGS, deviceName: "laptop", conflictResolution: "conflict-copy" as const };
		const policy = createLibrarySyncPolicy({ ...DEFAULT_SETTINGS, syncAppearance: false });

		expect(applyLibrarySyncPolicy(settings, policy)).toBe(true);
		expect(settings.syncAppearance).toBe(false);
		expect(settings.deviceName).toBe("laptop");
		expect(settings.conflictResolution).toBe("conflict-copy");
		expect(applyLibrarySyncPolicy(settings, policy)).toBe(false);
	});

	test("rejects malformed and future policy documents", () => {
		expect(() => parseLibrarySyncPolicy("not json")).toThrow(LibraryPolicyError);
		expect(() => parseLibrarySyncPolicy("not json")).toThrow(`${LIBRARY_POLICY_FILE} is not valid JSON`);
		expect(() => parseLibrarySyncPolicy("{\"version\":2}")).toThrow("unsupported policy version");
	});

	test("repairs an invalid local policy from current settings", async () => {
		const adapter = global.app.vault.adapter;
		await adapter.write(LIBRARY_POLICY_FILE, "invalid");
		const settings = { ...DEFAULT_SETTINGS, syncHotkeys: false };
		const sync = new SyncController(adapter, settings);

		await sync.replaceLibraryPolicyFile();

		expect(parseLibrarySyncPolicy(await adapter.read(LIBRARY_POLICY_FILE))).toMatchObject({ syncHotkeys: false });
	});

	test("validates an edited policy before replacing the local file", async () => {
		const adapter = global.app.vault.adapter;
		const original = serializeLibrarySyncPolicy(createLibrarySyncPolicy(DEFAULT_SETTINGS));
		await adapter.write(LIBRARY_POLICY_FILE, original);
		const sync = new SyncController(adapter, { ...DEFAULT_SETTINGS });

		await expect(sync.replaceLibraryPolicyFile("invalid")).rejects.toThrow(LibraryPolicyError);

		expect(await adapter.read(LIBRARY_POLICY_FILE)).toBe(original);
	});

	test("adopts an existing remote policy during first pairing", async () => {
		const remoteContents = serializeLibrarySyncPolicy(createLibrarySyncPolicy({ ...DEFAULT_SETTINGS, syncHotkeys: false }));
		const bytes = new TextEncoder().encode(remoteContents);
		const rootFs: DirSeafFs = {
			type: 3,
			version: 1,
			dirents: [{
				id: "policy-fs", mode: MODE_FILE, modifier: "owner", mtime: 1700000000,
				name: LIBRARY_POLICY_FILE, size: bytes.byteLength
			}]
		};
		const policyFs: FileSeafFs = { type: TYPE_FILE, version: 1, block_ids: ["policy-block"], size: bytes.byteLength };
		const adapter = global.app.vault.adapter;
		const fakeServer = {
			getFs: async (id: string) => id === "root-fs" ? [id, rootFs] : [id, policyFs],
			getBlock: async () => bytes.buffer
		};
		const fakeApp = { vault: { configDir: ".obsidian", adapter, getAbstractFileByPath: () => null } };
		const settings = { ...DEFAULT_SETTINGS, syncHotkeys: true };
		initConfig(fakeApp as never, fakeServer as never, "seafile-improved", settings);
		const sync = new SyncController(adapter, settings);
		const policyChanged = jest.fn(async () => {});
		sync.onLibraryPolicyChanged = policyChanged;

		await (sync as unknown as {
			bootstrapLibraryPolicyFile: (root: { id: string, mode: number, mtime: number, name: string }) => Promise<void>
		}).bootstrapLibraryPolicyFile({ id: "root-fs", mode: MODE_DIR, mtime: 1700000000, name: "" });

		expect(settings.syncHotkeys).toBe(false);
		expect(await adapter.read(LIBRARY_POLICY_FILE)).toBe(remoteContents);
		expect(policyChanged).toHaveBeenCalledTimes(1);
	});
});
