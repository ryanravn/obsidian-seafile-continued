import type { HistoryActivity, HistoryGroup, HistoryOperation, LibraryRevision } from "./types";

const BOUNDARY_OPERATIONS = new Set<HistoryOperation>(["rename", "delete", "restore", "snapshot"]);

export function inferHistoryOperation(description: string): HistoryOperation {
	const normalized = description.trim().toLowerCase();
	if (/(^|\n)renamed /.test(normalized)) return "rename";
	if (/(^|\n)(deleted|removed) /.test(normalized)) return "delete";
	if (normalized.includes("restore") || normalized.includes("revert")) return "restore";
	if (normalized.includes("snapshot") || normalized.includes("checkpoint")) return "snapshot";
	if (/(^|\n)modified /.test(normalized)) return "modify";
	if (/(^|\n)added /.test(normalized)) return "create";
	return "unknown";
}

export function extractDescriptionPaths(description: string): string[] {
	const paths: string[] = [];
	for (const match of description.matchAll(/"([^"]+)"/g)) paths.push(match[1]);
	return paths;
}

export function toHistoryActivity(revision: LibraryRevision): HistoryActivity {
	return {
		...revision,
		operation: inferHistoryOperation(revision.description),
		paths: extractDescriptionPaths(revision.description)
	};
}

export function groupHistory(revisions: LibraryRevision[], windowMinutes: number): HistoryGroup[] {
	const activities = revisions.map(toHistoryActivity);
	if (windowMinutes <= 0) return activities.map(activity => createGroup(activity));

	const windowMs = windowMinutes * 60 * 1000;
	const groups: HistoryGroup[] = [];
	for (const activity of activities) {
		const previous = groups[groups.length - 1];
		const previousActivity = previous?.activities[previous.activities.length - 1];
		const crossesBoundary = !previousActivity
			|| BOUNDARY_OPERATIONS.has(previousActivity.operation)
			|| BOUNDARY_OPERATIONS.has(activity.operation);
		const sameEditor = previous?.authorName === activity.authorName && previous?.deviceName === activity.deviceName;
		const closeEnough = previousActivity ? Math.abs(previousActivity.createdAt - activity.createdAt) <= windowMs : false;

		if (!previous || crossesBoundary || !sameEditor || !closeEnough) {
			groups.push(createGroup(activity));
			continue;
		}

		previous.activities.push(activity);
		for (const path of activity.paths) if (!previous.paths.includes(path)) previous.paths.push(path);
	}
	return groups;
}

function createGroup(activity: HistoryActivity): HistoryGroup {
	return {
		id: activity.commitId,
		createdAt: activity.createdAt,
		authorName: activity.authorName,
		deviceName: activity.deviceName,
		activities: [activity],
		paths: [...activity.paths]
	};
}
