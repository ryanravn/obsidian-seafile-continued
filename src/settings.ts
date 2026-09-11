export type SyncStatusTextMode = "always" | "syncing" | "never"
export type HistoryGroupingMinutes = 0 | 1 | 5 | 15
export type ConflictResolutionMode = "smart-merge" | "conflict-copy"
export type PluginSyncMode = "default" | "standard" | "all" | "ignore"

export interface SeafileSettings {
  host: string
  account: string
  authToken: string
  repoName: string
  repoId: string
  repoToken: string
  deviceName: string
  deviceId: string
  interval: number
  devMode: boolean
  enableSync: boolean
  useFetch: boolean
  enableNotifications: boolean
  notificationUrl: string
	syncStatusTextMode: SyncStatusTextMode
	historyGroupingMinutes: HistoryGroupingMinutes
	localHistoryEnabled: boolean
	localHistoryIntervalMinutes: number
	localHistoryRetentionDays: number
	localHistoryMaxBytes: number
	lastSnapshotUndoCommit: string
	deletionProtectionEnabled: boolean
	deletionProtectionFileThreshold: number
	deletionProtectionPercentThreshold: number
	deletionProtectionPercentMinimumFiles: number
	repoPermission: string
	conflictResolution: ConflictResolutionMode
	syncMainSettings: boolean
	syncAppearance: boolean
	syncHotkeys: boolean
	syncCorePluginSettings: boolean
	syncCommunityPluginList: boolean
	syncCommunityPluginInstallations: boolean
	syncCommunityPluginSettings: boolean
	syncAdditionalPluginData: boolean
	pluginSyncOverrides: Record<string, PluginSyncMode>

  // Encryption metadata (public, server-supplied). Password is never persisted.
  encrypted: boolean
  encVersion: number
  repoSalt: string
  repoMagic: string
  randomKey: string
}

export const DEFAULT_SETTINGS: SeafileSettings = {
	host: "",
	account: "",
	authToken: "",
	repoName: "",
	repoId: "",
	repoToken: "",
	deviceName: "obsidian-seafile",
	deviceId: "",
	interval: 30000,
	devMode: false,
	enableSync: false,
	useFetch: false,
	enableNotifications: true,
	notificationUrl: "",
	syncStatusTextMode: "syncing",
	historyGroupingMinutes: 5,
	localHistoryEnabled: false,
	localHistoryIntervalMinutes: 5,
	localHistoryRetentionDays: 7,
	localHistoryMaxBytes: 250 * 1024 * 1024,
	lastSnapshotUndoCommit: "",
	deletionProtectionEnabled: true,
	deletionProtectionFileThreshold: 500,
	deletionProtectionPercentThreshold: 25,
	deletionProtectionPercentMinimumFiles: 20,
	repoPermission: "",
	conflictResolution: "smart-merge",
	syncMainSettings: true,
	syncAppearance: true,
	syncHotkeys: true,
	syncCorePluginSettings: true,
	syncCommunityPluginList: true,
	syncCommunityPluginInstallations: true,
	syncCommunityPluginSettings: true,
	syncAdditionalPluginData: false,
	pluginSyncOverrides: {},
	encrypted: false,
	encVersion: 0,
	repoSalt: "",
	repoMagic: "",
	randomKey: "",
};
