import type { PluginSyncMode, SeafileSettings } from "../settings";

export const LIBRARY_POLICY_FILE = ".obsidian-seafile-sync.json";
export const LIBRARY_POLICY_VERSION = 1;

export class LibraryPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LibraryPolicyError";
	}
}

const POLICY_KEYS = [
	"syncMainSettings",
	"syncAppearance",
	"syncHotkeys",
	"syncCorePluginSettings",
	"syncCommunityPluginList",
	"syncCommunityPluginInstallations",
	"syncCommunityPluginSettings",
	"syncAdditionalPluginData"
] as const;

type BooleanPolicyKey = typeof POLICY_KEYS[number];

export interface LibrarySyncPolicy extends Pick<SeafileSettings, BooleanPolicyKey> {
	version: typeof LIBRARY_POLICY_VERSION
	pluginSyncOverrides: Record<string, PluginSyncMode>
}

export function createLibrarySyncPolicy(settings: SeafileSettings): LibrarySyncPolicy {
	return {
		version: LIBRARY_POLICY_VERSION,
		...(Object.fromEntries(POLICY_KEYS.map(key => [key, settings[key]])) as Pick<SeafileSettings, BooleanPolicyKey>),
		pluginSyncOverrides: { ...settings.pluginSyncOverrides }
	};
}

export function serializeLibrarySyncPolicy(policy: LibrarySyncPolicy): string {
	return `${JSON.stringify(policy, null, "\t")}\n`;
}

export function parseLibrarySyncPolicy(contents: string): LibrarySyncPolicy {
	let value: unknown;
	try {
		value = JSON.parse(contents) as unknown;
	} catch {
		throw new LibraryPolicyError(`${LIBRARY_POLICY_FILE} is not valid JSON.`);
	}
	if (!isRecord(value) || value.version !== LIBRARY_POLICY_VERSION) {
		throw new LibraryPolicyError(`${LIBRARY_POLICY_FILE} uses an unsupported policy version.`);
	}
	for (const key of POLICY_KEYS) {
		if (typeof value[key] !== "boolean") throw new LibraryPolicyError(`${LIBRARY_POLICY_FILE} has an invalid '${key}' value.`);
	}
	if (!isRecord(value.pluginSyncOverrides)) throw new LibraryPolicyError(`${LIBRARY_POLICY_FILE} has invalid plugin overrides.`);
	const pluginSyncOverrides: Record<string, PluginSyncMode> = {};
	for (const [pluginId, mode] of Object.entries(value.pluginSyncOverrides)) {
		if (!/^[a-z0-9][a-z0-9_-]*$/i.test(pluginId) || !isPluginSyncMode(mode)) {
			throw new LibraryPolicyError(`${LIBRARY_POLICY_FILE} has an invalid override for '${pluginId}'.`);
		}
		if (mode !== "default") pluginSyncOverrides[pluginId] = mode;
	}
	return {
		version: LIBRARY_POLICY_VERSION,
		...(Object.fromEntries(POLICY_KEYS.map(key => [key, value[key]])) as Pick<SeafileSettings, BooleanPolicyKey>),
		pluginSyncOverrides
	};
}

export function applyLibrarySyncPolicy(settings: SeafileSettings, policy: LibrarySyncPolicy): boolean {
	let changed = false;
	for (const key of POLICY_KEYS) {
		if (settings[key] === policy[key]) continue;
		settings[key] = policy[key];
		changed = true;
	}
	const nextOverrides = JSON.stringify(policy.pluginSyncOverrides);
	if (JSON.stringify(settings.pluginSyncOverrides) !== nextOverrides) {
		settings.pluginSyncOverrides = { ...policy.pluginSyncOverrides };
		changed = true;
	}
	return changed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPluginSyncMode(value: unknown): value is PluginSyncMode {
	return typeof value === "string" && ["default", "standard", "all", "ignore"].includes(value);
}
