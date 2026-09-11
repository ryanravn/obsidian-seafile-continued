import { describe, expect, test } from "@jest/globals";
import { createDiagnosticsReport } from "../diagnostics";
import { DEFAULT_SETTINGS } from "../settings";

describe("sanitized diagnostics", () => {
	test("reports useful state without identifiers, secrets, paths, or messages", () => {
		const settings = {
			...DEFAULT_SETTINGS,
			host: "https://private.example.test",
			account: "private@example.test",
			authToken: "account-secret",
			repoId: "private-repository-id",
			repoName: "Private vault",
			repoToken: "repository-secret",
			deviceName: "Eric laptop",
			deviceId: "private-device-id",
			notificationUrl: "https://private.example.test/notification",
			pluginSyncOverrides: { calendar: "all" as const }
		};
		const report = createDiagnosticsReport({
			pluginVersion: "0.5.0",
			obsidianVersion: "1.13.0",
			platform: { desktop: true, mobile: false },
			settings,
			syncStatus: { type: "idle", error: "failed at /Secret/Note.md" },
			notificationStatus: { type: "connected" },
			knownRemoteHead: "private-commit-id",
			locallySynchronized: false,
			issues: [{
				id: "issue", kind: "conflict", message: "Secret conflict message", path: "Secret/Note.md",
				createdAt: 1, lastSeenAt: 2, occurrences: 1, resolved: false
			}]
		});
		const text = JSON.stringify(report);

		expect(text).toContain("obsidian-seafile-sync-diagnostics");
		expect(text).toContain("\"connected\"");
		expect(text).toContain("\"conflict\":1");
		for (const secret of [
			settings.host, settings.account, settings.authToken, settings.repoId, settings.repoName,
			settings.repoToken, settings.deviceName, settings.deviceId, settings.notificationUrl,
			"private-commit-id", "Secret/Note.md", "Secret conflict message", "failed at"
		]) expect(text).not.toContain(secret);
	});
});
