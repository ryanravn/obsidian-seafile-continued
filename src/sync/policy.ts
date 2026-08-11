import type { SeafileSettings, PluginSyncMode } from "../settings";
import type { MergeStrategyName } from "./merge";

export type TransferPolicy = "sync" | "ignore" | "device-local" | "protected";

export interface SyncClassification {
	transfer: TransferPolicy
	merge: MergeStrategyName
	reason: string
}

type PolicySettings = Pick<SeafileSettings,
	"conflictResolution"
	| "syncMainSettings"
	| "syncAppearance"
	| "syncHotkeys"
	| "syncCorePluginSettings"
	| "syncCommunityPluginList"
	| "syncCommunityPluginInstallations"
	| "syncCommunityPluginSettings"
	| "syncAdditionalPluginData"
	| "pluginSyncOverrides"
>;

const TEXT_FILE_PATTERN = /\.(?:base|conf|css|csv|env|html?|ics|ini|jsonc|jsonl|jsx?|log|mermaid|properties|sql|text|toml|tsx?|txt|vcf|xml|ya?ml)$/i;

export class ObsidianSyncPolicy {
	private readonly configDir: string;
	private readonly pluginRoot: string;
	private readonly protectedPluginDir: string;

	private settings: PolicySettings;

	constructor(configDir: string, pluginId: string, settings: PolicySettings) {
		this.configDir = normalize(configDir);
		this.pluginRoot = `${this.configDir}/plugins`;
		this.protectedPluginDir = `${this.pluginRoot}/${pluginId}`;
		this.settings = copySettings(settings);
	}

	update(settings: PolicySettings): void {
		this.settings = copySettings(settings);
	}

	classify(rawPath: string, isDirectory = false): SyncClassification {
		const path = normalize(rawPath);
		if (path === this.protectedPluginDir || path.startsWith(`${this.protectedPluginDir}/`)) {
			return classification("protected", "conflict-copy", "Seafile Improved keeps its operational state device-local.");
		}
		if (path === `${this.configDir}/workspace.json` || path === `${this.configDir}/workspace-mobile.json`) {
			return classification("device-local", "json-object", "Workspace layout is device-specific.");
		}
		if (path === this.configDir || !path.startsWith(`${this.configDir}/`)) {
			return classification("sync", this.mergeStrategy(path), "Vault content is synchronized.");
		}

		const relative = path.slice(this.configDir.length + 1);
		if (relative === "app.json") return this.settingFile(this.settings.syncMainSettings !== false, path, "Main Obsidian settings");
		if (relative === "appearance.json" || relative === "themes" || relative.startsWith("themes/")
			|| relative === "snippets" || relative.startsWith("snippets/")) {
			return this.settingFile(this.settings.syncAppearance !== false, path, "Appearance, themes, and snippets");
		}
		if (relative === "hotkeys.json") return this.settingFile(this.settings.syncHotkeys !== false, path, "Hotkeys");
		if (relative === "core-plugins.json") return this.settingFile(this.settings.syncCorePluginSettings !== false, path, "Core plugin configuration");
		if (relative === "community-plugins.json") {
			return this.settingFile(this.settings.syncCommunityPluginList !== false, path, "Active community plugin list");
		}
		if (path === this.pluginRoot) return classification("sync", "conflict-copy", "Community plugin container.");
		if (path.startsWith(`${this.pluginRoot}/`)) return this.classifyPluginPath(path, isDirectory);
		if (relative.endsWith(".json")) {
			return this.settingFile(this.settings.syncCorePluginSettings !== false, path, "Core plugin or Obsidian configuration");
		}
		return this.settingFile(this.settings.syncMainSettings !== false, path, "Obsidian configuration");
	}

	private classifyPluginPath(path: string, isDirectory: boolean): SyncClassification {
		const relative = path.slice(this.pluginRoot.length + 1);
		const [pluginId, ...parts] = relative.split("/");
		const override = this.settings.pluginSyncOverrides?.[pluginId] ?? "default";
		if (override === "ignore") return classification("ignore", "conflict-copy", `Plugin '${pluginId}' is excluded by its override.`);
		if (parts.length === 0 || isDirectory && parts.length === 1) {
			return classification("sync", "conflict-copy", `Plugin '${pluginId}' container.`);
		}
		if (override === "all") return classification("sync", this.mergeStrategy(path), `All data for plugin '${pluginId}' is synchronized.`);

		const childPath = parts.join("/");
		const isInstallation = parts.length === 1 && ["main.js", "manifest.json", "styles.css"].includes(childPath);
		const isSettings = parts.length === 1 && childPath === "data.json";
		const standardOverride = override === "standard";
		if (isInstallation) {
			return this.settingFile(standardOverride || this.settings.syncCommunityPluginInstallations !== false, path, `Installation file for plugin '${pluginId}'`);
		}
		if (isSettings) {
			return this.settingFile(standardOverride || this.settings.syncCommunityPluginSettings !== false, path, `Settings for plugin '${pluginId}'`);
		}
		return this.settingFile(!standardOverride && this.settings.syncAdditionalPluginData !== false, path, `Additional data for plugin '${pluginId}'`);
	}

	private settingFile(enabled: boolean, path: string, label: string): SyncClassification {
		return enabled
			? classification("sync", this.mergeStrategy(path), `${label} are synchronized.`)
			: classification("ignore", this.mergeStrategy(path), `${label} are disabled in Obsidian-aware sync settings.`);
	}

	private mergeStrategy(path: string): MergeStrategyName {
		if (this.settings.conflictResolution === "conflict-copy") return "conflict-copy";
		if (/\.(?:md|markdown)$/i.test(path)) return "markdown";
		if (/\.canvas$/i.test(path)) return "structured-json";
		if (/\.base$/i.test(path)) return "structured-yaml";
		if (/\.json$/i.test(path)) return "json-object";
		if (TEXT_FILE_PATTERN.test(path)) return "text";
		return "conflict-copy";
	}
}

function classification(transfer: TransferPolicy, merge: MergeStrategyName, reason: string): SyncClassification {
	return { transfer, merge, reason };
}

function normalize(path: string): string {
	return path.replace(/^\/+|\/+$/g, "");
}

function copySettings(settings: PolicySettings): PolicySettings {
	return { ...settings, pluginSyncOverrides: { ...(settings.pluginSyncOverrides ?? {}) } };
}

export function parsePluginSyncOverrides(value: string): Record<string, PluginSyncMode> {
	const result: Record<string, PluginSyncMode> = {};
	for (const rawLine of value.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator < 1) throw new Error(`Invalid plugin override '${line}'. Use plugin-id=standard, all, or ignore.`);
		const pluginId = line.slice(0, separator).trim();
		const mode = line.slice(separator + 1).trim();
		if (!/^[a-z0-9][a-z0-9_-]*$/i.test(pluginId) || !isPluginSyncMode(mode) || mode === "default") {
			throw new Error(`Invalid plugin override '${line}'. Use plugin-id=standard, all, or ignore.`);
		}
		result[pluginId] = mode;
	}
	return result;
}

export function formatPluginSyncOverrides(overrides: Record<string, PluginSyncMode>): string {
	return Object.entries(overrides)
		.filter(([, mode]) => mode !== "default")
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([pluginId, mode]) => `${pluginId}=${mode}`)
		.join("\n");
}

function isPluginSyncMode(value: string): value is PluginSyncMode {
	return ["default", "standard", "all", "ignore"].includes(value);
}
