export type SyncStatusTextMode = "always" | "syncing" | "never"
export type HistoryGroupingMinutes = 0 | 1 | 5 | 15

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
	encrypted: false,
	encVersion: 0,
	repoSalt: "",
	repoMagic: "",
	randomKey: "",
};
