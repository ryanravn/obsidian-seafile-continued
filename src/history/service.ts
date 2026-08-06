import { posix as Path } from "path-browserify";
import Server, { MODE_DIR, MODE_FILE, TYPE_DIR, TYPE_FILE, ZeroFs, type Commit, type DirSeafFs, type FileSeafDirent, type SeafDirent } from "../server";
import { createLineDiffResult, type DiffLine } from "./text_diff";
import { formatHistoryText, historyTextDiffLimit, historyTextKind, isLikelyTextContent } from "./text_format";
import type { CommitSnapshotChanges, FileMetadataChange, FileRevision, LibraryRevision, SnapshotDiff, SnapshotFileChangeKind } from "./types";

export interface HistoricalTextDiff {
	lines: DiffLine[]
	additions: number | null
	deletions: number | null
	truncated: boolean
}

export interface HistoricalFile {
	path: string
	commitId: string
	fileId: string
	size: number
	mtime: number
	content: ArrayBuffer
}

export interface DeletedFileHistoryPage {
	revisions: FileRevision[]
	nextCommit: string | null
	skipNewestVersion: boolean
	scannedCommits: number
}

export interface FileMetadataRevisionScan {
	revision: FileRevision | null
	creationBoundary: boolean
}

const DELETED_HISTORY_SCAN_LIMIT = 50;

export class HistoryService {
	constructor(private readonly server: Server) {}

	async readFile(commitId: string, rawPath: string): Promise<HistoricalFile> {
		const path = this.normalizePath(rawPath);
		const dirent = await this.resolvePath(commitId, path);
		if (!dirent || dirent.mode !== MODE_FILE) throw new Error(`File '${path}' does not exist in the selected snapshot.`);
		const content = await this.readFileObject(dirent);
		return { path, commitId, fileId: dirent.id, size: dirent.size, mtime: dirent.mtime, content };
	}

	async readRevision(revision: FileRevision): Promise<HistoricalFile> {
		const path = this.normalizePath(revision.renamedFrom || revision.path);
		if (!revision.fileId) {
			const commitId = revision.deleted
				? (await this.server.getCommitInfo(revision.commitId)).parent_id
				: revision.commitId;
			return await this.readFile(commitId, path);
		}
		const file: FileSeafDirent = {
			id: revision.fileId,
			mode: MODE_FILE,
			mtime: Math.floor(revision.createdAt / 1000),
			name: Path.basename(path),
			size: revision.size,
			modifier: revision.authorName
		};
		return {
			path,
			commitId: revision.commitId,
			fileId: revision.fileId,
			size: revision.size,
			mtime: file.mtime,
			content: await this.readFileObject(file)
		};
	}

	async getDeletedRevision(commitId: string, rawPath: string): Promise<FileRevision> {
		const path = this.normalizePath(rawPath);
		const commit = await this.server.getCommitInfo(commitId);
		if (!commit.parent_id) throw new Error("The deletion commit has no parent snapshot.");
		const entry = await this.resolvePath(commit.parent_id, path);
		if (!entry || entry.mode !== MODE_FILE) {
			throw new Error(`The deleted file '${path}' is unavailable in the deletion commit's parent snapshot.`);
		}
		return this.deletedRevision(commit, entry, path);
	}

	async findRetainedDeletedRevision(rawPath: string, limit = 200): Promise<FileRevision | null> {
		const path = this.normalizePath(rawPath);
		let cursor = await this.server.getHeadCommitId();
		let missingCommit: Commit | null = null;
		let scanned = 0;
		while (cursor && scanned++ < limit) {
			const commit = await this.server.getCommitInfo(cursor);
			const entry = await this.resolvePath(cursor, path);
			if (entry?.mode === MODE_FILE) {
				return missingCommit ? this.deletedRevision(missingCommit, entry, path) : null;
			}
			missingCommit = commit;
			cursor = commit.parent_id;
		}
		return null;
	}

	async scanFileMetadataRevision(
		revision: Pick<LibraryRevision, "commitId" | "createdAt" | "authorName" | "authorEmail" | "description">,
		rawPath: string,
		parentRawPath = rawPath
	): Promise<FileMetadataRevisionScan> {
		const path = this.normalizePath(rawPath);
		const parentPath = this.normalizePath(parentRawPath);
		const commit = await this.server.getCommitInfo(revision.commitId);
		const [beforeEntry, afterEntry] = await Promise.all([
			commit.parent_id ? this.resolvePath(commit.parent_id, parentPath) : Promise.resolve(null),
			this.resolvePath(revision.commitId, path)
		]);
		const before = beforeEntry?.mode === MODE_FILE ? beforeEntry : null;
		const after = afterEntry?.mode === MODE_FILE ? afterEntry : null;
		if (!before && after) return { revision: null, creationBoundary: true };
		if (!before || !after || before.id !== after.id) return { revision: null, creationBoundary: false };
		const metadataChanges = this.fileMetadataChanges(before, after);
		if (metadataChanges.length === 0) return { revision: null, creationBoundary: false };
		return { creationBoundary: false, revision: {
			commitId: revision.commitId,
			path,
			createdAt: revision.createdAt,
			authorName: revision.authorName,
			authorEmail: revision.authorEmail,
			description: revision.description,
			size: after.size,
			fileId: after.id,
			contentChanged: false,
			metadataChanges
		} };
	}

	async getDeletedFileHistory(
		deletedRevision: FileRevision,
		startCommit?: string,
		skipNewestVersion = true,
		limit = 50
	): Promise<DeletedFileHistoryPage> {
		const path = this.normalizePath(deletedRevision.renamedFrom || deletedRevision.path);
		let cursor = startCommit || (await this.server.getCommitInfo(deletedRevision.commitId)).parent_id;
		let candidate: { commit: Commit, file: FileSeafDirent } | null = null;
		const revisions: FileRevision[] = [];
		let scanned = 0;

		while (cursor && scanned < DELETED_HISTORY_SCAN_LIMIT) {
			const commit = await this.server.getCommitInfo(cursor);
			const entry = await this.resolvePath(cursor, path);
			scanned++;

			if (!entry || entry.mode !== MODE_FILE) {
				if (candidate) {
					if (skipNewestVersion) skipNewestVersion = false;
					else revisions.push(this.fileRevision(candidate.commit, candidate.file, path));
				}
				return { revisions, nextCommit: null, skipNewestVersion, scannedCommits: scanned };
			}

			if (!candidate || candidate.file.id === entry.id) {
				candidate = { commit, file: entry };
				cursor = commit.parent_id;
				continue;
			}

			if (skipNewestVersion) skipNewestVersion = false;
			else revisions.push(this.fileRevision(candidate.commit, candidate.file, path));
			if (revisions.length >= limit) {
				return { revisions, nextCommit: cursor, skipNewestVersion, scannedCommits: scanned };
			}
			candidate = { commit, file: entry };
			cursor = commit.parent_id;
		}

		if (!cursor) {
			if (candidate) {
				if (skipNewestVersion) skipNewestVersion = false;
				else revisions.push(this.fileRevision(candidate.commit, candidate.file, path));
			}
			return { revisions, nextCommit: null, skipNewestVersion, scannedCommits: scanned };
		}

		return {
			revisions,
			nextCommit: candidate?.commit.commit_id ?? cursor,
			skipNewestVersion,
			scannedCommits: scanned
		};
	}

	async compareSnapshots(currentCommitId: string, targetCommitId: string): Promise<SnapshotDiff> {
		const [currentRoot, targetRoot] = await Promise.all([
			this.server.getCommitRoot(currentCommitId),
			this.server.getCommitRoot(targetCommitId)
		]);
		const diff: SnapshotDiff = {
			addedFiles: [], modifiedFiles: [], modifiedFileChanges: [], deletedFiles: [], addedDirectories: [], deletedDirectories: []
		};
		await this.compareDirectory("", currentRoot.id, targetRoot.id, diff);
		return diff;
	}

	async compareCommitToParent(commitId: string): Promise<CommitSnapshotChanges> {
		const commit = await this.server.getCommitInfo(commitId);
		const parentCommitId = commit.parent_id || null;
		const [parentRoot, commitRoot] = await Promise.all([
			parentCommitId ? this.server.getCommitRoot(parentCommitId) : Promise.resolve(null),
			this.server.getCommitRoot(commitId)
		]);
		const diff: SnapshotDiff = {
			addedFiles: [], modifiedFiles: [], modifiedFileChanges: [], deletedFiles: [], addedDirectories: [], deletedDirectories: []
		};
		await this.compareDirectory("", parentRoot?.id ?? null, commitRoot.id, diff);
		return {
			commitId,
			parentCommitId,
			diff,
			files: [
				...diff.addedFiles.map(path => ({ path, kind: "added" as const })),
				...diff.modifiedFileChanges,
				...diff.deletedFiles.map(path => ({ path, kind: "deleted" as const }))
			].sort((left, right) => left.path.localeCompare(right.path))
		};
	}

	async compareTextFile(
		parentCommitId: string | null,
		commitId: string,
		path: string,
		kind: SnapshotFileChangeKind
	): Promise<HistoricalTextDiff | null> {
		const maxBytes = historyTextDiffLimit(path);
		if (maxBytes === null) return null;
		const [beforeEntry, afterEntry] = await Promise.all([
			parentCommitId && kind !== "added" ? this.resolvePath(parentCommitId, this.normalizePath(path)) : Promise.resolve(null),
			kind !== "deleted" ? this.resolvePath(commitId, this.normalizePath(path)) : Promise.resolve(null)
		]);
		const before = beforeEntry?.mode === MODE_FILE ? beforeEntry : null;
		const after = afterEntry?.mode === MODE_FILE ? afterEntry : null;
		if ((!before && !after) || Math.max(before?.size ?? 0, after?.size ?? 0) > maxBytes) return null;
		const [beforeContent, afterContent] = await Promise.all([
			before ? this.readFileObject(before) : Promise.resolve(new ArrayBuffer(0)),
			after ? this.readFileObject(after) : Promise.resolve(new ArrayBuffer(0))
		]);
		if (historyTextKind(path) === null && (
			(before !== null && !isLikelyTextContent(beforeContent))
			|| (after !== null && !isLikelyTextContent(afterContent))
		)) return null;
		const result = createLineDiffResult(
			formatHistoryText(path, new TextDecoder().decode(beforeContent)),
			formatHistoryText(path, new TextDecoder().decode(afterContent))
		);
		return result;
	}

	private normalizePath(rawPath: string): string {
		if (rawPath.split("/").includes("..")) throw new Error("Historical path is invalid.");
		const normalized = Path.normalize("/" + rawPath.replace(/^\/+/, ""));
		return normalized;
	}

	private fileRevision(commit: Commit, file: FileSeafDirent, path: string): FileRevision {
		const metadata = this.server.getCachedLibraryRevision?.(commit.commit_id);
		return {
			commitId: commit.commit_id,
			path,
			createdAt: metadata?.createdAt ?? file.mtime * 1000,
			authorName: metadata?.authorName || commit.creator_name,
			authorEmail: metadata?.authorEmail || commit.creator,
			description: metadata?.description || commit.description,
			size: file.size,
			fileId: file.id
		};
	}

	private deletedRevision(commit: Commit, file: FileSeafDirent, path: string): FileRevision {
		const metadata = this.server.getCachedLibraryRevision?.(commit.commit_id);
		return {
			commitId: commit.commit_id,
			path,
			createdAt: metadata?.createdAt ?? commit.ctime * 1000,
			authorName: metadata?.authorName || commit.creator_name,
			authorEmail: metadata?.authorEmail || commit.creator,
			description: metadata?.description || commit.description,
			size: file.size,
			fileId: file.id,
			deleted: true
		};
	}

	private async resolvePath(commitId: string, path: string): Promise<SeafDirent | null> {
		let current: SeafDirent = await this.server.getCommitRoot(commitId);
		for (const name of path.split("/").filter(Boolean)) {
			if (current.mode !== MODE_DIR) return null;
			const directory = await this.readDirectory(current.id);
			const child = directory.dirents.find(entry => entry.name === name);
			if (!child) return null;
			current = child;
		}
		return current;
	}

	private async readDirectory(id: string): Promise<DirSeafFs> {
		if (id === ZeroFs) return { type: TYPE_DIR, version: 1, dirents: [] };
		const [, object] = await this.server.getFs(id);
		if (!object || object.type !== TYPE_DIR || !("dirents" in object)) throw new Error(`Historical directory object '${id}' is unavailable.`);
		return object;
	}

	private async readFileObject(file: FileSeafDirent): Promise<ArrayBuffer> {
		if (file.id === ZeroFs) return new ArrayBuffer(0);
		const [, object] = await this.server.getFs(file.id);
		if (!object || object.type !== TYPE_FILE || !("block_ids" in object) || object.size !== file.size) {
			throw new Error(`Historical file object '${file.id}' failed verification.`);
		}
		const blocks = new Array<ArrayBuffer>(object.block_ids.length);
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < object.block_ids.length) {
				const index = next++;
				blocks[index] = await this.server.getBlock(object.block_ids[index]);
			}
		};
		await Promise.all(Array.from({ length: Math.min(4, object.block_ids.length) }, async () => await worker()));
		const total = blocks.reduce((size, block) => size + block.byteLength, 0);
		if (total !== file.size) throw new Error(`Historical file '${file.name}' size verification failed.`);
		const content = new Uint8Array(total);
		let offset = 0;
		for (const block of blocks) {
			content.set(new Uint8Array(block), offset);
			offset += block.byteLength;
		}
		return content.buffer;
	}

	private async compareDirectory(path: string, currentId: string | null, targetId: string | null, diff: SnapshotDiff): Promise<void> {
		if (currentId === targetId) return;
		const [current, target] = await Promise.all([
			currentId ? this.readDirectory(currentId) : Promise.resolve<DirSeafFs>({ type: TYPE_DIR, version: 1, dirents: [] }),
			targetId ? this.readDirectory(targetId) : Promise.resolve<DirSeafFs>({ type: TYPE_DIR, version: 1, dirents: [] })
		]);
		const currentByName = new Map(current.dirents.map(entry => [entry.name, entry]));
		const targetByName = new Map(target.dirents.map(entry => [entry.name, entry]));
		const names = new Set([...currentByName.keys(), ...targetByName.keys()]);
		for (const name of names) {
			const before = currentByName.get(name);
			const after = targetByName.get(name);
			const childPath = `${path}/${name}`;
			if (!before && after) {
				await this.collectAdded(childPath, after, diff);
			} else if (before && !after) {
				await this.collectDeleted(childPath, before, diff);
			} else if (before && after && before.mode !== after.mode) {
				await this.collectDeleted(childPath, before, diff);
				await this.collectAdded(childPath, after, diff);
			} else if (before?.mode === MODE_DIR && after?.mode === MODE_DIR) {
				await this.compareDirectory(childPath, before.id, after.id, diff);
			} else if (before?.mode === MODE_FILE && after?.mode === MODE_FILE) {
				const metadataChanges = this.fileMetadataChanges(before, after);
				const contentChanged = before.id !== after.id;
				if (contentChanged || metadataChanges.length > 0) {
					diff.modifiedFiles.push(childPath);
					diff.modifiedFileChanges.push({ path: childPath, kind: "modified", contentChanged, metadataChanges });
				}
			}
		}
	}

	private fileMetadataChanges(before: FileSeafDirent, after: FileSeafDirent): FileMetadataChange[] {
		const changes: FileMetadataChange[] = [];
		if (before.mtime !== after.mtime) changes.push({ field: "mtime", before: before.mtime, after: after.mtime });
		if (before.modifier !== after.modifier) changes.push({ field: "modifier", before: before.modifier, after: after.modifier });
		if (before.size !== after.size) changes.push({ field: "size", before: before.size, after: after.size });
		return changes;
	}

	private async collectAdded(path: string, entry: SeafDirent, diff: SnapshotDiff): Promise<void> {
		if (entry.mode === MODE_FILE) {
			diff.addedFiles.push(path);
			return;
		}
		diff.addedDirectories.push(path);
		for (const child of (await this.readDirectory(entry.id)).dirents) await this.collectAdded(`${path}/${child.name}`, child, diff);
	}

	private async collectDeleted(path: string, entry: SeafDirent, diff: SnapshotDiff): Promise<void> {
		if (entry.mode === MODE_FILE) {
			diff.deletedFiles.push(path);
			return;
		}
		diff.deletedDirectories.push(path);
		for (const child of (await this.readDirectory(entry.id)).dirents) await this.collectDeleted(`${path}/${child.name}`, child, diff);
	}
}
