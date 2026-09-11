import { describe, expect, test } from "@jest/globals";
import type { App } from "obsidian";
import { CredentialStore, withoutPersistedTokens } from "../credential_store";
import { DEFAULT_SETTINGS } from "../settings";

function fakeApp(): { app: App, secrets: Map<string, string> } {
	const secrets = new Map<string, string>();
	return {
		secrets,
		app: {
			secretStorage: {
				getSecret: (id: string) => secrets.get(id) || null,
				setSecret: (id: string, value: string) => { secrets.set(id, value); }
			}
		} as unknown as App
	};
}

describe("credential storage", () => {
	test("migrates legacy tokens and redacts persisted settings", () => {
		const { app, secrets } = fakeApp();
		const settings = {
			...DEFAULT_SETTINGS,
			host: "https://seafile.example",
			account: "person@example.com",
			authToken: "account-secret",
			repoId: "repo-id",
			repoToken: "repo-secret"
		};
		const store = new CredentialStore(app);

		expect(store.hydrate(settings)).toBe(true);
		expect(Array.from(secrets.values())).toEqual(expect.arrayContaining(["account-secret", "repo-secret"]));
		expect(withoutPersistedTokens(settings)).toMatchObject({ authToken: "", repoToken: "" });
		expect(settings).toMatchObject({ authToken: "account-secret", repoToken: "repo-secret" });
	});

	test("hydrates tokens from SecretStorage on a later load", () => {
		const { app } = fakeApp();
		const original = {
			...DEFAULT_SETTINGS, host: "https://seafile.example", account: "person@example.com",
			authToken: "account-secret", repoId: "repo-id", repoToken: "repo-secret"
		};
		new CredentialStore(app).hydrate(original);
		const reloaded = { ...original, authToken: "", repoToken: "" };

		expect(new CredentialStore(app).hydrate(reloaded)).toBe(false);
		expect(reloaded).toMatchObject({ authToken: "account-secret", repoToken: "repo-secret" });
	});
});
