import type { App } from "obsidian";
import type { SeafileSettings } from "./settings";

function stableId(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function authSecretId(settings: Pick<SeafileSettings, "host" | "account">): string {
	return `seafile-auth-${stableId(`${settings.host}\n${settings.account}`)}`;
}

function repoSecretId(settings: Pick<SeafileSettings, "host" | "repoId">): string {
	return `seafile-repo-${stableId(`${settings.host}\n${settings.repoId}`)}`;
}

export function withoutPersistedTokens(settings: SeafileSettings): SeafileSettings {
	return { ...settings, authToken: "", repoToken: "" };
}

export class CredentialStore {
	private activeAuthId = "";
	private activeRepoId = "";

	constructor(private readonly app: App) {}

	hydrate(settings: SeafileSettings): boolean {
		this.activeAuthId = settings.host && settings.account ? authSecretId(settings) : "";
		this.activeRepoId = settings.host && settings.repoId ? repoSecretId(settings) : "";
		let migrated = false;
		if (this.activeAuthId) {
			const stored = this.app.secretStorage.getSecret(this.activeAuthId);
			if (stored) settings.authToken = stored;
			else if (settings.authToken) {
				this.app.secretStorage.setSecret(this.activeAuthId, settings.authToken);
				migrated = true;
			}
		}
		if (this.activeRepoId) {
			const stored = this.app.secretStorage.getSecret(this.activeRepoId);
			if (stored) settings.repoToken = stored;
			else if (settings.repoToken) {
				this.app.secretStorage.setSecret(this.activeRepoId, settings.repoToken);
				migrated = true;
			}
		}
		return migrated;
	}

	persist(settings: SeafileSettings): void {
		const nextAuthId = settings.host && settings.account ? authSecretId(settings) : "";
		const nextRepoId = settings.host && settings.repoId ? repoSecretId(settings) : "";
		if (this.activeAuthId && this.activeAuthId !== nextAuthId) this.app.secretStorage.setSecret(this.activeAuthId, "");
		if (this.activeRepoId && this.activeRepoId !== nextRepoId) this.app.secretStorage.setSecret(this.activeRepoId, "");
		if (nextAuthId) this.app.secretStorage.setSecret(nextAuthId, settings.authToken);
		if (nextRepoId) this.app.secretStorage.setSecret(nextRepoId, settings.repoToken);
		this.activeAuthId = nextAuthId;
		this.activeRepoId = nextRepoId;
	}
}
