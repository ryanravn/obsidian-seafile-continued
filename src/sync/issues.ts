import type { App } from "obsidian";

export type SyncIssueKind = "conflict" | "error" | "safety" | "preflight" | "recovery";
export type SyncIssueAction = "repair-library-policy";

export interface SyncIssueInput {
	kind: SyncIssueKind
	message: string
	path?: string
	relatedPath?: string
	action?: SyncIssueAction
}

export interface SyncIssue extends SyncIssueInput {
	id: string
	createdAt: number
	lastSeenAt: number
	occurrences: number
	resolved: boolean
}

const STORAGE_KEY = "seafile-continued-sync-issues";
const LEGACY_STORAGE_KEYS = ["seafile-sync-issues", "seafile-improved-sync-issues"];
const MAX_ISSUES = 200;
const SELF_HEALING_ERROR_PATTERNS = [
	/changed while (?:it was )?being synchronized/i,
	/Seafile HEAD verification failed/i
];

export function shouldSurfaceSyncIssue(input: SyncIssueInput): boolean {
	return input.kind !== "error" || !SELF_HEALING_ERROR_PATTERNS.some(pattern => pattern.test(input.message));
}

function isSyncIssue(value: unknown): value is SyncIssue {
	if (typeof value !== "object" || value === null) return false;
	const issue = value as Partial<SyncIssue>;
	return typeof issue.id === "string" && typeof issue.kind === "string" && typeof issue.message === "string"
		&& typeof issue.createdAt === "number" && typeof issue.lastSeenAt === "number"
		&& typeof issue.occurrences === "number" && typeof issue.resolved === "boolean";
}

export class SyncIssueStore {
	private issues: SyncIssue[];
	private readonly listeners = new Set<() => void>();

	constructor(private readonly app: App) {
		let stored: unknown = app.loadLocalStorage(STORAGE_KEY);
		for (const legacyKey of LEGACY_STORAGE_KEYS) {
			if (stored !== null && stored !== undefined) break;
			stored = app.loadLocalStorage(legacyKey);
		}
		this.issues = Array.isArray(stored)
			? stored.filter(isSyncIssue).filter(shouldSurfaceSyncIssue).slice(0, MAX_ISSUES)
			: [];
	}

	list(): SyncIssue[] {
		return [...this.issues].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
	}

	add(input: SyncIssueInput): SyncIssue | null {
		if (!shouldSurfaceSyncIssue(input)) return null;
		const now = Date.now();
		const existing = this.issues.find(issue => !issue.resolved && issue.kind === input.kind
			&& issue.path === input.path && issue.relatedPath === input.relatedPath
			&& issue.action === input.action && issue.message === input.message);
		if (existing) {
			existing.lastSeenAt = now;
			existing.occurrences++;
			this.persist();
			return existing;
		}
		const issue: SyncIssue = {
			...input,
			id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
			createdAt: now,
			lastSeenAt: now,
			occurrences: 1,
			resolved: false
		};
		this.issues.unshift(issue);
		this.issues = this.issues.slice(0, MAX_ISSUES);
		this.persist();
		return issue;
	}

	resolve(id: string, resolved = true): void {
		const issue = this.issues.find(candidate => candidate.id === id);
		if (!issue) return;
		issue.resolved = resolved;
		this.persist();
	}

	resolveByAction(action: SyncIssueAction): void {
		let changed = false;
		for (const issue of this.issues) {
			if (issue.action !== action || issue.resolved) continue;
			issue.resolved = true;
			changed = true;
		}
		if (changed) this.persist();
	}

	clearResolved(): void {
		this.issues = this.issues.filter(issue => !issue.resolved);
		this.persist();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private persist(): void {
		this.app.saveLocalStorage(STORAGE_KEY, this.issues);
		for (const listener of this.listeners) listener();
	}
}
