import { posix as Path } from "path-browserify";
import Server, { MODE_DIR, MODE_FILE, TYPE_DIR, TYPE_FILE, ZeroFs, type DirSeafFs, type FileSeafDirent, type SeafDirent } from "../server";
import type { FileRevision, SnapshotDiff } from "./types";

export interface HistoricalFile {
	path: string
	commitId: string
	fileId: string
	size: number
	mtime: number
	content: ArrayBuffer
}

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
		if (!revision.fileId) return await this.readFile(revision.commitId, path);
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

	async compareSnapshots(currentCommitId: string, targetCommitId: string): Promise<SnapshotDiff> {
		const [currentRoot, targetRoot] = await Promise.all([
			this.server.getCommitRoot(currentCommitId),
			this.server.getCommitRoot(targetCommitId)
		]);
		const diff: SnapshotDiff = {
			addedFiles: [], modifiedFiles: [], deletedFiles: [], addedDirectories: [], deletedDirectories: []
		};
		await this.compareDirectory("", currentRoot.id, targetRoot.id, diff);
		return diff;
	}

	private normalizePath(rawPath: string): string {
		if (rawPath.split("/").includes("..")) throw new Error("Historical path is invalid.");
		const normalized = Path.normalize("/" + rawPath.replace(/^\/+/, ""));
		return normalized;
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
			} else if (before?.mode === MODE_FILE && after?.mode === MODE_FILE && before.id !== after.id) {
				diff.modifiedFiles.push(childPath);
			}
		}
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
