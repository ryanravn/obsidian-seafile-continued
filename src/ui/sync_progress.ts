import type { SYNC_BUSY, SyncStatus } from "../sync/controller";
import type { SyncStatusTextMode } from "../settings";

export function shouldShowSyncStatusText(mode: SyncStatusTextMode, status: SyncStatus): boolean {
	return mode === "always" || (mode === "syncing" && status.type === "busy");
}

export function formatSyncActivity(status: SYNC_BUSY): string {
	const progress = status.progress;
	if (!progress) {
		if (status.message === "fetch") return "Checking remote changes";
		if (status.message === "download") return "Comparing files";
		if (status.message === "upload") return "Finalizing upload";
		return "Syncing";
	}
	if ("completedBlocks" in progress) {
		const verb = progress.operation === "check-blocks" ? "Checking" : "Verifying";
		return `${verb} blocks ${progress.completedBlocks}/${progress.totalBlocks}`;
	}
	if ("completedItems" in progress) {
		const verb = progress.operation === "publish-metadata" ? "Publishing metadata"
			: progress.operation === "publish-commit" ? "Publishing commit"
				: progress.operation === "compact-state" ? "Compacting state" : "Saving state";
		return `${verb} ${progress.completedItems}/${progress.totalItems}`;
	}

	const verb = progress.operation === "prepare"
		? "Preparing"
		: progress.operation === "download" ? "Downloading" : "Uploading";
	return `${verb} ${progress.completedFiles}/${progress.totalFiles}`;
}
