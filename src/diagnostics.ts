import type { NotificationStatus } from "./notification";
import type { SeafileSettings } from "./settings";
import type { SyncStatus } from "./sync/controller";
import type { SyncIssue } from "./sync/issues";

export interface DiagnosticsContext {
	pluginVersion: string
	obsidianVersion: string
	platform: { desktop: boolean, mobile: boolean }
	settings: SeafileSettings
	syncStatus: SyncStatus
	notificationStatus: NotificationStatus
	knownRemoteHead: string
	locallySynchronized: boolean
	issues: SyncIssue[]
}

export function createDiagnosticsReport(context: DiagnosticsContext): Record<string, unknown> {
	const { settings } = context;
	const openIssues = context.issues.filter(issue => !issue.resolved);
	return {
		format: "obsidian-seafile-sync-diagnostics",
		version: 1,
		generatedAt: new Date().toISOString(),
		application: {
			pluginVersion: context.pluginVersion,
			obsidianVersion: context.obsidianVersion,
			platform: context.platform
		},
		connection: {
			serverConfigured: settings.host.length > 0,
			accountConfigured: settings.account.length > 0,
			repositorySelected: settings.repoId.length > 0,
			repositoryPermission: settings.repoPermission || "unknown",
			encryptedRepository: settings.encrypted,
			encryptionVersion: settings.encrypted ? settings.encVersion : 0,
			fetchTransport: settings.useFetch
		},
		synchronization: {
			enabled: settings.enableSync,
			status: context.syncStatus.type,
			stopReason: context.syncStatus.type === "stop" ? context.syncStatus.message ?? "unspecified" : null,
			hasRetryError: context.syncStatus.type === "idle" && !!context.syncStatus.error,
			intervalSeconds: Math.floor(settings.interval / 1000),
			knownRemoteHead: context.knownRemoteHead.length > 0,
			locallySynchronized: context.locallySynchronized
		},
		realtime: {
			enabled: settings.enableNotifications,
			status: context.notificationStatus.type,
			customUrlConfigured: settings.notificationUrl.length > 0
		},
		libraryPolicy: {
			syncMainSettings: settings.syncMainSettings,
			syncAppearance: settings.syncAppearance,
			syncHotkeys: settings.syncHotkeys,
			syncCorePluginSettings: settings.syncCorePluginSettings,
			syncCommunityPluginList: settings.syncCommunityPluginList,
			syncCommunityPluginInstallations: settings.syncCommunityPluginInstallations,
			syncCommunityPluginSettings: settings.syncCommunityPluginSettings,
			syncAdditionalPluginData: settings.syncAdditionalPluginData,
			pluginOverrides: countValues(settings.pluginSyncOverrides)
		},
		conflicts: {
			resolutionMode: settings.conflictResolution
		},
		localHistory: {
			enabled: settings.localHistoryEnabled,
			intervalMinutes: settings.localHistoryIntervalMinutes,
			retentionDays: settings.localHistoryRetentionDays,
			maxMiB: Math.round(settings.localHistoryMaxBytes / (1024 * 1024))
		},
		deletionProtection: {
			enabled: settings.deletionProtectionEnabled,
			fileThreshold: settings.deletionProtectionFileThreshold,
			percentThreshold: settings.deletionProtectionPercentThreshold,
			percentMinimumFiles: settings.deletionProtectionPercentMinimumFiles
		},
		issues: {
			total: context.issues.length,
			open: openIssues.length,
			openByKind: countValues(Object.fromEntries(openIssues.map((issue, index) => [String(index), issue.kind])))
		}
	};
}

function countValues(values: Record<string, string>): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of Object.values(values)) counts[value] = (counts[value] ?? 0) + 1;
	return counts;
}
