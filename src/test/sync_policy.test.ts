import { describe, expect, test } from "@jest/globals";
import { DEFAULT_SETTINGS } from "../settings";
import { formatPluginSyncOverrides, ObsidianSyncPolicy, parsePluginSyncOverrides } from "../sync/policy";

function policy(overrides: Partial<typeof DEFAULT_SETTINGS> = {}): ObsidianSyncPolicy {
	return new ObsidianSyncPolicy(".obsidian", "seafile-improved", { ...DEFAULT_SETTINGS, ...overrides });
}

describe("Obsidian-aware synchronization policy", () => {
	test("protects runtime state and keeps workspace layouts local", () => {
		expect(policy().classify(".obsidian/plugins/seafile-improved/sync_data").transfer).toBe("protected");
		expect(policy().classify(".obsidian/workspace.json").transfer).toBe("device-local");
	});

	test("selects merge strategies from file semantics", () => {
		expect(policy().classify("Notes/example.md").merge).toBe("markdown");
		expect(policy().classify("Board.canvas").merge).toBe("structured-json");
		expect(policy().classify("Database.base").merge).toBe("structured-yaml");
		expect(policy().classify("calendar.ics").merge).toBe("text");
		expect(policy().classify("image.png").merge).toBe("conflict-copy");
	});

	test("syncs standard plugin files but excludes additional data by default", () => {
		const current = policy();
		expect(current.classify(".obsidian/plugins/example/main.js").transfer).toBe("sync");
		expect(current.classify(".obsidian/plugins/example/data.json").merge).toBe("json-object");
		expect(current.classify(".obsidian/plugins/example/cache/index.db").transfer).toBe("ignore");
	});

	test("supports conservative, complete, and excluded per-plugin overrides", () => {
		const current = policy({ pluginSyncOverrides: { one: "standard", two: "all", three: "ignore" } });
		expect(current.classify(".obsidian/plugins/one/cache.db").transfer).toBe("ignore");
		expect(current.classify(".obsidian/plugins/two/cache.db").transfer).toBe("sync");
		expect(current.classify(".obsidian/plugins/three/main.js").transfer).toBe("ignore");
	});

	test("parses and formats editable override rules", () => {
		const parsed = parsePluginSyncOverrides("# comment\nalpha=all\nbeta = standard\ngamma=ignore\n");
		expect(parsed).toEqual({ alpha: "all", beta: "standard", gamma: "ignore" });
		expect(formatPluginSyncOverrides(parsed)).toBe("alpha=all\nbeta=standard\ngamma=ignore");
		expect(() => parsePluginSyncOverrides("broken=sometimes")).toThrow("Invalid plugin override");
	});
});
