export interface FileRevision {
	commitId: string
	path: string
	createdAt: number
	authorName: string
	authorEmail: string
	description: string
	size: number
	fileId: string
	renamedFrom?: string
	deleted?: boolean
	contentChanged?: boolean
	metadataChanges?: FileMetadataChange[]
}

export interface LibraryRevision {
	commitId: string
	createdAt: number
	authorName: string
	authorEmail: string
	description: string
	clientVersion: string
	deviceName: string
	secondParentId?: string
	tags: string[]
}

export interface SnapshotEntry {
	type: "file" | "dir"
	parentDir: string
	name: string
	objectId: string
	size: number
}

export interface DeletedEntry {
	parentDir: string
	name: string
	deletedAt: number
	commitId: string
	isDirectory: boolean
	size: number
	objectId: string
}

export type HistoryOperation = "create" | "modify" | "rename" | "delete" | "restore" | "snapshot" | "unknown";

export interface HistoryActivity extends LibraryRevision {
	operation: HistoryOperation
	paths: string[]
}

export interface HistoryGroup {
	id: string
	createdAt: number
	authorName: string
	deviceName: string
	activities: HistoryActivity[]
	paths: string[]
}

export interface SnapshotDiff {
	addedFiles: string[]
	modifiedFiles: string[]
	modifiedFileChanges: SnapshotFileChange[]
	deletedFiles: string[]
	addedDirectories: string[]
	deletedDirectories: string[]
}

export type SnapshotFileChangeKind = "added" | "modified" | "deleted";

export type FileMetadataField = "mtime" | "modifier" | "size";

export interface FileMetadataChange {
	field: FileMetadataField
	before: string | number
	after: string | number
}

export interface SnapshotFileChange {
	path: string
	kind: SnapshotFileChangeKind
	contentChanged?: boolean
	metadataChanges?: FileMetadataChange[]
}

export interface CommitSnapshotChanges {
	commitId: string
	parentCommitId: string | null
	diff: SnapshotDiff
	files: SnapshotFileChange[]
}

export interface LocalCheckpoint {
	id: string
	path: string
	createdAt: number
	objectId: string
	size: number
	baseRemoteHead: string
	publishedCommitId?: string
}
