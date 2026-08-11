import { normalizePath, type Stat } from "obsidian";

export interface ConflictPaths {
	currentPath: string
	conflictPath: string
}

export function normalizeConflictPaths(path?: string, relatedPath?: string): ConflictPaths {
	const currentPath = normalizePath((path ?? "").replace(/^\/+/, ""));
	const conflictPath = normalizePath((relatedPath ?? "").replace(/^\/+/, ""));
	if (!currentPath || !conflictPath || currentPath === conflictPath) throw new Error("The recorded conflict paths are invalid.");
	return { currentPath, conflictPath };
}

export function assertReviewedFileUnchanged(path: string, reviewed: Stat | null, current: Stat | null): void {
	if (reviewed?.type === current?.type && reviewed?.size === current?.size && reviewed?.mtime === current?.mtime) return;
	if (!reviewed && !current) return;
	throw new Error(`'${path}' changed while the conflict was being reviewed. Reopen the conflict and try again.`);
}
