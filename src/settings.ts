export type SyncStatusTextMode = "always" | "syncing" | "never"

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
	encrypted: false,
	encVersion: 0,
	repoSalt: "",
	repoMagic: "",
	randomKey: "",
};
