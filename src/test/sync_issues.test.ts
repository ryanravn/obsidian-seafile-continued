import { describe, expect, test } from "@jest/globals";
import type { App } from "obsidian";
import { shouldSurfaceSyncIssue, SyncIssueStore, type SyncIssue } from "../sync/issues";

function fakeApp(initial: unknown = null): App {
	let stored: unknown = initial;
	return {
		loadLocalStorage: () => stored,
		saveLocalStorage: (_key: string, value: unknown) => { stored = value; }
	} as unknown as App;
}

describe("sync issue store", () => {
	test("deduplicates recurring open issues and retains occurrences", () => {
		const store = new SyncIssueStore(fakeApp());
		store.add({ kind: "error", message: "Network failed" });
		store.add({ kind: "error", message: "Network failed" });

		expect(store.list()).toHaveLength(1);
		expect(store.list()[0].occurrences).toBe(2);
	});

	test("supports resolving and clearing issues", () => {
		const store = new SyncIssueStore(fakeApp());
		const issue = store.add({ kind: "conflict", message: "Conflict", path: "note.md" });
		if (!issue) throw new Error("Expected conflict to be retained");
		store.resolve(issue.id);
		expect(store.list()[0].resolved).toBe(true);
		store.clearResolved();
		expect(store.list()).toEqual([]);
	});

	test("resolves all issues associated with a completed recovery action", () => {
		const store = new SyncIssueStore(fakeApp());
		store.add({ kind: "error", message: "Invalid policy", action: "repair-library-policy" });
		store.add({ kind: "error", message: "Invalid policy during startup", action: "repair-library-policy" });
		store.add({ kind: "error", message: "Unrelated" });

		store.resolveByAction("repair-library-policy");

		expect(store.list().filter(issue => issue.action === "repair-library-policy").every(issue => issue.resolved)).toBe(true);
		expect(store.list().find(issue => issue.message === "Unrelated")?.resolved).toBe(false);
	});

	test("does not retain self-healing synchronization races", () => {
		const transient = [
			"File 'note.md' changed while it was being synchronized. It will be retried on the next sync.",
			"Seafile HEAD verification failed: expected 'ours', received 'theirs'."
		];
		const stored = transient.map((message, index): SyncIssue => ({
			id: String(index), kind: "error", message, createdAt: 1, lastSeenAt: 1, occurrences: 1, resolved: false
		}));
		const store = new SyncIssueStore(fakeApp(stored));

		expect(store.list()).toEqual([]);
		expect(store.add({ kind: "error", message: transient[0] })).toBeNull();
		expect(shouldSurfaceSyncIssue({ kind: "error", message: "Authentication failed repeatedly" })).toBe(true);
	});

	test("migrates fork issue data into the upstream storage namespace", () => {
		const legacyIssue: SyncIssue = {
			id: "legacy", kind: "conflict", message: "Preserved conflict", createdAt: 1,
			lastSeenAt: 1, occurrences: 1, resolved: false
		};
		const storage = new Map<string, unknown>([["seafile-improved-sync-issues", [legacyIssue]]]);
		const app = {
			loadLocalStorage: (key: string) => storage.get(key) ?? null,
			saveLocalStorage: (key: string, value: unknown) => { storage.set(key, value); }
		} as unknown as App;
		const store = new SyncIssueStore(app);

		expect(store.list()).toEqual([legacyIssue]);
		store.add({ kind: "error", message: "New issue" });
		expect(storage.has("seafile-continued-sync-issues")).toBe(true);
	});
});
