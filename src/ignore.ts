import { LIBRARY_POLICY_FILE } from "./sync/library_policy";

export const SEAFILE_IGNORE_FILE = "seafile-ignore.txt";
export const MANAGED_IGNORE_START = "# BEGIN Obsidian Seafile Sync managed defaults";
export const MANAGED_IGNORE_END = "# END Obsidian Seafile Sync managed defaults";
const LEGACY_MANAGED_IGNORE_START = "# BEGIN Seafile Improved managed defaults";
const LEGACY_MANAGED_IGNORE_END = "# END Seafile Improved managed defaults";

export interface ManagedIgnoreSettings {
	syncMainSettings: boolean
	syncAppearance: boolean
	syncHotkeys: boolean
	syncCorePluginSettings: boolean
	syncCommunityPluginList: boolean
	syncCommunityPluginInstallations: boolean
	syncCommunityPluginSettings: boolean
	pluginSyncOverrides: Record<string, string>
}

export interface IgnoreList {
	denies: (path: string, isDirectory?: boolean) => boolean
}

function normalizePath(path: string): string {
	while (path.startsWith("/")) path = path.slice(1);
	while (path.endsWith("/")) path = path.slice(0, -1);
	return path;
}

function patternRegex(pattern: string): RegExp {
	let source = "";
	for (const character of pattern) {
		if (character === "*") source += ".*";
		else if (character === "?") source += ".";
		else source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

/** Compile the pattern format used by Seafile's root seafile-ignore.txt file. */
export function compileIgnoreList (contents: string): IgnoreList {
	const patterns = contents
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith("#"))
		.map(rawPattern => {
			let pattern = rawPattern;
			while (pattern.startsWith("/")) pattern = pattern.slice(1);
			const directoryOnly = pattern.endsWith("/");
			if (directoryOnly) pattern = pattern.slice(0, -1);
			const matchesDirectory = directoryOnly || pattern.endsWith("*") || pattern.endsWith("?");
			return { directoryOnly, matchesDirectory, regex: patternRegex(pattern) };
		});

	return {
		denies: (rawPath: string, isDirectory = false): boolean => {
			const path = normalizePath(rawPath);
			if (!path || path === SEAFILE_IGNORE_FILE || path === LIBRARY_POLICY_FILE) return false;
			return patterns.some(({ directoryOnly, matchesDirectory, regex }) => {
				if (matchesDirectory) {
					const parts = path.split("/");
					const directoryCount = isDirectory ? parts.length : parts.length - 1;
					for (let length = 1; length <= directoryCount; length++) {
						if (regex.test(parts.slice(0, length).join("/"))) return true;
					}
				}
				if (directoryOnly || isDirectory) return false;
				return regex.test(path);
			});
		}
	};
}

export function createManagedIgnoreBlock(configDir: string, pluginId: string, settings?: ManagedIgnoreSettings): string {
	const rules = [
		"# Git and editor project state",
		".git/",
		"*/.git/",
		".idea/",
		"*/.idea/",
		".vscode/",
		"*/.vscode/",
		"",
		"# Device-specific Obsidian workspace state",
		`${configDir}/workspace.json`,
		`${configDir}/workspace-mobile.json`,
		"",
		"# Obsidian Seafile Sync installation and device state",
		`${configDir}/plugins/${pluginId}/`
	];
	if (settings) {
		const pluginOverrideModes = Object.values(settings.pluginSyncOverrides);
		const hasStandardPluginOverride = pluginOverrideModes.some(mode => mode === "standard" || mode === "all");
		if (!settings.syncMainSettings) rules.push(`${configDir}/app.json`);
		if (!settings.syncAppearance) rules.push(`${configDir}/appearance.json`, `${configDir}/themes/`, `${configDir}/snippets/`);
		if (!settings.syncHotkeys) rules.push(`${configDir}/hotkeys.json`);
		if (!settings.syncCorePluginSettings) rules.push(`${configDir}/core-plugins.json`);
		if (!settings.syncCommunityPluginList) rules.push(`${configDir}/community-plugins.json`);
		if (!settings.syncCommunityPluginInstallations && !hasStandardPluginOverride) {
			rules.push(`${configDir}/plugins/*/main.js`, `${configDir}/plugins/*/manifest.json`, `${configDir}/plugins/*/styles.css`);
		}
		if (!settings.syncCommunityPluginSettings && !hasStandardPluginOverride) rules.push(`${configDir}/plugins/*/data.json`);
		for (const [overridePluginId, mode] of Object.entries(settings.pluginSyncOverrides).sort(([left], [right]) => left.localeCompare(right))) {
			if (mode === "ignore" && overridePluginId !== pluginId) rules.push(`${configDir}/plugins/${overridePluginId}/`);
		}
	}
	return `${MANAGED_IGNORE_START}\n${rules.join("\n")}\n${MANAGED_IGNORE_END}`;
}

export function replaceManagedIgnoreBlock(
	contents: string,
	configDir: string,
	pluginId: string,
	settings: ManagedIgnoreSettings
): string | null {
	let start = contents.indexOf(MANAGED_IGNORE_START);
	let end = contents.indexOf(MANAGED_IGNORE_END);
	let endMarker = MANAGED_IGNORE_END;
	if (start < 0 || end < start) {
		start = contents.indexOf(LEGACY_MANAGED_IGNORE_START);
		end = contents.indexOf(LEGACY_MANAGED_IGNORE_END);
		endMarker = LEGACY_MANAGED_IGNORE_END;
	}
	if (start < 0 || end < start) return null;
	const after = end + endMarker.length;
	return `${contents.slice(0, start)}${createManagedIgnoreBlock(configDir, pluginId, settings)}${contents.slice(after)}`;
}

function legacyDefaultIgnoreBlock(configDir: string, pluginId: string, newline: string): string {
	return [
		"# Git repositories",
		".git/",
		"*/.git/",
		"",
		"# Device-specific Obsidian workspace state",
		`${configDir}/workspace.json`,
		`${configDir}/workspace-mobile.json`,
		"",
		"# Seafile Sync plugin installation and device state",
		`${configDir}/plugins/${pluginId}/`,
		""
	].join(newline);
}

function removeLegacyDefaultIgnoreBlock(contents: string, configDir: string, pluginId: string): string {
	let updated = contents;
	const legacyPluginIds = new Set([pluginId, "seafile-continued", "seafile-improved"]);
	for (const legacyPluginId of legacyPluginIds) {
		for (const newline of ["\n", "\r\n"]) {
			const legacy = legacyDefaultIgnoreBlock(configDir, legacyPluginId, newline);
			updated = updated.replace(legacy, "");
		}
	}
	return updated;
}

export function upsertManagedIgnoreBlock(
	contents: string,
	configDir: string,
	pluginId: string,
	settings: ManagedIgnoreSettings
): string {
	const migratedContents = removeLegacyDefaultIgnoreBlock(contents, configDir, pluginId);
	const updated = replaceManagedIgnoreBlock(migratedContents, configDir, pluginId, settings);
	if (updated !== null) return updated;
	return `${createManagedIgnoreBlock(configDir, pluginId, settings)}\n\n${migratedContents}`;
}

export function createDefaultIgnoreFile(configDir: string, pluginId: string, settings?: ManagedIgnoreSettings): string {
	return `${createManagedIgnoreBlock(configDir, pluginId, settings)}\n\n# Add your own Seafile ignore patterns below this line.\n`;
}
