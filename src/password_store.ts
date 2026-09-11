// Optional per-device password persistence for encrypted repos. New values use
// Obsidian SecretStorage. The Electron safeStorage and app-local implementations
// remain only to migrate passwords saved by earlier plugin versions; migrated
// values are removed from the legacy backend.

import { App, Platform } from "obsidian";

const STORAGE_PREFIX = "seafile-continued-pw:";

type StoredPassword = { kind: "safe" | "plain"; value: string };

// Obsidian's loadLocalStorage() is typed `any | null`, so narrow it through a
// real type guard instead of a bare `as` cast on an `any` value.
function isStoredPassword (value: unknown): value is StoredPassword {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (v.kind === "safe" || v.kind === "plain") && typeof v.value === "string";
}

export type StoreBackend = "secret-storage" | "safe-storage" | "local-storage";

// Minimal Buffer-like shape needed here. Deliberately not importing Node's
// "buffer" module or referencing the global `Buffer` identifier: Obsidian
// plugin guidelines disallow Node builtins, and this whole code path is
// desktop-only already (gated by Platform.isMobile in getSafeStorage()).
interface NodeBuffer {
	toString(encoding: string): string;
}

// Electron exposes Buffer on the renderer's `window`; typed by hand for the
// same reason as NodeBuffer above, rather than relying on ambient Node types.
interface WindowBuffer {
	from(data: string, encoding: string): NodeBuffer;
}

// Minimal shape of Electron's safeStorage we rely on.
interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): NodeBuffer;
  decryptString(encrypted: NodeBuffer): string;
}

export interface PasswordStore {
  readonly backend: StoreBackend
  readonly description: string
  save: (repoId: string, password: string) => Promise<void>
  load: (repoId: string) => Promise<string | null>
  clear: (repoId: string) => Promise<void>
}

function getSafeStorage (): SafeStorage | null {
	if (Platform.isMobile) return null;
	try {
		const req = (window as unknown as { require?: (module: string) => unknown }).require;
		if (typeof req !== "function") return null;
		const electron = req("electron") as {
			safeStorage?: SafeStorage;
			remote?: { safeStorage?: SafeStorage };
		};
		const safe = electron?.safeStorage ?? electron?.remote?.safeStorage;
		if (safe && typeof safe.isEncryptionAvailable === "function" && safe.isEncryptionAvailable()) {
			return safe;
		}
	} catch {
		// ignore: fall through to vault-local storage
	}
	return null;
}

class SafeStoragePasswordStore implements PasswordStore {
	readonly backend = "safe-storage" as const;
	readonly description = "Encrypted with your OS keychain. Only your device user can decrypt.";

	constructor (private readonly app: App, private readonly safe: SafeStorage) {}

	async save (repoId: string, password: string): Promise<void> {
		const buf = this.safe.encryptString(password);
		const entry: StoredPassword = { kind: "safe", value: buf.toString("base64") };
		this.app.saveLocalStorage(STORAGE_PREFIX + repoId, entry);
	}

	async load (repoId: string): Promise<string | null> {
		const raw: unknown = this.app.loadLocalStorage(STORAGE_PREFIX + repoId);
		if (!isStoredPassword(raw) || raw.kind !== "safe") return null;
		try {
			const bufferCtor = (window as unknown as { Buffer: WindowBuffer }).Buffer;
			const buf = bufferCtor.from(raw.value, "base64");
			return this.safe.decryptString(buf);
		} catch {
			return null;
		}
	}

	async clear (repoId: string): Promise<void> {
		this.app.saveLocalStorage(STORAGE_PREFIX + repoId, null);
	}
}

class LocalStoragePasswordStore implements PasswordStore {
	readonly backend = "local-storage" as const;
	readonly description = "Stored in Obsidian's app-private storage on this device. Less secure than the desktop keychain.";

	constructor (private readonly app: App) {}

	async save (repoId: string, password: string): Promise<void> {
		const entry: StoredPassword = { kind: "plain", value: password };
		this.app.saveLocalStorage(STORAGE_PREFIX + repoId, entry);
	}

	async load (repoId: string): Promise<string | null> {
		const raw: unknown = this.app.loadLocalStorage(STORAGE_PREFIX + repoId);
		if (!isStoredPassword(raw) || raw.kind !== "plain") return null;
		return raw.value;
	}

	async clear (repoId: string): Promise<void> {
		this.app.saveLocalStorage(STORAGE_PREFIX + repoId, null);
	}
}

class SecretStoragePasswordStore implements PasswordStore {
	readonly backend = "secret-storage" as const;
	readonly description = "Stored securely by Obsidian SecretStorage on this device.";

	constructor(private readonly app: App, private readonly legacy: PasswordStore) {}

	private id(repoId: string): string {
		return `seafile-password-${repoId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
	}

	async save(repoId: string, password: string): Promise<void> {
		this.app.secretStorage.setSecret(this.id(repoId), password);
		await this.legacy.clear(repoId);
	}

	async load(repoId: string): Promise<string | null> {
		const stored = this.app.secretStorage.getSecret(this.id(repoId));
		if (stored) return stored;
		const legacy = await this.legacy.load(repoId);
		if (legacy) await this.save(repoId, legacy);
		return legacy;
	}

	async clear(repoId: string): Promise<void> {
		this.app.secretStorage.setSecret(this.id(repoId), "");
		await this.legacy.clear(repoId);
	}
}

let cached: { app: App, store: PasswordStore } | null = null;
export function getPasswordStore (app: App): PasswordStore {
	if (cached?.app === app) return cached.store;
	const safe = getSafeStorage();
	const legacy = safe ? new SafeStoragePasswordStore(app, safe) : new LocalStoragePasswordStore(app);
	const store = new SecretStoragePasswordStore(app, legacy);
	cached = { app, store };
	return store;
}
