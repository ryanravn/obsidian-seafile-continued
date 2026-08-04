import * as IgnoreParser from "gitignore-parser";
import { posix as Path } from "path-browserify";
import { FileSystemAdapter, Notice, Platform, type DataAdapter } from "obsidian";
import { type SeafileSettings } from "src/settings";
import { DEFAULT_IGNORE, HEAD_COMMIT_PATH, SYNC_DATA_PATH, SYNC_DLOG_PATH, server } from "../config";
import { MODE_DIR, MODE_FILE, TYPE_FILE, ZeroFs, type DirSeafDirent, type DirSeafFs, type FileSeafDirent, type FileSeafFs, type SeafDirent, type SeafFs } from "../server";
import * as utils from "../utils";
import { debug } from "../utils";
import { SyncNode, type STATE_UPLOAD, type SyncStateChangedListener as NodeStateChangedListener } from "./node";
import { MobileDataAdapter } from "src/@types/obsidian";

export interface NodeChange {
  node: SyncNode
  type: "add" | "remove-file" | "remove-folder" | "modify"
}

export interface SYNC_IDLE {
  type: "idle"
}

export interface SYNC_BUSY {
  type: "busy"
  toStop?: boolean
  message?: "download" | "upload" | "fetch"
}

export interface SYNC_STOP {
  type: "stop"
  message?: "error" | "user"
}

export type SyncStatus = SYNC_IDLE | SYNC_BUSY | SYNC_STOP

export class SyncController {
	private static readonly LARGE_FILE_WARNING_BYTES = 50 * 1024 * 1024;
	private static readonly BLOCK_UPLOAD_CONCURRENCY = 2;
	private static readonly BLOCK_CHECK_BATCH_SIZE = 1000;
	private fileIoTail: Promise<void> = Promise.resolve();
	private readonly warnedLargeMobileFiles = new Set<string>();

	private ignore: {
    accepts: (input: string) => boolean
    denies: (input: string) => boolean
    maybe: (input: string) => boolean
  };

	private nodeRoot: SyncNode;

	public constructor (
    private readonly adapter: DataAdapter,
    private readonly settings: SeafileSettings) {
		this.setIgnorePattern(settings.ignore);
	}

	public setIgnorePattern (pattern: string) {
		this.ignore = IgnoreParser.compile(DEFAULT_IGNORE + "\n" + pattern);
	}

	// Recursive pull walks siblings concurrently. Serialize the expensive file
	// bodies so a large directory cannot place several complete mobile files (or
	// many desktop block buffers) in memory at once.
	private async withFileIoSlot<T> (task: () => Promise<T>): Promise<T> {
		const previous = this.fileIoTail;
		let release = (): void => {};
		this.fileIoTail = new Promise<void>(resolve => { release = resolve; });
		await previous;
		try {
			return await task();
		} finally {
			release();
		}
	}

	private async assertFileUnchanged (path: string, expected: { size: number, mtime: number }): Promise<void> {
		const current = await utils.fastStat(path);
		if (!current || current.type !== "file" || current.size !== expected.size || current.mtime !== expected.mtime) {
			throw new Error(`File '${path}' changed while it was being synchronized. It will be retried on the next sync.`);
		}
	}

	private async *readFileBlocks (
		path: string,
		expected: { size: number, mtime: number },
		indices?: ReadonlySet<number>
	): AsyncGenerator<{ index: number, data: ArrayBuffer }> {
		await this.assertFileUnchanged(path, expected);
		const blockCount = Math.ceil(expected.size / utils.SEAFILE_BLOCK_SIZE);

		if (Platform.isDesktop && this.adapter instanceof FileSystemAdapter) {
			// Obsidian loads desktop plugins as CommonJS. Keeping this as a native
			// dynamic import leaves `import("fs/promises")` in the bundle, which its
			// plugin loader cannot resolve. A conditional require uses the loader's
			// existing Node integration and remains unexecuted on mobile.
			const { open } = require("fs/promises") as typeof import("fs/promises");
			const handle = await open(this.adapter.getFullPath(path), "r");
			try {
				for (let index = 0; index < blockCount; index++) {
					if (indices && !indices.has(index)) continue;
					const offset = index * utils.SEAFILE_BLOCK_SIZE;
					const length = Math.min(utils.SEAFILE_BLOCK_SIZE, expected.size - offset);
					const bytes = new Uint8Array(length);
					let bytesRead = 0;
					while (bytesRead < length) {
						const result = await handle.read(bytes, bytesRead, length - bytesRead, offset + bytesRead);
						if (result.bytesRead === 0) {
							throw new Error(`File '${path}' ended while it was being synchronized.`);
						}
						bytesRead += result.bytesRead;
					}
					yield { index, data: bytes.buffer };
				}
			} finally {
				await handle.close();
			}
		} else {
			if (Platform.isMobile && expected.size > SyncController.LARGE_FILE_WARNING_BYTES && !this.warnedLargeMobileFiles.has(path)) {
				this.warnedLargeMobileFiles.add(path);
				debug.warn(`File '${path}' is larger than 50 MB. Mobile must temporarily read the complete file into memory.`);
				new Notice(`Seafile: '${Path.basename(path)}' is larger than 50 MB. Mobile sync may use significant memory.`, 8000);
			}
			const buffer = await this.adapter.readBinary(path);
			if (buffer.byteLength !== expected.size) {
				throw new Error(`File '${path}' changed while it was being synchronized.`);
			}
			for (let index = 0; index < blockCount; index++) {
				if (indices && !indices.has(index)) continue;
				const offset = index * utils.SEAFILE_BLOCK_SIZE;
				yield { index, data: buffer.slice(offset, Math.min(offset + utils.SEAFILE_BLOCK_SIZE, expected.size)) };
			}
		}

		await this.assertFileUnchanged(path, expected);
	}

	// Load sync data
	async init () {
		SyncNode.onStateChanged = n => { this.raiseNodeStateChanged(n); };
		this.nodeRoot = await SyncNode.load();

		// Obsidian's adapter.append() throws ENOENT if the file doesn't exist,
		// so ensure the log/data files are present before sync writes to them.
		for (const path of [SYNC_DLOG_PATH, SYNC_DATA_PATH]) {
			if (!await this.adapter.exists(path)) {
				await this.adapter.write(path, "");
			}
		}

		if (this.localHead === undefined) {
			if (await this.adapter.exists(HEAD_COMMIT_PATH)) {
				this.localHead = await this.adapter.read(HEAD_COMMIT_PATH);
			} else {
				this.localHead = "";
			}
		}
	}

	async downloadFile (path: string, fsId: string, mtime: number) {
		return await this.withFileIoSlot(async () => {
			this.ignoreChange.add(path);
			try {
				mtime = mtime * 1000;
				await this.adapter.write(path, "", { mtime });

				if (fsId == ZeroFs) {
					return;
				}

				let nativePath;
				if (Platform.isMobile) {
					nativePath = (this.adapter as MobileDataAdapter).getNativePath(path);
				}

				const [, fs] = await server.getFs(fsId);
				for (const blockId of (fs as FileSeafFs).block_ids) {
					const block = await server.getBlock(blockId);
					if (Platform.isDesktop) {
						await this.adapter.append(path, new DataView(block) as unknown as string, { mtime });
					} else {
						// Hacky way to get the filesystem plugin to append to file when mobile
						const encoded = await utils.arrayBufferToBase64(block);
						const capacitor = window.top as unknown as {
							Capacitor: { Plugins: { Filesystem: { appendFile(options: { path: string; data: string }): Promise<void> } } }
						};
						// nativePath is intentionally passed through unchanged to preserve
						// existing runtime behavior (it is not awaited here).
						await capacitor.Capacitor.Plugins.Filesystem.appendFile({ path: nativePath as unknown as string, data: encoded });
					}
				}

				if (Platform.isMobile) {
					await this.adapter.append(path, "", { mtime }); // Set mtime
				}
			} finally {
				this.ignoreChange.delete(path);
			}
		});
	}

	public onNodeStateChanged?: NodeStateChangedListener;
	private raiseNodeStateChanged (node: SyncNode) {
		this.onNodeStateChanged?.(node);
	}

	public async pull (changes: NodeChange[], path: string, node: SyncNode, remote?: SeafDirent) {
		// Step 0. Check ignore pattern
		if (this.ignore.denies(path)) {
			if (remote) {
				await node.setPrevAsync(remote, false);
				node.state = { type: "sync" };
				return;
			} else {
				await node.delete();
				return;
			}
		}

		// Step 1. Check file status: same, local, remote, merge, conflict
		const local = await utils.fastStat(path);

		let target = null;
		// Same:
		// - both are null
		// - prev not dirty, prev id == remote id
		// - mtime is same, type is file, size is same
		if (
			(!local && !remote) ||
            (node?.prev && remote && !node.prevDirty && node.prev.id === remote.id) ||
            (local && remote && Math.floor(local.mtime / 1000) === remote.mtime && local.type == "file" && remote.mode == MODE_FILE && local.size === remote.size)
		) {
			target = "same";
			if (local || remote) {
				await node.setPrevAsync(remote, false);
				node.state = { type: "sync" };
			} else {
				await node.delete();
			}
			return;
		}
		// Local:
		// prev and remote is null
		// prev and remote have same id
		else if (
			(!remote && !node.prev) ||
            (node.prev && remote && node.prev.id === remote.id)
		) {
			target = "local";
		}

		// Remote: Local matches prev
		// prev is not dirty
		// prev and local is null
		// prev and local are files, prev mtime and size matches local
		else if (
			(!node.prevDirty) ||
            (!local && !node.prev) ||
            (node.prev?.mode == MODE_FILE && local?.type == "file" && node.prev.mtime === Math.floor(local.mtime / 1000) && node.prev.size === local.size)
		) {
			target = "remote";
		}

		// Merge:
		// Neither is a file
		else if (local?.type !== "file" && remote?.mode !== MODE_FILE) {
			target = "merge";
		}
		// Conflict:
		// One is a file
		else {
			target = "conflict";
		}

		// Step 2. Resolve conflicts
		if (target == "conflict") {
			// Only one side exists
			if (local && !remote) target = "local";
			else if (!local && remote) target = "remote";
			else {
				// Take the newer one
				if (Math.floor(local!.mtime / 1000) > remote!.mtime) target = "local";
				else {
					target = "remote";
					if (local!.type == "file") { await this.adapter.remove(path); } else { await this.adapter.rmdir(path, true); }
				}
			}
		}

		// Step 3. Update and merge
		// 3.1 Branching
		let newChildrenNames: Set<string> | null = null;
		const newRemote: Record<string, SeafDirent> = {};

		if ((target == "local" || target == "merge") && local && local.type == "folder") {
			const list = await utils.fastList(path);
			if (!newChildrenNames) newChildrenNames = new Set();
			for (const name of list) {
				newChildrenNames.add(name);
			}
		}
		if ((target == "remote" || target == "merge") && remote && remote.mode == MODE_DIR) {
			const [, rawFs] = await server.getFs(remote.id);
			const fs = rawFs as DirSeafFs | null;
			if (!newChildrenNames) newChildrenNames = new Set();
			if (fs) {
				for (const dirent of fs.dirents) {
					newRemote[dirent.name] = dirent;
					newChildrenNames.add(dirent.name);
				}
			}
		}

		const nodeChildren = node.getChildren();

		// null means no need to pull children
		if (newChildrenNames) {
			for (const name in nodeChildren) {
				newChildrenNames.add(name);
			}

			if (target == "remote" && !local) {
				await this.adapter.mkdir(path);
			}

			const promises = [];
			for (const name of newChildrenNames) {
				const nodeChild = nodeChildren[name] ?? node.createChild(name);
				const remoteChild = target == "local" ? nodeChild.prev : newRemote[name];

				promises.push(
					this.pull(
						changes,
						path + "/" + name,
						nodeChild,
						remoteChild
					));
			}
			await Promise.all(promises);

			// After pulling children, merge status is changed to local
			if (target == "merge") {
				if (Object.keys(nodeChildren).length === 0) {
					// Merge result is an empty folder
					if (!remote) {
						await this.adapter.rmdir(path, true);
						await node.delete();
						changes.push({ node, type: "remove-folder" });
						return;
					} else {
						// Local not exist
						await this.adapter.mkdir(path);
						await node.setPrevAsync(remote, false);
						node.state = { type: "sync" };
						return;
					}
				} else {
					// Merge result is a non-empty folder, use local to compute new fs and dirent
					target = "local";
				}
			}
		}

		// 3.2 Updating
		if (target == "remote") {
			if (!remote) {
				if (local) {
					if (local.type == "file") {
						await this.adapter.remove(path);
					} else {
						await this.adapter.rmdir(path, true);
					}
				}
				await node.delete();
				return;
			} else {
				if (remote.mode == MODE_FILE) {
					node.state = { type: "download", param: 0 };
					await this.downloadFile(path, remote.id, remote.mtime);
					await node.setPrevAsync(remote, false);
					node.state = { type: "sync" };
					return;
				} else {
					await node.setPrevAsync(remote, true);
					// Let below code to recompute dirent and fs
				}
			}
		}

		if (target == "local") {
			if (!local) {
				if (remote!.mode == MODE_FILE) {
					changes.push({ node, type: "remove-file" });
				} else {
					changes.push({ node, type: "remove-folder" });
				}
				await node.delete();
				return;
			} else if (local.type === "file") {
				const [dirent, fs, source] = await this.computeFileDirent(path, this.settings.account);
				node.setNext(dirent, false);
				node.state = { type: "upload", param: { progress: 0, fs, source } };
				changes.push({ node, type: remote ? "modify" : "add" });
				return;
			}
		}

		// Recomputing dirent and fs base on current local folder
		const mtime = (remote?.mtime) ?? (node?.prev?.mtime);
		const dirents: SeafDirent[] = [];
		for (const child of Object.values(nodeChildren)) {
			if (child.next) dirents.push(child.next);
			else if (child.prev) dirents.push(child.prev);
			else throw new Error("Cannot find next or prev of child");
		}

		const [dirent, fs] = await this.computeDirDirent(path, dirents, mtime);
		if (dirent.id === remote?.id) {
			await node.setPrevAsync(dirent, false);
			node.state = { type: "sync" };
		} else {
			node.setNext(dirent, false);
			node.state = { type: "upload", param: { progress: 0, fs } };
			changes.push({ node, type: remote ? "modify" : "add" });
			debug.log(`Upload "${path}"`);
			debug.log([dirent.id, fs], remote ? await server.getFs(remote.id) : null);
		}
	}

	async computeFileDirent (path: string, modifier: string): Promise<[FileSeafDirent, SeafFs | null, { path: string, size: number, mtime: number }]> {
		const stat = await utils.fastStat(path);
		if (!stat) throw new Error("Cannot compute fs of non-existent file");

		const source = { path, size: stat.size, mtime: stat.mtime };
		let fsId: string, fs: SeafFs | null;

		if (stat.size == 0) {
			[fsId, fs] = [ZeroFs, null];
		} else {
			const blockIds = await this.withFileIoSlot(async () => {
				const ids: string[] = [];
				for await (const { data } of this.readFileBlocks(path, source)) {
					const wireData = server.crypto ? await server.crypto.encryptBlock(data) : data;
					ids.push(await utils.sha1(wireData));
				}
				return ids;
			});

			fs = {
				block_ids: blockIds,
				size: stat.size,
				type: 1,
				version: 1
			};
			fsId = await utils.computeFsId(fs);
		}

		const dirent: FileSeafDirent = {
			id: fsId,
			mode: MODE_FILE,
			modifier,
			mtime: Math.floor(stat.mtime / 1000),
			name: Path.basename(path),
			size: stat.size
		};

		return [dirent, fs, source];
	}

	async createDirFs (children: SeafDirent[]): Promise<[string, SeafFs | null]> {
		if (children.length === 0) { return [ZeroFs, null]; }

		// Copy before sorting: `children` is owned by the caller.
		const childrenDirents: SeafDirent[] = [...children];

		childrenDirents.sort((a: SeafDirent, b: SeafDirent) => {
			return utils.strcmp(b.name, a.name);
		});

		const fs: DirSeafFs = {
			dirents: childrenDirents,
			type: 3,
			version: 1
		};
		const fsId = await utils.computeFsId(fs);
		return [fsId, fs];
	}

	async computeDirDirent (path: string, children: SeafDirent[], defaultMtime?: number): Promise<[DirSeafDirent, SeafFs | null]> {
		const name = Path.basename(path);

		const [fsId, fs] = await this.createDirFs(children);

		let mtime = defaultMtime;
		if (!mtime) {
			mtime = -1;
			for (const child of children) {
				if (child.mtime > mtime) { mtime = child.mtime; }
			}
			if (mtime === -1) {
				mtime = (defaultMtime) ?? Math.floor(new Date().getTime() / 1000);
			}
		}

		const dirent: DirSeafDirent = {
			id: fsId,
			mode: MODE_DIR,
			mtime,
			name
		};

		return [dirent, fs];
	}

	private async uploadFileBlocks (node: SyncNode, state: STATE_UPLOAD): Promise<void> {
		if (!state.param.source) return;
		const source = state.param.source;
		if (!state.param.fs) {
			await this.assertFileUnchanged(source.path, source);
			state.param.progress = 1;
			this.raiseNodeStateChanged(node);
			return;
		}
		if (state.param.fs.type !== TYPE_FILE || !("block_ids" in state.param.fs)) return;

		const blockIds = state.param.fs.block_ids;
		const availability = new Map<string, boolean>();
		for (let offset = 0; offset < blockIds.length; offset += SyncController.BLOCK_CHECK_BATCH_SIZE) {
			const batch = blockIds.slice(offset, offset + SyncController.BLOCK_CHECK_BATCH_SIZE);
			const batchAvailability = await server.checkBlocksList(batch);
			for (const [id, missing] of batchAvailability) availability.set(id, missing);
		}
		const missingIndices = new Set<number>();
		const scheduledIds = new Set<string>();
		for (let index = 0; index < blockIds.length; index++) {
			const id = blockIds[index];
			if (availability.get(id) && !scheduledIds.has(id)) {
				missingIndices.add(index);
				scheduledIds.add(id);
			}
		}

		if (missingIndices.size === 0) {
			await this.assertFileUnchanged(source.path, source);
			state.param.progress = 1;
			this.raiseNodeStateChanged(node);
			return;
		}

		let completed = 0;
		let batch: Promise<void>[] = [];
		for await (const { index, data } of this.readFileBlocks(source.path, source, missingIndices)) {
			const expectedId = blockIds[index];
			const upload = (async () => {
				const wireData = server.crypto ? await server.crypto.encryptBlock(data) : data;
				const actualId = await utils.sha1(wireData);
				if (actualId !== expectedId) {
					throw new Error(`File '${source.path}' changed while it was being synchronized. It will be retried on the next sync.`);
				}
				await server.uploadBlock(expectedId, wireData);
				completed++;
				state.param.progress = completed / missingIndices.size;
				this.raiseNodeStateChanged(node);
			})();
			batch.push(upload);
			if (batch.length >= SyncController.BLOCK_UPLOAD_CONCURRENCY) {
				await Promise.all(batch);
				batch = [];
			}
		}
		await Promise.all(batch);
	}

	async push (nodeRoot: SyncNode, changes: NodeChange[], parentCommitId: string): Promise<string> {
		if (!nodeRoot.next) {
			debug.log("Nothing to push");
			return parentCommitId;
		}

		const uploads = changes.filter(change => change.type == "add" || change.type == "modify").map(change => change.node);
		// Process one file at a time. Each file retains at most a small bounded
		// batch of blocks, and directories retain no content buffers at all.
		for (const node of uploads) {
			if (node.state.type !== "upload" || !node.next) {
				throw Error("Node is not in upload state or has no next");
			}

			const uploadState: STATE_UPLOAD = node.state;
			const param = uploadState.param;
			await this.uploadFileBlocks(node, uploadState);
			if (param.fs && await server.checkFs(node.next.id)) { await server.sendFs([node.next.id, param.fs]); }
		}

		// Create commit
		const description = server.describeCommit({
			addedFiles: changes.filter(c => c.type == "add" && c.node.next!.mode == MODE_FILE).map(c => c.node.name),
			removedFiles: changes.filter(c => c.type == "remove-file").map(c => c.node.name),
			modifiedFiles: changes.filter(c => c.type == "modify" && c.node.next!.mode == MODE_FILE).map(c => c.node.name),
			addedDirectories: changes.filter(c => c.type == "add" && c.node.next!.mode == MODE_DIR).map(c => c.node.name),
			removedDirectories: changes.filter(c => c.type == "remove-folder").map(c => c.node.name),
			renamedFiles: [],
			renamedDirectories: []
		});
		const commit = await server.createCommit(nodeRoot.next.id, description, parentCommitId);
		await server.uploadCommit(commit);
		await server.setHeadCommit(commit.commit_id);

		// Update nodes
		for (const node of uploads) {
			await node.applyNext();
		}

		return commit.commit_id;
	}

	private readonly ignoreChange = new Set<string>();
	async notifyChange (path: string, type: "create" | "modify" | "delete") {
		if (this.ignoreChange.has(path)) return;

		if (type == "create") {
			if (this.nodeRoot.find(path)) return;
		}
		if (type == "delete") {
			if (!this.nodeRoot.find(path)) return;
		}
		if (type == "modify") {
			const node = this.nodeRoot.find(path);
			if (node?.prev) {
				const local = await utils.fastStat(path);
				if (local && Math.floor(local.mtime / 1000) === node.prev.mtime) return;
			}
		}

		this.nodeRoot.setDirty(path);
	}

	private localHead: string;
	private async setLocalHeadAsync (commitId: string) {
		if (this.localHead != commitId) {
			this.localHead = commitId;
			await this.adapter.write(HEAD_COMMIT_PATH, this.localHead);
		}
	}

	async sync () {
		this.status = { type: "busy", message: "fetch" };
		const changes: NodeChange[] = [];
		const remoteHead = await server.getHeadCommitId();
		const remoteRoot = await server.getCommitRoot(remoteHead);

		this.status.message = "download";
		await this.pull(changes, "", this.nodeRoot, remoteRoot);
		await this.setLocalHeadAsync(remoteHead);

		this.status.message = "upload";
		const newHead = await this.push(this.nodeRoot, changes, this.localHead);
		await this.setLocalHeadAsync(newHead);

		if (SyncNode.dataLogCount > 100) { await SyncNode.save(this.nodeRoot); }
	}

	private timeoutId: number;

	// Consecutive sync() failures. A single transient error (dropped connection,
	// server hiccup) should not require the user to notice a Notice and manually
	// click "resume" -- retry with backoff instead, and only give up for real
	// after several failures in a row.
	private consecutiveFailures = 0;
	private static readonly MAX_CONSECUTIVE_FAILURES = 5;
	private static readonly MAX_BACKOFF_MS = 5 * 60 * 1000;

	private _status: SyncStatus = { type: "stop" };
	public get status () { return this._status; }
	private set status (value) {
		this._status = new Proxy<SyncStatus>(value, {
			set: (target, prop, value) => {
				Reflect.set(target, prop, value);
				this.onSyncStatusChanged?.(target);
				return true;
			}
		});
		this.onSyncStatusChanged?.(value);
	}

	public onSyncStatusChanged: ((status: SyncStatus) => void) | null = null;

	startSync () {
		if (this.status.type == "stop") {
			debug.log("Sync started");
			this.consecutiveFailures = 0;
			this.status = { type: "idle" };
			void this.syncCycle();
		} else if (this.status.type == "busy" && this.status.toStop) {
			this.status.toStop = false;
		} else if (this.status.type == "idle") {
			debug.log("Sync started");
			window.clearTimeout(this.timeoutId);
			void this.syncCycle();
		}
	}

	async syncCycle () {
		if (this.status.type == "idle") {
			this.status = { type: "busy" };

			debug.time("Sync");
			let failed = false;
			try {
				await this.sync();
				this.consecutiveFailures = 0;
			} catch (e) {
				failed = true;
				this.consecutiveFailures++;
				debug.error(e);

				if (this.consecutiveFailures >= SyncController.MAX_CONSECUTIVE_FAILURES) {
					this.status = { type: "stop", message: "error" };
					new Notice(`Sync failed after ${this.consecutiveFailures} attempts: ${(e as Error).message}`);
				} else {
					debug.warn(`Sync attempt ${this.consecutiveFailures} failed, retrying: ${(e as Error).message}`);
				}
			} finally {
				debug.timeEnd("Sync");
			}

			if (this.status.type === "busy") {
				if (this.status.toStop) {
					this.status = { type: "stop" };
					debug.log("Sync stopped");
				} else {
					this.status = { type: "idle" };
					const delay = failed
						? Math.min(this.settings.interval * (2 ** (this.consecutiveFailures - 1)), SyncController.MAX_BACKOFF_MS)
						: this.settings.interval;
					this.timeoutId = window.setTimeout(() => {
						void this.syncCycle();
					}, delay);
				}
			}
		}
	}

	async stopSyncAsync (): Promise<void> {
		if (this.status.type == "idle") {
			window.clearTimeout(this.timeoutId);
			this.status = { type: "stop" };
			debug.log("Sync stopped");
			await Promise.resolve();
		} else if (this.status.type == "busy") {
			this.status.toStop = true;
			debug.log("Sync stopping");
			await new Promise<void>(resolve => {
				const oldListener = this.onSyncStatusChanged;
				this.onSyncStatusChanged = (status) => {
					if (status.type == "stop") {
						this.onSyncStatusChanged = oldListener;
						resolve();
					}

					oldListener?.(status);
				};
			});
		} else {
			await Promise.resolve();
		}
	}
}
