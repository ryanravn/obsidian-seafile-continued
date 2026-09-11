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
		const labels: Record<typeof progress.operation, string> = {
			"check-metadata": "Checking metadata",
			"prepare-metadata": "Preparing metadata",
			"publish-metadata": "Publishing metadata",
			"verify-metadata": "Verifying metadata",
			"publish-commit": "Publishing commit",
			"save-state": "Saving state",
			"compact-state": "Compacting state"
		};
		const verb = labels[progress.operation];
		return `${verb} ${progress.completedItems}/${progress.totalItems}`;
	}

	const verb = progress.operation === "prepare"
		? "Preparing"
		: progress.operation === "download" ? "Downloading" : "Uploading";
	return `${verb} ${progress.completedFiles}/${progress.totalFiles}`;
}
