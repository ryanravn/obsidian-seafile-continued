import { posix as Path } from "path-browserify";
import { Notice, Platform, type DataAdapter } from "obsidian";
import { type SeafileSettings } from "src/settings";
import { DEFAULT_SEAFILE_IGNORE, HEAD_COMMIT_PATH, PLUGIN_DIR, SYNC_DATA_PATH, SYNC_DLOG_PATH, server } from "../config";
import { MODE_DIR, MODE_FILE, TYPE_FILE, ZeroFs, type DirSeafDirent, type DirSeafFs, type FileSeafDirent, type FileSeafFs, type SeafDirent, type SeafFs } from "../server";
import * as utils from "../utils";
import { debug } from "../utils";
import { compileIgnoreList, SEAFILE_IGNORE_FILE, type IgnoreList } from "../ignore";
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
	private ignore: IgnoreList = compileIgnoreList("");
	private ignoreFileBootstrapped = false;

	private nodeRoot: SyncNode;

	public constructor (
    private readonly adapter: DataAdapter,
	private readonly settings: SeafileSettings) {}

	private normalizePath(path: string): string {
		while (path.startsWith("/")) path = path.slice(1);
		while (path.endsWith("/")) path = path.slice(0, -1);
		return path;
	}

	private isInternalPath(path: string): boolean {
		const normalized = this.normalizePath(path);
		return normalized === PLUGIN_DIR || normalized.startsWith(PLUGIN_DIR + "/");
	}

	public isPathIgnored(path: string, isDirectory = false): boolean {
		return this.isInternalPath(path) || this.ignore.denies(path, isDirectory);
	}

	public async readIgnoreFile(): Promise<string> {
		if (await this.adapter.exists(SEAFILE_IGNORE_FILE)) return await this.adapter.read(SEAFILE_IGNORE_FILE);
		return DEFAULT_SEAFILE_IGNORE;
	}

	public async reloadIgnoreFile(): Promise<void> {
		this.ignore = compileIgnoreList(await this.readIgnoreFile());
	}

	private async storeIgnoreFile(contents: string, mtime?: number): Promise<void> {
		this.ignoreChange.add("/" + SEAFILE_IGNORE_FILE);
		try {
			await this.adapter.write(SEAFILE_IGNORE_FILE, contents, mtime === undefined ? undefined : { mtime });
		} finally {
			this.ignoreChange.delete("/" + SEAFILE_IGNORE_FILE);
		}
		this.ignore = compileIgnoreList(contents);
		this.nodeRoot?.setDirty("/" + SEAFILE_IGNORE_FILE);
	}

	public async writeIgnoreFile(contents: string): Promise<void> {
		await this.storeIgnoreFile(contents);
	}

	private async readRemoteFile(remote: FileSeafDirent): Promise<string> {
		const [, rawFs] = await server.getFs(remote.id);
		if (!rawFs || rawFs.type !== TYPE_FILE || !("block_ids" in rawFs) || rawFs.size !== remote.size) {
			throw new Error(`Remote file metadata failed verification for '${SEAFILE_IGNORE_FILE}'.`);
		}
		const bytes = new Uint8Array(remote.size);
		let offset = 0;
		for (const blockId of rawFs.block_ids) {
			const block = new Uint8Array(await server.getBlock(blockId));
			if (offset + block.byteLength > bytes.byteLength) throw new Error("Remote ignore file exceeds its declared size.");
			bytes.set(block, offset);
			offset += block.byteLength;
		}
		if (offset !== bytes.byteLength) throw new Error("Remote ignore file does not match its declared size.");
		return new TextDecoder().decode(bytes);
	}

	private async bootstrapIgnoreFile(remoteRoot: DirSeafDirent): Promise<void> {
		if (this.ignoreFileBootstrapped) return;
		const [, rawRootFs] = await server.getFs(remoteRoot.id);
		const remoteIgnore = rawRootFs && rawRootFs.type === 3 && "dirents" in rawRootFs
			? rawRootFs.dirents.find(entry => entry.name === SEAFILE_IGNORE_FILE && entry.mode === MODE_FILE) as FileSeafDirent | undefined
			: undefined;
		const localExists = await this.adapter.exists(SEAFILE_IGNORE_FILE);
		const localContents = localExists ? await this.adapter.read(SEAFILE_IGNORE_FILE) : "";
		const remoteContents = remoteIgnore ? await this.readRemoteFile(remoteIgnore) : "";

		if (!localExists) {
			await this.storeIgnoreFile(
				remoteIgnore ? remoteContents : DEFAULT_SEAFILE_IGNORE,
				remoteIgnore ? remoteIgnore.mtime * 1000 : undefined
			);
		}
		// When both copies differ, the union is deliberately conservative for
		// this first traversal. Normal conflict handling then resolves the file.
		this.ignore = compileIgnoreList([localContents, remoteContents, !localExists && !remoteIgnore ? DEFAULT_SEAFILE_IGNORE : ""].filter(Boolean).join("\n"));
		this.ignoreFileBootstrapped = true;
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
	}

	public onNodeStateChanged?: NodeStateChangedListener;
	private raiseNodeStateChanged (node: SyncNode) {
		this.onNodeStateChanged?.(node);
	}

	public async pull (changes: NodeChange[], path: string, node: SyncNode, remote?: SeafDirent) {
		// Operational plugin state is never part of the library, even if a
		// malformed or remotely edited ignore file omits the recommended rule.
		if (this.isInternalPath(path)) {
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
		const isDirectory = local?.type === "folder" || remote?.mode === MODE_DIR || node.prev?.mode === MODE_DIR;
		const ignored = this.ignore.denies(path, isDirectory);

		// Seafile ignore rules are upload-side exclusions. New local entries are
		// not uploaded, while entries already present on the server may still be
		// downloaded. If the server version is unchanged, ignore local edits.
		if (ignored && !remote && !node.prev) {
			await node.delete();
			return;
		}
		if (ignored && node.prev && remote && node.prev.id === remote.id) {
			await node.setPrevAsync(remote, false);
			node.state = { type: "sync" };
			return;
		}

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
				const [dirent, fs, blocks] = await this.computeFileDirent(path, this.settings.account);
				node.setNext(dirent, false);
				node.state = { type: "upload", param: { progress: 0, fs, blocks } };
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

	async computeFileDirent (path: string, modifier: string): Promise<[FileSeafDirent, SeafFs | null, Record<string, ArrayBuffer>]> {
		const stat = await utils.fastStat(path);
		if (!stat) throw new Error("Cannot compute fs of non-existent file");

		let blockBuffer: Record<string, ArrayBuffer> = {};
		let fsId: string, fs: SeafFs | null;

		if (stat.size == 0) {
			[fsId, fs] = [ZeroFs, null];
		} else {
			// to do: warn if file too large
			const buffer = await this.adapter.readBinary(path);
			blockBuffer = server.crypto
				? await utils.computeBlocksEncrypted(buffer, (chunk) => server.crypto!.encryptBlock(chunk))
				: await utils.computeBlocks(buffer);

			fs = {
				block_ids: Object.keys(blockBuffer),
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

		return [dirent, fs, blockBuffer];
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

	async computeBlocks (localPath: string): Promise<Record<string, ArrayBuffer>> {
		const stat = await utils.fastStat(localPath);
		if (!stat) throw new Error(`File '${localPath}' does not exist.`);
		if (stat.type != "file") throw new Error(`Path '${localPath}' is not a file.`);

		if (stat.size === 0) {
			return {};
		}

		// if size > 50MB, warn user
		if (stat.size > 50 * 1024 * 1024) {
			debug.warn(`File '${localPath}' is larger than 50MB. This may take a while or even crash obsidian.`);
		}

		const blocks: Record<string, ArrayBuffer> = {};
		const buffer = await this.adapter.readBinary(localPath);
		const blockSize = 8 * 1024 * 1024; // 8MB
		const numBlocks = Math.ceil(stat.size / blockSize);
		for (let i = 0; i < numBlocks; i++) {
			const blockStart = i * blockSize;
			const blockEnd = blockStart + blockSize;
			const block = buffer.slice(blockStart, blockEnd);
			const hash = await utils.sha1(block); // Ensure utils.sha1 can handle ArrayBuffer or adjust accordingly
			blocks[hash] = block;
		}

		return blocks;
	}

	async push (nodeRoot: SyncNode, changes: NodeChange[], parentCommitId: string): Promise<string> {
		if (!nodeRoot.next) {
			debug.log("Nothing to push");
			return parentCommitId;
		}

		const uploads = changes.filter(change => change.type == "add" || change.type == "modify").map(change => change.node);
		// Upload fs
		await Promise.all(uploads.map(async (node) => {
			if (node.state.type !== "upload" || !node.next) {
				throw Error("Node is not in upload state or has no next");
			}

			const uploadState: STATE_UPLOAD = node.state;
			const param = uploadState.param;
			if (param.blocks) {
				const blocks: Record<string, ArrayBuffer> = param.blocks;
				await Promise.all(Object.entries(blocks).map(async ([blockId, block]: [string, ArrayBuffer]) => {
					if (await server.checkBlock(blockId)) { await server.sendBlock(blockId, block); }
				}));
			}
			if (param.fs && await server.checkFs(node.next.id)) { await server.sendFs([node.next.id, param.fs]); }
		}));

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
		if (this.normalizePath(path) === SEAFILE_IGNORE_FILE) {
			const contents = type === "delete" ? "" : await this.adapter.read(SEAFILE_IGNORE_FILE);
			this.ignore = compileIgnoreList(contents);
		}

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
		await this.bootstrapIgnoreFile(remoteRoot);

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
