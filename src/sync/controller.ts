import { posix as Path } from "path-browserify";
import { FileSystemAdapter, Notice, Platform, type DataAdapter, type Stat } from "obsidian";
import { type SeafileSettings } from "src/settings";
import { app, DEFAULT_SEAFILE_IGNORE, DOWNLOAD_JOURNAL_PATH, DOWNLOAD_STAGING_PATH, HEAD_COMMIT_PATH, PLUGIN_DIR, SYNC_DATA_PATH, SYNC_DLOG_PATH, server } from "../config";
import { MODE_DIR, MODE_FILE, RepositoryUnavailableError, TYPE_FILE, ZeroFs, type DirSeafDirent, type DirSeafFs, type FileSeafDirent, type SeafDirent, type SeafFs } from "../server";
import * as utils from "../utils";
import { debug } from "../utils";
import { compileIgnoreList, SEAFILE_IGNORE_FILE, upsertManagedIgnoreBlock, type IgnoreList } from "../ignore";
import { SyncNode, type STATE_UPLOAD, type SyncStateChangedListener as NodeStateChangedListener } from "./node";
import { MobileDataAdapter } from "src/@types/obsidian";
import { findCaseCollisions, validatePathSegment, type PathPreflightIssue } from "./preflight";
import { shouldSurfaceSyncIssue, type SyncIssueInput } from "./issues";
import { mergeFileContents, type MergeResult } from "./merge";
import { ObsidianSyncPolicy } from "./policy";
import { applyLibrarySyncPolicy, createLibrarySyncPolicy, LIBRARY_POLICY_FILE, LibraryPolicyError, parseLibrarySyncPolicy, serializeLibrarySyncPolicy } from "./library_policy";
import { FailableSlotPool, SlotPool } from "./work_pool";
import { getTransferProfile } from "./transfer_profile";

export interface NodeChange {
  node: SyncNode
  type: "add" | "remove-file" | "remove-folder" | "modify"
}

export interface SYNC_IDLE {
  type: "idle"
  error?: string
}

export interface SYNC_BUSY {
  type: "busy"
  toStop?: boolean
  message?: "download" | "upload" | "fetch"
  progress?: SyncProgress
}

export type SyncProgress = {
  operation: "prepare" | "download" | "upload"
  completedFiles: number
  totalFiles: number
} | {
  operation: "check-blocks" | "verify-blocks"
  completedBlocks: number
  totalBlocks: number
} | {
  operation: "check-metadata" | "prepare-metadata" | "publish-metadata" | "verify-metadata" | "publish-commit" | "save-state" | "compact-state"
  completedItems: number
  totalItems: number
}

export interface SyncPlan {
  downloads: number
  uploads: number
	localDeletions: number
	remoteDeletions: number
	requiresRemoteWrite: boolean
	pathIssues: PathPreflightIssue[]
}

export interface MassDeletionWarning {
	direction: "local" | "remote"
	deletions: number
	trackedFiles: number
	percentage: number
}

export interface VaultVerificationReport {
	remoteHead: string
	knownLocalHead: string
	repositoryPermission: string
	trackedFiles: number
	downloads: number
	uploads: number
	localDeletions: number
	remoteDeletions: number
	pathIssues: PathPreflightIssue[]
	indexHealthy: boolean
}

export class SyncSafetyInterlockError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SyncSafetyInterlockError";
	}
}

export class SyncPreflightError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SyncPreflightError";
	}
}

export function massDeletionWarning(
	settings: Pick<SeafileSettings, "deletionProtectionEnabled" | "deletionProtectionFileThreshold" | "deletionProtectionPercentThreshold" | "deletionProtectionPercentMinimumFiles">,
	direction: "local" | "remote",
	deletions: number,
	trackedFiles: number
): MassDeletionWarning | null {
	if (!settings.deletionProtectionEnabled || deletions <= 0) return null;
	const percentage = trackedFiles > 0 ? deletions / trackedFiles * 100 : 0;
	const exceedsFileThreshold = deletions >= settings.deletionProtectionFileThreshold;
	const exceedsPercentageThreshold = deletions >= settings.deletionProtectionPercentMinimumFiles
		&& percentage >= settings.deletionProtectionPercentThreshold;
	return exceedsFileThreshold || exceedsPercentageThreshold
		? { direction, deletions, trackedFiles, percentage }
		: null;
}

type SyncTarget = "same" | "local" | "remote" | "merge" | "conflict"

interface FileUpload {
  node: SyncNode
  state: STATE_UPLOAD
  blockIds: string[]
}

interface DownloadJournal {
	path: string
	tempPath: string
	backupPath: string
}

interface DesktopFileHandle {
	read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
	close(): Promise<void>
}

interface DesktopFsPromises {
	open(path: string, flags: "r"): Promise<DesktopFileHandle>
}

function isDesktopFsPromises(value: unknown): value is DesktopFsPromises {
	return typeof value === "object" && value !== null && "open" in value && typeof value.open === "function";
}

interface SyncMetrics {
  startedAt: number
  preparedBytes: number
  downloadedBytes: number
  uploadedBytes: number
  reusedUploadBytes: number
}

interface PreparedConflictMerge {
	result: MergeResult
	expectedLocal?: { size: number, mtime: number }
	expectedLocalContent?: string
}

export interface SYNC_STOP {
  type: "stop"
  message?: "error" | "user" | "repository-unavailable" | "safety" | "preflight"
  error?: string
}

export type SyncStatus = SYNC_IDLE | SYNC_BUSY | SYNC_STOP

export class SyncController {
	private static readonly LARGE_FILE_WARNING_BYTES = 50 * 1024 * 1024;
	private static readonly BLOCK_CHECK_BATCH_SIZE = 1000;
	private static readonly BLOCK_CHECK_CONCURRENCY = 4;
	private static readonly FS_UPLOAD_BATCH_SIZE = 100;
	private static readonly FS_OPERATION_CONCURRENCY = 4;
	private static readonly OBJECT_UPLOAD_ATTEMPTS = 2;
	private fileIoTail: Promise<void> = Promise.resolve();
	private readonly transferProfile = getTransferProfile(Platform.isMobile);
	private readonly filePreparationPool = new SlotPool(this.transferProfile.filePreparationConcurrency);
	private readonly warnedLargeMobileFiles = new Set<string>();
	private readonly localStatCache = new Map<string, Promise<Stat | null>>();
	private readonly localListCache = new Map<string, Promise<string[]>>();
	private readonly preparedBlocks = new Map<string, ArrayBuffer>();
	private preparedBlockBytes = 0;
	private preparedBlockCacheEnabled = false;
	private syncMetrics: SyncMetrics | null = null;
	private pendingStateMayBeStale = false;

	private ignore: IgnoreList = compileIgnoreList("");
	private ignoreFileBootstrapped = false;
	private libraryPolicyBootstrapped = false;
	private progressCounts: { downloads: number, uploadsPrepared: number, uploads: number, plan: SyncPlan } | null = null;
	private readonly directoryFsCache = new Map<string, DirSeafFs | null>();
	private readonly conflictMergeCache = new Map<string, Promise<PreparedConflictMerge>>();
	private readonly policy: ObsidianSyncPolicy;
	private pendingPolicySettingsChange = false;

	private nodeRoot: SyncNode;

	public constructor (
    private readonly adapter: DataAdapter,
	private readonly settings: SeafileSettings) {
		this.policy = new ObsidianSyncPolicy(app?.vault?.configDir ?? ".obsidian", PLUGIN_DIR ? Path.basename(PLUGIN_DIR) : "seafile-improved", settings);
	}

	public onMassDeletionWarning: ((warning: MassDeletionWarning) => Promise<boolean>) | null = null;
	public onRepositoryPermissionChanged: ((permission: string) => void) | null = null;
	public onLibraryPolicyChanged: (() => Promise<void>) | null = null;
	public onIssue: ((issue: SyncIssueInput) => void) | null = null;

	private normalizePath(path: string): string {
		while (path.startsWith("/")) path = path.slice(1);
		while (path.endsWith("/")) path = path.slice(0, -1);
		return path;
	}

	private async getLocalStat(path: string): Promise<Stat | null> {
		const key = this.normalizePath(path);
		let result = this.localStatCache.get(key);
		if (!result) {
			result = utils.fastStat(path);
			this.localStatCache.set(key, result);
		}
		return await result;
	}

	private async getLocalList(path: string): Promise<string[]> {
		const key = this.normalizePath(path);
		let result = this.localListCache.get(key);
		if (!result) {
			result = utils.fastList(path);
			this.localListCache.set(key, result);
		}
		return await result;
	}

	private clearLocalSnapshot(): void {
		this.localStatCache.clear();
		this.localListCache.clear();
	}

	private cachePreparedBlock(id: string, data: ArrayBuffer): void {
		if (!this.preparedBlockCacheEnabled || this.transferProfile.preparedBlockCacheBytes === 0 || this.preparedBlocks.has(id)) return;
		if (this.preparedBlockBytes + data.byteLength > this.transferProfile.preparedBlockCacheBytes) return;
		this.preparedBlocks.set(id, data);
		this.preparedBlockBytes += data.byteLength;
	}

	private takePreparedBlock(id: string): ArrayBuffer | undefined {
		const data = this.preparedBlocks.get(id);
		if (!data) return undefined;
		this.preparedBlocks.delete(id);
		this.preparedBlockBytes -= data.byteLength;
		return data;
	}

	private retainPreparedBlocks(ids: ReadonlySet<string>): void {
		for (const [id, data] of this.preparedBlocks) {
			if (ids.has(id)) continue;
			this.preparedBlocks.delete(id);
			this.preparedBlockBytes -= data.byteLength;
		}
	}

	private clearPreparedBlocks(): void {
		this.preparedBlocks.clear();
		this.preparedBlockBytes = 0;
	}

	private async measurePhase<T>(name: string, task: () => Promise<T>): Promise<T> {
		if (!this.settings.devMode) return await task();
		const startedAt = Date.now();
		try {
			return await task();
		} finally {
			debug.log(`[performance] ${name}: ${Date.now() - startedAt} ms`);
		}
	}

	private formatMetricBytes(bytes: number): string {
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	private finishMetrics(): void {
		const metrics = this.syncMetrics;
		this.syncMetrics = null;
		if (!metrics) return;
		const elapsedMs = Math.max(1, Date.now() - metrics.startedAt);
		const transferredBytes = metrics.downloadedBytes + metrics.uploadedBytes;
		const mibPerSecond = transferredBytes / (1024 * 1024) / (elapsedMs / 1000);
		debug.log(
			`[performance] total: ${elapsedMs} ms; prepared ${this.formatMetricBytes(metrics.preparedBytes)}; `
			+ `downloaded ${this.formatMetricBytes(metrics.downloadedBytes)}; uploaded ${this.formatMetricBytes(metrics.uploadedBytes)}; `
			+ `reused ${this.formatMetricBytes(metrics.reusedUploadBytes)}; transfer ${mibPerSecond.toFixed(1)} MB/s`
		);
	}

	private isInternalPath(path: string): boolean {
		const normalized = this.normalizePath(path);
		return normalized === PLUGIN_DIR || normalized.startsWith(PLUGIN_DIR + "/");
	}

	public isPathIgnored(path: string, isDirectory = false): boolean {
		return this.policy.classify(path, isDirectory).transfer !== "sync" || this.ignore.denies(path, isDirectory);
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

	public async updateManagedIgnoreRules(): Promise<boolean> {
		if (!await this.adapter.exists(SEAFILE_IGNORE_FILE)) return false;
		const contents = await this.adapter.read(SEAFILE_IGNORE_FILE);
		const updated = upsertManagedIgnoreBlock(
			contents,
			app.vault.configDir,
			Path.basename(PLUGIN_DIR),
			this.settings
		);
		if (updated === contents) return false;
		await this.storeIgnoreFile(updated);
		return true;
	}

	public async libraryPolicySettingsChanged(): Promise<void> {
		this.pendingPolicySettingsChange = true;
		if (this.status.type === "busy") {
			this.requestSync();
			return;
		}
		await this.applyPolicySettingsChange();
		this.requestSync();
	}

	private async applyPolicySettingsChange(): Promise<void> {
		if (!this.pendingPolicySettingsChange) return;
		this.pendingPolicySettingsChange = false;
		await this.writeLibraryPolicyFile();
		this.policy.update(this.settings);
		await this.updateManagedIgnoreRules();
		this.nodeRoot?.markTreeDirty();
	}

	public runtimePolicySettingsChanged(): void {
		this.policy.update(this.settings);
	}

	public async loadLocalLibraryPolicy(): Promise<boolean> {
		if (!await this.adapter.exists(LIBRARY_POLICY_FILE)) return false;
		const policy = parseLibrarySyncPolicy(await this.adapter.read(LIBRARY_POLICY_FILE));
		const changed = applyLibrarySyncPolicy(this.settings, policy);
		this.policy.update(this.settings);
		if (changed) await this.onLibraryPolicyChanged?.();
		return changed;
	}

	public async readLibraryPolicyFile(): Promise<string> {
		if (await this.adapter.exists(LIBRARY_POLICY_FILE)) return await this.adapter.read(LIBRARY_POLICY_FILE);
		return serializeLibrarySyncPolicy(createLibrarySyncPolicy(this.settings));
	}

	public async replaceLibraryPolicyFile(contents?: string): Promise<void> {
		const policy = contents === undefined
			? createLibrarySyncPolicy(this.settings)
			: parseLibrarySyncPolicy(contents);
		await this.storeLibraryPolicyFile(serializeLibrarySyncPolicy(policy));
		const changed = applyLibrarySyncPolicy(this.settings, policy);
		this.policy.update(this.settings);
		this.pendingPolicySettingsChange = false;
		this.libraryPolicyBootstrapped = true;
		await this.updateManagedIgnoreRules();
		this.nodeRoot?.markTreeDirty();
		if (changed) await this.onLibraryPolicyChanged?.();
	}

	private async storeLibraryPolicyFile(contents: string, mtime?: number): Promise<void> {
		if (await this.adapter.exists(LIBRARY_POLICY_FILE) && await this.adapter.read(LIBRARY_POLICY_FILE) === contents) return;
		await this.adapter.write(LIBRARY_POLICY_FILE, contents, mtime === undefined ? undefined : { mtime });
		this.nodeRoot?.setDirty("/" + LIBRARY_POLICY_FILE);
	}

	private async writeLibraryPolicyFile(): Promise<void> {
		await this.storeLibraryPolicyFile(serializeLibrarySyncPolicy(createLibrarySyncPolicy(this.settings)));
	}

	private async readRemoteFileBytes(remote: FileSeafDirent, path: string): Promise<Uint8Array> {
		const [, rawFs] = await server.getFs(remote.id);
		if (!rawFs || rawFs.type !== TYPE_FILE || !("block_ids" in rawFs) || rawFs.size !== remote.size) {
			throw new Error(`Remote file metadata failed verification for '${this.normalizePath(path)}'.`);
		}
		const bytes = new Uint8Array(remote.size);
		let offset = 0;
		for (const blockId of rawFs.block_ids) {
			const block = new Uint8Array(await server.getBlock(blockId));
			if (offset + block.byteLength > bytes.byteLength) throw new Error("Remote ignore file exceeds its declared size.");
			bytes.set(block, offset);
			offset += block.byteLength;
		}
		if (offset !== bytes.byteLength) throw new Error(`Remote file '${this.normalizePath(path)}' does not match its declared size.`);
		return bytes;
	}

	private async readRemoteTextFile(remote: FileSeafDirent, path: string): Promise<string> {
		return new TextDecoder().decode(await this.readRemoteFileBytes(remote, path));
	}

	private async getDirectoryFs(id: string): Promise<DirSeafFs | null> {
		if (this.directoryFsCache.has(id)) return this.directoryFsCache.get(id) ?? null;
		const [, rawFs] = await server.getFs(id);
		const fs = rawFs as DirSeafFs | null;
		this.directoryFsCache.set(id, fs);
		return fs;
	}

	private async bootstrapIgnoreFile(remoteRoot: DirSeafDirent): Promise<void> {
		if (this.ignoreFileBootstrapped) return;
		const rawRootFs = await this.getDirectoryFs(remoteRoot.id);
		const remoteIgnore = rawRootFs && rawRootFs.type === 3 && "dirents" in rawRootFs
			? rawRootFs.dirents.find(entry => entry.name === SEAFILE_IGNORE_FILE && entry.mode === MODE_FILE) as FileSeafDirent | undefined
			: undefined;
		const localExists = await this.adapter.exists(SEAFILE_IGNORE_FILE);
		const localContents = localExists ? await this.adapter.read(SEAFILE_IGNORE_FILE) : "";
		const remoteContents = remoteIgnore ? await this.readRemoteTextFile(remoteIgnore, SEAFILE_IGNORE_FILE) : "";
		const initialContents = localExists
			? localContents
			: remoteIgnore ? remoteContents : DEFAULT_SEAFILE_IGNORE;
		const managedContents = upsertManagedIgnoreBlock(
			initialContents,
			app.vault.configDir,
			Path.basename(PLUGIN_DIR),
			this.settings
		);

		if (!localExists || managedContents !== localContents) {
			const preservesRemoteContents = !localExists && remoteIgnore && managedContents === remoteContents;
			await this.storeIgnoreFile(managedContents, preservesRemoteContents ? remoteIgnore.mtime * 1000 : undefined);
		}
		// When both copies differ, the union is deliberately conservative for
		// this first traversal. Normal conflict handling then resolves the file.
		this.ignore = compileIgnoreList([managedContents, remoteContents].filter(Boolean).join("\n"));
		this.ignoreFileBootstrapped = true;
	}

	private async bootstrapLibraryPolicyFile(remoteRoot: DirSeafDirent): Promise<void> {
		if (this.libraryPolicyBootstrapped) return;
		const localExists = await this.adapter.exists(LIBRARY_POLICY_FILE);
		const trackedPolicy = this.nodeRoot?.find("/" + LIBRARY_POLICY_FILE)?.prev;
		if (trackedPolicy && localExists) {
			await this.loadLocalLibraryPolicy();
			this.libraryPolicyBootstrapped = true;
			return;
		}
		const rawRootFs = await this.getDirectoryFs(remoteRoot.id);
		const remotePolicy = rawRootFs && rawRootFs.type === 3 && "dirents" in rawRootFs
			? rawRootFs.dirents.find(entry => entry.name === LIBRARY_POLICY_FILE && entry.mode === MODE_FILE) as FileSeafDirent | undefined
			: undefined;
		if (remotePolicy) {
			const contents = await this.readRemoteTextFile(remotePolicy, LIBRARY_POLICY_FILE);
			parseLibrarySyncPolicy(contents);
			await this.storeLibraryPolicyFile(contents, remotePolicy.mtime * 1000);
		} else if (!localExists) {
			await this.writeLibraryPolicyFile();
		}
		await this.loadLocalLibraryPolicy();
		this.libraryPolicyBootstrapped = true;
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

	private async withFilePreparationSlot<T> (task: () => Promise<T>): Promise<T> {
		const release = await this.filePreparationPool.acquire();
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
			const loadNodeModule = (window as unknown as { require?: (module: string) => unknown }).require;
			if (typeof loadNodeModule !== "function") {
				throw new Error("Desktop filesystem access is unavailable in this Obsidian window.");
			}
			const fsPromises = loadNodeModule("fs/promises");
			if (!isDesktopFsPromises(fsPromises)) {
				throw new Error("Obsidian returned an invalid desktop filesystem module.");
			}
			const handle = await fsPromises.open(this.adapter.getFullPath(path), "r");
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
		await this.recoverInterruptedDownload();
		SyncNode.onStateChanged = n => { this.raiseNodeStateChanged(n); };
		SyncNode.onStatesChanged = nodes => { this.raiseNodeStatesChanged(nodes); };
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

	/**
	 * Forget the remote-specific baseline while preserving every vault file.
	 * This is used when replacing a repository that can no longer be reached.
	 * The next initial sync will merge the local vault with the selected
	 * repository as a fresh pairing.
	 */
	async resetForRepositoryChange(): Promise<void> {
		await this.stopSyncAsync();
		await this.recoverInterruptedDownload();

		for (const path of [SYNC_DLOG_PATH, SYNC_DATA_PATH, HEAD_COMMIT_PATH, DOWNLOAD_JOURNAL_PATH]) {
			if (await this.adapter.exists(path)) await this.adapter.remove(path);
		}
		if (await this.adapter.exists(DOWNLOAD_STAGING_PATH)) await this.adapter.rmdir(DOWNLOAD_STAGING_PATH, true);

		this.localHead = undefined;
		this.ignoreFileBootstrapped = false;
		this.libraryPolicyBootstrapped = false;
		this.consecutiveFailures = 0;
		this.syncRequested = false;
		this.pendingStateMayBeStale = false;
		this.clearLocalSnapshot();
		this.clearPreparedBlocks();
		await this.init();
	}

	private async recoverInterruptedDownload(): Promise<void> {
		await this.recoverDownloadJournal(DOWNLOAD_JOURNAL_PATH);
		if (!await this.adapter.exists(DOWNLOAD_STAGING_PATH)) return;

		const staged = await this.adapter.list(DOWNLOAD_STAGING_PATH);
		for (const journalPath of staged.files.filter(path => path.endsWith(".json"))) {
			await this.recoverDownloadJournal(journalPath);
		}

		const remaining = await this.adapter.list(DOWNLOAD_STAGING_PATH);
		if (remaining.files.length === 0 && remaining.folders.length === 0) {
			await this.adapter.rmdir(DOWNLOAD_STAGING_PATH, true);
		}
	}

	private async recoverDownloadJournal(journalPath: string): Promise<void> {
		if (!await this.adapter.exists(journalPath)) return;
		let journal: DownloadJournal;
		try {
			journal = JSON.parse(await this.adapter.read(journalPath)) as DownloadJournal;
			if (!journal.path || !journal.tempPath || !journal.backupPath) return;
		} catch {
			return;
		}

		if (await this.adapter.exists(journal.tempPath)) await this.adapter.remove(journal.tempPath);
		if (await this.adapter.exists(journal.backupPath)) {
			if (await this.adapter.exists(journal.path)) {
				await this.adapter.remove(journal.backupPath);
			} else {
				await this.adapter.rename(journal.backupPath, journal.path);
			}
		}
		await this.adapter.remove(journalPath);
		this.onIssue?.({ kind: "recovery", message: "Recovered a file after an interrupted download.", path: this.normalizePath(journal.path) });
	}

	private async createDownloadStagingPaths(path: string): Promise<DownloadJournal & { journalPath: string }> {
		if (!await this.adapter.exists(DOWNLOAD_STAGING_PATH)) {
			try {
				await this.adapter.mkdir(DOWNLOAD_STAGING_PATH);
			} catch (error) {
				if (!await this.adapter.exists(DOWNLOAD_STAGING_PATH)) throw error;
			}
		}
		const id = crypto.randomUUID();
		return {
			path,
			tempPath: `${DOWNLOAD_STAGING_PATH}/${id}.download`,
			backupPath: `${DOWNLOAD_STAGING_PATH}/${id}.backup`,
			journalPath: `${DOWNLOAD_STAGING_PATH}/${id}.json`
		};
	}

	private async conflictPath(path: string): Promise<string> {
		const account = this.settings.account.replace(/[\\/:*?"<>|]/g, "_") || "unknown";
		const timestamp = new Date().toISOString().replace("T", "-").slice(0, 19).replace(/:/g, "-");
		const base = `${path} (SFConflict ${account} ${timestamp})`;
		for (let suffix = 0; ; suffix++) {
			const candidate = suffix ? `${base}-${suffix}` : base;
			if (!await this.adapter.exists(candidate)) return candidate;
		}
	}

	private async preserveLocalConflict(changes: NodeChange[], path: string, node: SyncNode): Promise<void> {
		if (!node.parent) throw new Error("Cannot preserve a conflict at the vault root.");
		const conflictPath = await this.conflictPath(path);
		this.ignoreChange.add(path);
		this.ignoreChange.add(conflictPath);
		try {
			await this.adapter.rename(path, conflictPath);
		} finally {
			this.ignoreChange.delete(path);
			this.ignoreChange.delete(conflictPath);
		}

		const conflictNode = node.parent.createChild(Path.basename(conflictPath));
		await this.pull(changes, conflictPath, conflictNode, undefined);
		this.onIssue?.({
			kind: "conflict",
			message: "Both the local and remote file changed. The local version was preserved as a conflict copy.",
			path: this.normalizePath(path),
			relatedPath: this.normalizePath(conflictPath)
		});
	}

	private prepareConflictMerge(path: string, local: Stat | null, remote: SeafDirent | undefined, node: SyncNode | undefined): Promise<PreparedConflictMerge> {
		const key = this.normalizePath(path);
		let prepared = this.conflictMergeCache.get(key);
		if (prepared) return prepared;
		prepared = this.computeConflictMerge(path, local, remote, node);
		this.conflictMergeCache.set(key, prepared);
		return prepared;
	}

	private async computeConflictMerge(path: string, local: Stat | null, remote: SeafDirent | undefined, node: SyncNode | undefined): Promise<PreparedConflictMerge> {
		const expectedLocal = local?.type === "file" ? { size: local.size, mtime: local.mtime } : undefined;
		const classification = this.policy.classify(path, false);
		if (classification.merge === "conflict-copy") {
			return { result: { status: "conflict", reason: "Conflict-copy handling is configured for this file." }, expectedLocal };
		}
		if (local?.type !== "file" || remote?.mode !== MODE_FILE || node?.prev?.mode !== MODE_FILE) {
			return { result: { status: "conflict", reason: "A common file version is not available." }, expectedLocal };
		}
		const limit = classification.merge === "markdown" ? 4 * 1024 * 1024 : 2 * 1024 * 1024;
		if (Math.max(local.size, remote.size, node.prev.size) > limit) {
			return { result: { status: "conflict", reason: `Automatic ${classification.merge} merges are limited to ${limit / 1024 / 1024} MiB.` }, expectedLocal };
		}
		try {
			const [localText, baseBytes, remoteBytes] = await Promise.all([
				this.adapter.read(path),
				this.readRemoteFileBytes(node.prev, path),
				this.readRemoteFileBytes(remote, path)
			]);
			const decoder = new TextDecoder("utf-8", { fatal: true });
			await this.assertFileUnchanged(path, { size: local.size, mtime: local.mtime });
			return {
				result: mergeFileContents(classification.merge, decoder.decode(baseBytes), localText, decoder.decode(remoteBytes)),
				expectedLocal,
				expectedLocalContent: localText
			};
		} catch (error) {
			debug.log(`Automatic merge unavailable for '${this.normalizePath(path)}': ${(error as Error).message}`);
			return { result: { status: "conflict", reason: "The merge base or text content could not be read safely." }, expectedLocal };
		}
	}

	private async refreshPreparedConflictMerge(
		path: string,
		local: Stat | null,
		remote: SeafDirent | undefined,
		node: SyncNode
	): Promise<{ prepared: PreparedConflictMerge, local: Stat | null }> {
		let prepared = await this.prepareConflictMerge(path, local, remote, node);
		if (prepared.result.status === "conflict" || !prepared.expectedLocal) return { prepared, local };
		const current = await utils.fastStat(path);
		if (current?.type === "file" && current.size === prepared.expectedLocal.size && current.mtime === prepared.expectedLocal.mtime) {
			return { prepared, local: current };
		}
		this.conflictMergeCache.delete(this.normalizePath(path));
		this.clearLocalSnapshot();
		local = await this.getLocalStat(path);
		prepared = await this.prepareConflictMerge(path, local, remote, node);
		return { prepared, local };
	}

	private async writeMergedFile(path: string, content: string, expectedLocalContent: string): Promise<void> {
		let applied = false;
		this.ignoreChange.add(path);
		try {
			await this.adapter.process(path, current => {
				if (current !== expectedLocalContent) return current;
				applied = true;
				return content;
			});
		} finally {
			this.ignoreChange.delete(path);
		}
		if (!applied) throw new Error(`File '${this.normalizePath(path)}' changed while its conflict was being merged.`);
		this.clearLocalSnapshot();
	}

	async downloadFile (
		path: string,
		fsId: string,
		mtime: number,
		expectedSize: number,
		onProgress?: (completedBytes: number) => void,
		expectedLocal?: { size: number, mtime: number }
	) {
		return await this.withFileIoSlot(async () => {
			const { tempPath, backupPath, journalPath } = await this.createDownloadStagingPaths(path);
			let originalMoved = false;
			let replacementInstalled = false;
			let cleanupComplete = false;
			let completedBytes = 0;
			this.ignoreChange.add(path);
			try {
				onProgress?.(0);
				await this.adapter.write(journalPath, JSON.stringify({ path, tempPath, backupPath }));
				mtime = mtime * 1000;
				await this.adapter.write(tempPath, "", { mtime });

				let nativePath;
				if (Platform.isMobile) {
					nativePath = (this.adapter as MobileDataAdapter).getNativePath(tempPath);
				}

				if (fsId != ZeroFs) {
					const [, rawFs] = await server.getFs(fsId);
					if (!rawFs || rawFs.type !== TYPE_FILE || !("block_ids" in rawFs) || rawFs.size !== expectedSize) {
						throw new Error(`Remote file metadata failed verification for '${path}'.`);
					}
					const prefetch = this.transferProfile.downloadPrefetch;
					const pending = new Map<number, Promise<ArrayBuffer>>();
					let nextToFetch = 0;
					const fillWindow = (): void => {
						while (nextToFetch < rawFs.block_ids.length && pending.size < prefetch) {
							const index = nextToFetch++;
							const request = server.getBlock(rawFs.block_ids[index]);
							// A later block can reject before it is awaited in order.
							// Attach a handler immediately to avoid an unhandled rejection.
							void request.catch(() => {});
							pending.set(index, request);
						}
					};
					fillWindow();
					for (let index = 0; index < rawFs.block_ids.length; index++) {
						const block = await pending.get(index)!;
						pending.delete(index);
						fillWindow();
						if (Platform.isDesktop) {
							await this.adapter.append(tempPath, new DataView(block) as unknown as string, { mtime });
						} else {
							const encoded = await utils.arrayBufferToBase64(block);
							const capacitor = window.top as unknown as {
								Capacitor: { Plugins: { Filesystem: { appendFile(options: { path: string; data: string }): Promise<void> } } }
							};
							await capacitor.Capacitor.Plugins.Filesystem.appendFile({ path: nativePath as unknown as string, data: encoded });
						}
						completedBytes += block.byteLength;
						if (this.syncMetrics) this.syncMetrics.downloadedBytes += block.byteLength;
						onProgress?.(Math.min(expectedSize, completedBytes));
					}
				} else if (expectedSize !== 0) {
					throw new Error(`Remote file metadata failed verification for '${path}'.`);
				}

				await this.adapter.append(tempPath, "", { mtime });
				const completed = await this.adapter.stat(tempPath);
				if (!completed || completed.type !== "file" || completed.size !== expectedSize) {
					throw new Error(`Downloaded file size verification failed for '${path}'.`);
				}

				if (expectedLocal) await this.assertFileUnchanged(path, expectedLocal);
				if (await this.adapter.exists(path)) {
					await this.adapter.rename(path, backupPath);
					originalMoved = true;
				}
				await this.adapter.rename(tempPath, path);
				replacementInstalled = true;
				await this.adapter.append(path, "", { mtime });
				if (originalMoved && await this.adapter.exists(backupPath)) await this.adapter.remove(backupPath);
				originalMoved = false;
				cleanupComplete = true;
			} catch (error) {
				if (await this.adapter.exists(tempPath)) await this.adapter.remove(tempPath);
				if (replacementInstalled && await this.adapter.exists(path)) await this.adapter.remove(path);
				if (originalMoved && await this.adapter.exists(backupPath)) {
					if (!await this.adapter.exists(path)) await this.adapter.rename(backupPath, path);
				}
				cleanupComplete = true;
				throw error;
			} finally {
				if (cleanupComplete && await this.adapter.exists(journalPath)) await this.adapter.remove(journalPath);
				this.ignoreChange.delete(path);
			}
		});
	}

	public onNodeStateChanged?: NodeStateChangedListener;
	public onNodeStatesChanged?: (nodes: SyncNode[]) => void;
	private raiseNodeStateChanged (node: SyncNode) {
		this.onNodeStateChanged?.(node);
	}
	private raiseNodeStatesChanged (nodes: SyncNode[]) {
		if (this.onNodeStatesChanged) this.onNodeStatesChanged(nodes);
		else for (const node of nodes) this.raiseNodeStateChanged(node);
	}

	private reportProgress(progress: SyncProgress): void {
		if (this.status.type === "busy") this.status.progress = progress;
	}

	private determineTarget(local: Stat | null, remote: SeafDirent | undefined, node: SyncNode | undefined): SyncTarget {
		if (
			(!local && !remote) ||
			(node?.prev && remote && !node.prevDirty && node.prev.id === remote.id) ||
			(local && remote && Math.floor(local.mtime / 1000) === remote.mtime && local.type === "file" && remote.mode === MODE_FILE && local.size === remote.size)
		) return "same";
		if (!node && local && remote) {
			return local.type !== "file" && remote.mode !== MODE_FILE ? "merge" : "conflict";
		}

		if (
			(!remote && !node?.prev) ||
			(node?.prev && remote && node.prev.id === remote.id)
		) return "local";

		if (
			(!node?.prevDirty) ||
			(!local && !node?.prev) ||
			(node?.prev?.mode === MODE_FILE && local?.type === "file" && node.prev.mtime === Math.floor(local.mtime / 1000) && node.prev.size === local.size)
		) return "remote";

		if (local?.type !== "file" && remote?.mode !== MODE_FILE) return "merge";
		return "conflict";
	}

	private async countLocalUploadFiles(path: string): Promise<number> {
		if (this.isInternalPath(path)) return 0;
		const local = await this.getLocalStat(path);
		if (!local || this.policy.classify(path, local.type === "folder").transfer !== "sync"
			|| this.ignore.denies(path, local.type === "folder")) return 0;
		if (local.type === "file") return 1;
		const counts = await Promise.all((await this.getLocalList(path)).map(async name => await this.countLocalUploadFiles(`${path}/${name}`)));
		return counts.reduce((total, count) => total + count, 0);
	}

	private emptyPlan(): SyncPlan {
		return { downloads: 0, uploads: 0, localDeletions: 0, remoteDeletions: 0, requiresRemoteWrite: false, pathIssues: [] };
	}

	private mergePlan(target: SyncPlan, source: SyncPlan): void {
		target.downloads += source.downloads;
		target.uploads += source.uploads;
		target.localDeletions += source.localDeletions;
		target.remoteDeletions += source.remoteDeletions;
		target.requiresRemoteWrite ||= source.requiresRemoteWrite;
		target.pathIssues.push(...source.pathIssues);
	}

	private async countRemoteFiles(remote: SeafDirent): Promise<number> {
		if (remote.mode === MODE_FILE) return 1;
		const fs = await this.getDirectoryFs(remote.id);
		const counts = await Promise.all((fs?.dirents ?? []).map(async child => await this.countRemoteFiles(child)));
		return counts.reduce((sum, count) => sum + count, 0);
	}

	private countTrackedFiles(node: SyncNode = this.nodeRoot): number {
		if (node.policyExcluded) return 0;
		if (node.prev?.mode === MODE_FILE) return 1;
		return Object.values(node.getChildren()).reduce((sum, child) => sum + this.countTrackedFiles(child), 0);
	}

	private async planSync(path: string, node: SyncNode | undefined, remote?: SeafDirent): Promise<SyncPlan> {
		const plan = this.emptyPlan();
		if (this.isInternalPath(path)) return plan;

		const local = await this.getLocalStat(path);
		const isDirectory = local?.type === "folder" || remote?.mode === MODE_DIR || node?.prev?.mode === MODE_DIR;
		if (this.policy.classify(path, isDirectory).transfer !== "sync") return plan;
		const baselineNode = node?.policyExcluded ? undefined : node;
		const ignored = this.ignore.denies(path, isDirectory);
		if (ignored && !remote && !baselineNode?.prev) return plan;
		if (ignored && baselineNode?.prev && remote && baselineNode.prev.id === remote.id) return plan;
		if (path) {
			const pathIssue = validatePathSegment(path);
			if (pathIssue) plan.pathIssues.push(pathIssue);
		}

		let target = this.determineTarget(local, remote, baselineNode);
		if (target === "same") return plan;
		if (target === "conflict") {
			if (local && !remote) target = "local";
			else if (!local && remote) target = "remote";
			else {
				const merge = (await this.prepareConflictMerge(path, local, remote, baselineNode)).result;
				if (merge.status === "remote") target = "remote";
				else if (merge.status === "local" || merge.status === "merged") target = "local";
				else {
					// The local side will be preserved as a conflict copy and uploaded,
					// while the remote side is downloaded at the original path.
					if (local?.type === "file") plan.uploads++;
					else if (local?.type === "folder") plan.uploads += await this.countLocalUploadFiles(path);
					plan.requiresRemoteWrite = true;
					target = "remote";
				}
			}
		}
		if (target === "remote" && !remote && local) {
			plan.localDeletions += local.type === "file" ? 1 : await this.countLocalUploadFiles(path);
		}
		if (target === "local") {
			plan.requiresRemoteWrite = true;
			if (!local && remote) plan.remoteDeletions += await this.countRemoteFiles(remote);
		}

		const names = new Set<string>();
		const remoteChildren: Record<string, SeafDirent> = {};
		let recurse = false;
		if ((target === "local" || target === "merge") && local?.type === "folder") {
			recurse = true;
			for (const name of await this.getLocalList(path)) names.add(name);
		}
		if ((target === "remote" || target === "merge") && remote?.mode === MODE_DIR) {
			recurse = true;
			const fs = await this.getDirectoryFs(remote.id);
			for (const child of fs?.dirents ?? []) {
				remoteChildren[child.name] = child;
				names.add(child.name);
			}
		}
		const nodeChildren = baselineNode?.getChildren() ?? {};
		if (recurse) for (const name of Object.keys(nodeChildren)) names.add(name);
		if (recurse) {
			plan.pathIssues.push(...findCaseCollisions(path, names));
			const children = await Promise.all(Array.from(names, async name => {
				const childNode = nodeChildren[name];
				const remoteChild = target === "local" ? childNode?.prev : remoteChildren[name];
				return await this.planSync(`${path}/${name}`, childNode, remoteChild);
			}));
			for (const child of children) this.mergePlan(plan, child);
		}

		if (target === "remote" && remote?.mode === MODE_FILE) plan.downloads++;
		if (target === "local" && local?.type === "file") plan.uploads++;
		return plan;
	}

	private async enforcePlanSafety(plan: SyncPlan, repoPermission: string): Promise<void> {
		if (plan.pathIssues.length > 0) {
			const first = plan.pathIssues[0];
			throw new SyncPreflightError(`Cannot synchronize '${first.path}': ${first.detail}. Fix this path before syncing.`);
		}
		if (plan.requiresRemoteWrite && repoPermission !== "rw") {
			throw new SyncPreflightError(`The selected library is read-only (${repoPermission}). Local changes were not uploaded.`);
		}
		const trackedFiles = this.countTrackedFiles();
		for (const warning of [
			massDeletionWarning(this.settings, "local", plan.localDeletions, trackedFiles),
			massDeletionWarning(this.settings, "remote", plan.remoteDeletions, trackedFiles)
		]) {
			if (!warning) continue;
			const approved = await this.onMassDeletionWarning?.(warning) ?? false;
			if (!approved) {
				throw new SyncSafetyInterlockError(`Blocked deletion of ${warning.deletions} ${warning.direction} files pending user confirmation.`);
			}
		}
	}

	public async pull (changes: NodeChange[], path: string, node: SyncNode, remote?: SeafDirent) {
		// Operational plugin state is never part of the library, even if a
		// malformed or remotely edited ignore file omits the recommended rule.
		if (this.isInternalPath(path)) {
			node.clearPendingTree();
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
		let local = await this.getLocalStat(path);
		const isDirectory = local?.type === "folder" || remote?.mode === MODE_DIR || node.prev?.mode === MODE_DIR;
		const classification = this.policy.classify(path, isDirectory);
		if (classification.transfer !== "sync") {
			node.clearPendingTree();
			if (remote) {
				if (remote.mode === MODE_DIR) node.clearChildren();
				await node.setPrevAsync(remote, false);
				await node.setPolicyExcludedAsync(true);
				node.state = { type: "sync" };
			} else {
				await node.delete();
			}
			return;
		}
		if (node.policyExcluded) {
			node.clearChildren();
			await node.setPolicyExcludedAsync(false);
			await node.setPrevAsync(undefined, true);
		}
		const ignored = this.ignore.denies(path, isDirectory);

		// Seafile ignore rules are upload-side exclusions. New local entries are
		// not uploaded, while entries already present on the server may still be
		// downloaded. If the server version is unchanged, ignore local edits.
		if (ignored && !remote && !node.prev) {
			await node.delete();
			return;
		}
		if (ignored && node.prev && remote && node.prev.id === remote.id) {
			node.clearPendingTree();
			await node.setPrevAsync(remote, false);
			node.state = { type: "sync" };
			return;
		}

		let target = this.determineTarget(local, remote, node);
		if (target === "same") {
			node.clearPendingTree();
			if (local || remote) {
				await node.setPrevAsync(remote, false);
				node.state = { type: "sync" };
			} else {
				await node.delete();
			}
			return;
		}
		// Step 2. Resolve conflicts
		if (target == "conflict") {
			// Only one side exists
			if (local && !remote) target = "local";
			else if (!local && remote) target = "remote";
			else {
				const refreshed = await this.refreshPreparedConflictMerge(path, local, remote, node);
				local = refreshed.local;
				const merge = refreshed.prepared.result;
				if (merge.status === "conflict") {
					debug.log(`Could not automatically merge '${this.normalizePath(path)}': ${merge.reason}`);
					await this.preserveLocalConflict(changes, path, node);
					local = null;
					target = "remote";
				} else if (merge.status === "local") {
					target = "local";
				} else if (merge.status === "remote") {
					target = "remote";
				} else {
					if (refreshed.prepared.expectedLocalContent === undefined) {
						throw new Error(`The local merge input for '${this.normalizePath(path)}' is unavailable.`);
					}
					await this.writeMergedFile(path, merge.content, refreshed.prepared.expectedLocalContent);
					local = await this.getLocalStat(path);
					target = "local";
					debug.log(`Automatically merged '${this.normalizePath(path)}' using ${classification.merge}.`);
				}
			}
		}

		// Step 3. Update and merge
		// 3.1 Branching
		let newChildrenNames: Set<string> | null = null;
		const newRemote: Record<string, SeafDirent> = {};

		if ((target == "local" || target == "merge") && local && local.type == "folder") {
			const list = await this.getLocalList(path);
			if (!newChildrenNames) newChildrenNames = new Set();
			for (const name of list) {
				newChildrenNames.add(name);
			}
		}
		if ((target == "remote" || target == "merge") && remote && remote.mode == MODE_DIR) {
			const fs = await this.getDirectoryFs(remote.id);
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
					await this.downloadFile(path, remote.id, remote.mtime, remote.size, completedBytes => {
						const progress = remote.size === 0 ? 1 : completedBytes / remote.size;
						if (node.state.type === "download") node.state.param = progress;
					}, local?.type === "file" ? { size: local.size, mtime: local.mtime } : undefined);
					if (this.progressCounts) {
						this.progressCounts.downloads++;
						this.reportProgress({
							operation: "download", completedFiles: this.progressCounts.downloads,
							totalFiles: Math.max(this.progressCounts.plan.downloads, this.progressCounts.downloads)
						});
					}
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
				if (this.progressCounts) {
					this.progressCounts.uploadsPrepared++;
					this.reportProgress({
						operation: "prepare", completedFiles: this.progressCounts.uploadsPrepared,
						totalFiles: Math.max(this.progressCounts.plan.uploads, this.progressCounts.uploadsPrepared)
					});
				}
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
			const blockIds = await this.withFilePreparationSlot(async () => {
				const ids: string[] = [];
				for await (const { data } of this.readFileBlocks(path, source)) {
					const wireData = server.crypto ? await server.crypto.encryptBlock(data) : data;
					if (this.syncMetrics) this.syncMetrics.preparedBytes += wireData.byteLength;
					const id = await utils.sha1(wireData);
					ids.push(id);
					this.cachePreparedBlock(id, wireData);
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

	private async findMissingBlocks(
		blockIds: string[],
		onProgress?: (completedBlocks: number, totalBlocks: number) => void
	): Promise<Set<string>> {
		const missing = new Set<string>();
		let nextOffset = 0;
		let completed = 0;
		onProgress?.(0, blockIds.length);
		const worker = async (): Promise<void> => {
			while (nextOffset < blockIds.length) {
				const offset = nextOffset;
				nextOffset += SyncController.BLOCK_CHECK_BATCH_SIZE;
				const batch = blockIds.slice(offset, offset + SyncController.BLOCK_CHECK_BATCH_SIZE);
				const availability = await server.checkBlocksList(batch);
				for (const id of batch) {
					const value = availability.get(id);
					if (value === undefined) throw new Error(`Seafile returned no status for block '${id}'.`);
					if (value) missing.add(id);
				}
				completed += batch.length;
				onProgress?.(completed, blockIds.length);
			}
		};
		const batchCount = Math.ceil(blockIds.length / SyncController.BLOCK_CHECK_BATCH_SIZE);
		await Promise.all(Array.from(
			{ length: Math.min(SyncController.BLOCK_CHECK_CONCURRENCY, batchCount) },
			async () => await worker()
		));
		return missing;
	}

	private async findMissingFilesystemObjects(fsIds: string[], onProgress?: (completed: number, total: number) => void): Promise<Set<string>> {
		const missing = new Set<string>();
		let nextOffset = 0;
		let completed = 0;
		onProgress?.(0, fsIds.length);
		const worker = async (): Promise<void> => {
			while (nextOffset < fsIds.length) {
				const offset = nextOffset;
				nextOffset += SyncController.BLOCK_CHECK_BATCH_SIZE;
				const batch = fsIds.slice(offset, offset + SyncController.BLOCK_CHECK_BATCH_SIZE);
				const availability = await server.checkFsList(batch);
				for (const id of batch) {
					const value = availability.get(id);
					if (value === undefined) throw new Error(`Seafile returned no status for filesystem object '${id}'.`);
					if (value) missing.add(id);
				}
				completed += batch.length;
				onProgress?.(completed, fsIds.length);
			}
		};
		const batchCount = Math.ceil(fsIds.length / SyncController.BLOCK_CHECK_BATCH_SIZE);
		await Promise.all(Array.from(
			{ length: Math.min(SyncController.FS_OPERATION_CONCURRENCY, batchCount) },
			async () => await worker()
		));
		return missing;
	}

	private async uploadBlockIndices (node: SyncNode, state: STATE_UPLOAD, blockIds: string[], missingIndices: ReadonlySet<number>, pool: FailableSlotPool): Promise<void> {
		const source = state.param.source!;
		let completed = 0;
		const pending: Promise<void>[] = [];
		const uncachedIndices = new Set<number>();
		const cachedBlocks: Array<{ index: number, data: ArrayBuffer }> = [];
		for (const index of missingIndices) {
			const data = this.takePreparedBlock(blockIds[index]);
			if (data) cachedBlocks.push({ index, data });
			else uncachedIndices.add(index);
		}
		let blocks: AsyncIterator<{ index: number, data: ArrayBuffer }> | undefined;
		const schedule = async (index: number, data: ArrayBuffer, prepared: boolean, reservedRelease?: () => void): Promise<void> => {
			const release = reservedRelease ?? await pool.acquire();
			const expectedId = blockIds[index];
			const upload = (async () => {
				const wireData = prepared
					? data
					: server.crypto ? await server.crypto.encryptBlock(data) : data;
				if (!prepared) {
					const actualId = await utils.sha1(wireData);
					if (actualId !== expectedId) {
						throw new Error(`File '${source.path}' changed while it was being synchronized. It will be retried on the next sync.`);
					}
				}
				await server.uploadBlock(expectedId, wireData);
				if (this.syncMetrics) {
					this.syncMetrics.uploadedBytes += wireData.byteLength;
					if (prepared) this.syncMetrics.reusedUploadBytes += wireData.byteLength;
				}
				completed++;
				state.param.progress = completed / missingIndices.size;
				this.raiseNodeStateChanged(node);
			})().catch(error => {
				pool.fail(error);
				throw error;
			}).finally(release);
			// Attach a handler immediately; another producer may still be
			// unwinding when this upload rejects.
			void upload.catch(() => {});
			pending.push(upload);
		};
		try {
			if (cachedBlocks.length > 0) {
				await this.assertFileUnchanged(source.path, source);
				for (const block of cachedBlocks) await schedule(block.index, block.data, true);
			}

			blocks = this.readFileBlocks(source.path, source, uncachedIndices)[Symbol.asyncIterator]();
			let scheduled = 0;
			while (scheduled < uncachedIndices.size) {
				const release = await pool.acquire();
				let next: IteratorResult<{ index: number, data: ArrayBuffer }>;
				try {
					next = await blocks.next();
				} catch (error) {
					release();
					pool.fail(error);
					throw error;
				}
				if (next.done) {
					release();
					throw new Error(`File '${source.path}' ended while its blocks were being scheduled.`);
				}

				const { index, data } = next.value;
				scheduled++;
				await schedule(index, data, false, release);
			}
			// We know exactly how many selected blocks the generator must yield.
			// Close it directly after the last one instead of waiting for another
			// scarce upload slot merely to observe IteratorResult.done.
			await blocks.return?.(undefined);
			await Promise.all(pending);
		} catch (error) {
			pool.fail(error);
			await Promise.allSettled(pending);
			await blocks?.return?.(undefined);
			throw error;
		}
	}

	private reportUploadedFile(): void {
		if (!this.progressCounts) return;
		this.progressCounts.uploads++;
		this.reportProgress({
			operation: "upload", completedFiles: this.progressCounts.uploads,
			totalFiles: this.progressCounts.plan.uploads
		});
	}

	private async uploadMissingBlockRound(fileUploads: FileUpload[], missing: ReadonlySet<string>, reportFiles: boolean): Promise<void> {
		const scheduledIds = new Set<string>();
		const assignments = fileUploads.map(upload => {
			const indices = new Set<number>();
			for (let index = 0; index < upload.blockIds.length; index++) {
				const id = upload.blockIds[index];
				if (missing.has(id) && !scheduledIds.has(id)) {
					indices.add(index);
					scheduledIds.add(id);
				}
			}
			return { upload, indices };
		});
		const pool = new FailableSlotPool(this.transferProfile.blockUploadConcurrency);
		const run = async ({ upload, indices }: typeof assignments[number]): Promise<void> => {
			if (indices.size > 0) await this.uploadBlockIndices(upload.node, upload.state, upload.blockIds, indices, pool);
			if (reportFiles) this.reportUploadedFile();
		};

		if (Platform.isMobile) {
			// MobileDataAdapter.readBinary() materializes the complete file. Keep
			// file bodies serial while still allowing two blocks from that file to
			// be encrypted and uploaded concurrently.
			for (const assignment of assignments) await run(assignment);
		} else {
			await Promise.all(assignments.map(run));
		}
	}

	private async uploadFileObjects(fileUploads: FileUpload[]): Promise<void> {
		const blockOwners = new Map<string, string>();
		for (const upload of fileUploads) {
			for (const id of upload.blockIds) {
				if (!blockOwners.has(id)) blockOwners.set(id, upload.state.param.source!.path);
			}
		}

		const blockIds = Array.from(blockOwners.keys());
		let missing = blockIds.length === 0
			? new Set<string>()
			: await this.measurePhase("check upload blocks", async () => await this.findMissingBlocks(
				blockIds,
				(completedBlocks, totalBlocks) => {
					this.reportProgress({ operation: "check-blocks", completedBlocks, totalBlocks });
				}
			));
		this.retainPreparedBlocks(missing);
		let reportedFiles = false;
		for (let attempt = 0; missing.size > 0 && attempt < SyncController.OBJECT_UPLOAD_ATTEMPTS; attempt++) {
			if (this.progressCounts) {
				this.reportProgress({
					operation: "upload",
					completedFiles: this.progressCounts.uploads,
					totalFiles: this.progressCounts.plan.uploads
				});
			}
			await this.measurePhase(`upload block round ${attempt + 1}`, async () => {
				await this.uploadMissingBlockRound(fileUploads, missing, !reportedFiles);
			});
			reportedFiles = true;
			missing = await this.measurePhase(`verify block round ${attempt + 1}`, async () => await this.findMissingBlocks(
				Array.from(missing),
				(completedBlocks, totalBlocks) => {
					this.reportProgress({ operation: "verify-blocks", completedBlocks, totalBlocks });
				}
			));
		}
		if (!reportedFiles) {
			for (let index = 0; index < fileUploads.length; index++) this.reportUploadedFile();
		}
		if (missing.size > 0) {
			const id = missing.values().next().value as string;
			throw new Error(`Seafile did not store block '${id}' referenced by '${blockOwners.get(id)}'. The commit was not published.`);
		}

		for (const upload of fileUploads) {
			const source = upload.state.param.source!;
			await this.assertFileUnchanged(source.path, source);
			upload.state.param.progress = 1;
			this.raiseNodeStateChanged(upload.node);
		}
		this.clearPreparedBlocks();
	}

	private async uploadFilesystemObjects(uploads: SyncNode[], onProgress?: (progress: SyncProgress) => void): Promise<void> {
		const objects = new Map<string, { fs: SeafFs, path: string }>();
		for (const node of uploads) {
			if (node.state.type === "upload" && node.state.param.fs && node.next) {
				objects.set(node.next.id, { fs: node.state.param.fs, path: node.path });
			}
		}
		const total = objects.size;
		let missing = await this.findMissingFilesystemObjects(Array.from(objects.keys()), (completedItems, totalItems) => {
			onProgress?.({ operation: "check-metadata", completedItems, totalItems });
		});
		const alreadyStored = total - missing.size;
		let published = 0;
		if (missing.size === 0) onProgress?.({ operation: "publish-metadata", completedItems: total, totalItems: total });
		for (let attempt = 0; missing.size > 0 && attempt < SyncController.OBJECT_UPLOAD_ATTEMPTS; attempt++) {
			const items = Array.from(missing, id => [id, objects.get(id)!.fs] as [string, SeafFs]);
			let nextOffset = 0;
			let prepared = 0;
			let publishingStarted = alreadyStored > 0 || attempt > 0;
			if (publishingStarted) {
				onProgress?.({ operation: "publish-metadata", completedItems: alreadyStored + published, totalItems: total });
			} else {
				onProgress?.({ operation: "prepare-metadata", completedItems: 0, totalItems: items.length });
			}
			const worker = async (): Promise<void> => {
				while (nextOffset < items.length) {
					const offset = nextOffset;
					nextOffset += SyncController.FS_UPLOAD_BATCH_SIZE;
					const batch = items.slice(offset, offset + SyncController.FS_UPLOAD_BATCH_SIZE);
					let batchPrepared = 0;
					await server.sendPackFs(batch, completedItems => {
						prepared += completedItems - batchPrepared;
						batchPrepared = completedItems;
						if (!publishingStarted) {
							onProgress?.({ operation: "prepare-metadata", completedItems: prepared, totalItems: items.length });
						}
					});
					publishingStarted = true;
					if (attempt === 0) {
						published += batch.length;
					}
					onProgress?.({ operation: "publish-metadata", completedItems: Math.min(total, alreadyStored + published), totalItems: total });
				}
			};
			const batchCount = Math.ceil(items.length / SyncController.FS_UPLOAD_BATCH_SIZE);
			await Promise.all(Array.from(
				{ length: Math.min(SyncController.FS_OPERATION_CONCURRENCY, batchCount) },
				async () => await worker()
			));
			missing = await this.findMissingFilesystemObjects(Array.from(missing), (completedItems, totalItems) => {
				onProgress?.({ operation: "verify-metadata", completedItems, totalItems });
			});
		}
		if (missing.size > 0) {
			const id = missing.values().next().value as string;
			throw new Error(`Seafile did not store filesystem object '${id}' for '${objects.get(id)?.path}'. The commit was not published.`);
		}
		onProgress?.({ operation: "publish-metadata", completedItems: total, totalItems: total });
	}

	async push (nodeRoot: SyncNode, changes: NodeChange[], parentCommitId: string): Promise<string> {
		if (!nodeRoot.next) {
			debug.log("Nothing to push");
			return parentCommitId;
		}
		if (changes.length === 0) {
			nodeRoot.clearPendingTree();
			debug.warn("Discarded stale pending state without semantic changes.");
			return parentCommitId;
		}
		if (nodeRoot.prev?.id === nodeRoot.next.id) {
			nodeRoot.clearPendingTree();
			debug.warn("Discarded a pending commit whose root filesystem is unchanged.");
			return parentCommitId;
		}

		const uploads = changes.filter(change => change.type == "add" || change.type == "modify").map(change => change.node);
		const addedFiles = changes.filter(c => c.type == "add" && c.node.next!.mode == MODE_FILE);
		const removedFiles = changes.filter(c => c.type == "remove-file");
		const addedDirectories = changes.filter(c => c.type == "add" && c.node.next!.mode == MODE_DIR);
		const removedDirectories = changes.filter(c => c.type == "remove-folder");
		const renamedAdded = new Set<NodeChange>();
		const renamedRemoved = new Set<NodeChange>();
		const pairRenames = (added: NodeChange[], removed: NodeChange[]) => removed.flatMap(oldChange => {
			const newChange = added.find(candidate => !renamedAdded.has(candidate) && candidate.node.next?.id === oldChange.node.prev?.id);
			if (!newChange) return [];
			renamedAdded.add(newChange);
			renamedRemoved.add(oldChange);
			return [{ from: oldChange.node.path, to: newChange.node.path }];
		});
		const renamedFiles = pairRenames(addedFiles, removedFiles);
		const renamedDirectories = pairRenames(addedDirectories, removedDirectories);
		const description = server.describeCommit({
			addedFiles: addedFiles.filter(c => !renamedAdded.has(c)).map(c => c.node.path),
			removedFiles: removedFiles.filter(c => !renamedRemoved.has(c)).map(c => c.node.path),
			modifiedFiles: changes.filter(c => c.type == "modify" && c.node.next!.mode == MODE_FILE).map(c => c.node.path),
			addedDirectories: addedDirectories.filter(c => !renamedAdded.has(c)).map(c => c.node.path),
			removedDirectories: removedDirectories.filter(c => !renamedRemoved.has(c)).map(c => c.node.path),
			renamedFiles,
			renamedDirectories
		});
		if (!description) {
			for (const node of uploads) node.discardPendingAsSynchronized();
			debug.warn("Discarded a metadata-only synchronization plan instead of publishing an empty commit.");
			return parentCommitId;
		}

		const fileUploads: FileUpload[] = [];
		for (const node of uploads) {
			if (node.state.type !== "upload" || !node.next) throw Error("Node is not in upload state or has no next");
			if (!node.state.param.source) continue;
			const fs = node.state.param.fs;
			if (fs && (fs.type !== TYPE_FILE || !("block_ids" in fs))) {
				throw new Error(`File '${node.state.param.source.path}' has invalid filesystem metadata.`);
			}
			fileUploads.push({ node, state: node.state, blockIds: fs && "block_ids" in fs ? fs.block_ids : [] });
		}
		if (this.progressCounts) {
			this.progressCounts.plan.uploads = fileUploads.length;
			this.progressCounts.uploads = 0;
			if (fileUploads.length > 0) this.reportProgress({ operation: "upload", completedFiles: 0, totalFiles: fileUploads.length });
		}
		await this.uploadFileObjects(fileUploads);
		if (this.status.type === "busy") this.status.progress = undefined;
		await this.measurePhase("publish filesystem objects", async () => {
			await this.uploadFilesystemObjects(uploads, progress => { this.reportProgress(progress); });
		});

		// Create commit
		this.reportProgress({ operation: "publish-commit", completedItems: 0, totalItems: 1 });
		const commit = await this.measurePhase("publish commit", async () => {
			const nextCommit = await server.createCommit(nodeRoot.next!.id, description, parentCommitId);
			await server.uploadCommit(nextCommit);
			await server.setHeadCommit(nextCommit.commit_id);
			const publishedHead = await server.getHeadCommitId();
			if (publishedHead !== nextCommit.commit_id) {
				throw new Error(`Seafile HEAD verification failed: expected '${nextCommit.commit_id}', received '${publishedHead}'.`);
			}
			return nextCommit;
		});
		this.reportProgress({ operation: "publish-commit", completedItems: 1, totalItems: 1 });

		await this.measurePhase("save local sync state", async () => {
			const totalItems = uploads.length;
			this.reportProgress({ operation: "save-state", completedItems: 0, totalItems });
			const reportInterval = Math.max(1, Math.ceil(totalItems / 100));
			await SyncNode.applyNextBatch(uploads, completedItems => {
				if (completedItems === totalItems || completedItems % reportInterval === 0) {
					this.reportProgress({ operation: "save-state", completedItems, totalItems });
				}
			});
		});

		return commit.commit_id;
	}

	private readonly ignoreChange = new Set<string>();
	async notifyChange (path: string, type: "create" | "modify" | "delete") {
		if (this.ignoreChange.has(path)) return;
		if (this.isInternalPath(path)) return;
		if (this.policy.classify(path).transfer !== "sync") return;
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

	private localHead: string | undefined;
	private async setLocalHeadAsync (commitId: string) {
		if (this.localHead != commitId) {
			this.localHead = commitId;
			await this.adapter.write(HEAD_COMMIT_PATH, this.localHead);
		}
	}

	async sync () {
		if (this.localHead === undefined) throw new Error("Sync controller is not initialized.");
		await this.applyPolicySettingsChange();
		// Pending filesystem objects are derived state. A failed or interrupted
		// attempt must never carry them into a later reconciliation, where an
		// otherwise identical remote tree could turn them into an empty commit.
		if (this.pendingStateMayBeStale) this.nodeRoot.clearPendingTree();
		this.progressCounts = null;
		this.directoryFsCache.clear();
		this.conflictMergeCache.clear();
		this.clearLocalSnapshot();
		this.clearPreparedBlocks();
		this.syncMetrics = this.settings.devMode ? {
			startedAt: Date.now(), preparedBytes: 0, downloadedBytes: 0, uploadedBytes: 0, reusedUploadBytes: 0
		} : null;
		this.status = { type: "busy", message: "fetch" };
		const changes: NodeChange[] = [];
		try {
			const [remoteHead, remoteRoot, repoPermission] = await this.measurePhase("fetch remote metadata", async () => {
				const [head, permission] = await Promise.all([server.getHeadCommitId(), server.getRepoPermission()]);
				const root = await server.getCommitRoot(head);
				await this.bootstrapLibraryPolicyFile(root);
				await this.bootstrapIgnoreFile(root);
				return [head, root, permission] as const;
			});
			if (repoPermission !== this.settings.repoPermission) {
				this.settings.repoPermission = repoPermission;
				this.onRepositoryPermissionChanged?.(repoPermission);
			}

			this.status.progress = undefined;
			this.status.message = "download";
			const plan = await this.measurePhase("plan changes", async () => await this.planSync("", this.nodeRoot, remoteRoot));
			await this.enforcePlanSafety(plan, repoPermission);
			this.progressCounts = { downloads: 0, uploadsPrepared: 0, uploads: 0, plan };
			if (plan.downloads > 0) {
				this.reportProgress({ operation: "download", completedFiles: 0, totalFiles: plan.downloads });
			} else if (plan.uploads > 0) {
				this.reportProgress({ operation: "prepare", completedFiles: 0, totalFiles: plan.uploads });
			}
			this.preparedBlockCacheEnabled = Platform.isDesktop;

			this.pendingStateMayBeStale = true;
			await this.measurePhase("reconcile files", async () => {
				await this.pull(changes, "", this.nodeRoot, remoteRoot);
			});
			await this.setLocalHeadAsync(remoteHead);

			this.status.progress = undefined;
			this.status.message = "upload";
			const newHead = await this.measurePhase("push changes", async () => await this.push(this.nodeRoot, changes, this.localHead!));
			await this.setLocalHeadAsync(newHead);
			this.pendingStateMayBeStale = false;

			if (SyncNode.dataLogCount > 100) {
				this.reportProgress({ operation: "compact-state", completedItems: 0, totalItems: 1 });
				await this.measurePhase("compact local sync state", async () => { await SyncNode.save(this.nodeRoot); });
				this.reportProgress({ operation: "compact-state", completedItems: 1, totalItems: 1 });
			}
			if (await this.loadLocalLibraryPolicy()) {
				await this.updateManagedIgnoreRules();
				this.nodeRoot.markTreeDirty();
				this.syncRequested = true;
			}
		} finally {
			this.progressCounts = null;
			this.directoryFsCache.clear();
			this.conflictMergeCache.clear();
			this.clearLocalSnapshot();
			this.preparedBlockCacheEnabled = false;
			this.clearPreparedBlocks();
			this.finishMetrics();
		}
	}

	private timeoutId: number;

	// Consecutive sync() failures. A single transient error (dropped connection,
	// server hiccup) should not require the user to notice a Notice and manually
	// click "resume" -- retry with backoff instead, and only give up for real
	// after several failures in a row.
	private consecutiveFailures = 0;
	private syncRequested = false;
	private static readonly MAX_CONSECUTIVE_FAILURES = 5;
	private static readonly MAX_BACKOFF_MS = 5 * 60 * 1000;

	private _status: SyncStatus = { type: "stop" };
	private readonly statusListeners = new Set<(status: SyncStatus) => void>();
	public get status () { return this._status; }
	private emitStatus(status: SyncStatus): void {
		for (const listener of this.statusListeners) listener(status);
	}
	private set status (value) {
		this._status = new Proxy<SyncStatus>(value, {
			set: (target, prop, value) => {
				Reflect.set(target, prop, value);
				this.emitStatus(target);
				return true;
			}
		});
		this.emitStatus(value);
	}

	public onRepositoryUnavailable: (() => void) | null = null;
	public subscribeStatus(listener: (status: SyncStatus) => void): () => void {
		this.statusListeners.add(listener);
		listener(this.status);
		return () => this.statusListeners.delete(listener);
	}

	public getKnownRemoteHead(): string {
		return this.localHead ?? "";
	}

	public isLocallySynchronized(): boolean {
		return this.status.type === "idle" && this.nodeRoot?.state.type === "sync";
	}

	public async verifyVault(): Promise<VaultVerificationReport> {
		if (this.status.type === "busy") throw new Error("Wait for the current synchronization to finish before verifying the vault.");
		if (!this.nodeRoot || this.localHead === undefined) throw new Error("Sync controller is not initialized.");
		this.directoryFsCache.clear();
		this.conflictMergeCache.clear();
		this.clearLocalSnapshot();
		try {
			const [remoteHead, permission] = await Promise.all([server.getHeadCommitId(), server.getRepoPermission()]);
			const remoteRoot = await server.getCommitRoot(remoteHead);
			await this.bootstrapLibraryPolicyFile(remoteRoot);
			await this.bootstrapIgnoreFile(remoteRoot);
			const plan = await this.planSync("", this.nodeRoot, remoteRoot);
			return {
				remoteHead,
				knownLocalHead: this.localHead,
				repositoryPermission: permission,
				trackedFiles: this.countTrackedFiles(),
				downloads: plan.downloads,
				uploads: plan.uploads,
				localDeletions: plan.localDeletions,
				remoteDeletions: plan.remoteDeletions,
				pathIssues: plan.pathIssues,
				indexHealthy: !!this.nodeRoot.prev && !!this.localHead
			};
		} finally {
			this.directoryFsCache.clear();
			this.conflictMergeCache.clear();
			this.clearLocalSnapshot();
		}
	}

	public async rebuildSyncIndex(): Promise<void> {
		await this.resetForRepositoryChange();
	}

	public async waitUntilIdle(timeoutMs = 5 * 60 * 1000): Promise<void> {
		if (this.status.type === "idle") return;
		if (this.status.type === "stop") throw new Error("Synchronization is stopped.");
		await new Promise<void>((resolve, reject) => {
			const timeout = window.setTimeout(() => {
				unsubscribe();
				reject(new Error("Timed out waiting for synchronization to finish."));
			}, timeoutMs);
			const unsubscribe = this.subscribeStatus(status => {
				if (status.type === "idle") {
					window.clearTimeout(timeout);
					unsubscribe();
					resolve();
				} else if (status.type === "stop") {
					window.clearTimeout(timeout);
					unsubscribe();
					reject(new Error(status.error ?? "Synchronization stopped."));
				}
			});
		});
	}

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

	requestSync(): void {
		if (this.status.type === "busy") {
			this.syncRequested = true;
			return;
		}
		if (this.status.type === "idle") this.startSync();
	}

	async syncCycle () {
		if (this.status.type == "idle") {
			this.status = { type: "busy" };

			debug.time("Sync");
			let failed = false;
			let failureMessage: string | undefined;
			try {
				await this.sync();
				this.consecutiveFailures = 0;
			} catch (e) {
				failed = true;
				failureMessage = e instanceof Error ? e.message : String(e);
				debug.error(e);
				const issue: SyncIssueInput = {
					kind: e instanceof SyncSafetyInterlockError ? "safety" : e instanceof SyncPreflightError ? "preflight" : "error",
					message: failureMessage ?? "Unknown sync error",
					action: e instanceof LibraryPolicyError ? "repair-library-policy" : undefined
				};
				const reportImmediately = e instanceof RepositoryUnavailableError
					|| e instanceof SyncSafetyInterlockError
					|| e instanceof SyncPreflightError;
				if (reportImmediately && shouldSurfaceSyncIssue(issue)) this.onIssue?.(issue);

				if (e instanceof RepositoryUnavailableError) {
					this.status = { type: "stop", message: "repository-unavailable", error: e.message };
					this.onRepositoryUnavailable?.();
					new Notice(`${e.message} Local files were preserved. Choose another repository or restore access before resuming sync.`, 0);
				} else if (e instanceof SyncSafetyInterlockError) {
					this.status = { type: "stop", message: "safety", error: e.message };
					new Notice(e.message, 0);
				} else if (e instanceof SyncPreflightError) {
					this.status = { type: "stop", message: "preflight", error: e.message };
					new Notice(e.message, 0);
				} else {
					this.consecutiveFailures++;
				}

				if (this.status.type === "busy" && this.consecutiveFailures >= SyncController.MAX_CONSECUTIVE_FAILURES) {
					this.status = { type: "stop", message: "error" };
					if (!reportImmediately && shouldSurfaceSyncIssue(issue)) this.onIssue?.(issue);
					new Notice(`Sync failed after ${this.consecutiveFailures} attempts: ${(e as Error).message}`);
				} else if (this.status.type === "busy") {
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
					this.status = failed ? { type: "idle", error: failureMessage } : { type: "idle" };
					let delay = this.settings.interval;
					if (this.syncRequested) {
						delay = 0;
					} else if (failed) {
						delay = Math.min(this.settings.interval * (2 ** (this.consecutiveFailures - 1)), SyncController.MAX_BACKOFF_MS);
					}
					this.syncRequested = false;
					this.timeoutId = window.setTimeout(() => {
						void this.syncCycle();
					}, delay);
				}
			}
		}
	}

	async stopSyncAsync (): Promise<void> {
		this.syncRequested = false;
		if (this.status.type == "idle") {
			window.clearTimeout(this.timeoutId);
			this.status = { type: "stop" };
			debug.log("Sync stopped");
			await Promise.resolve();
		} else if (this.status.type == "busy") {
			this.status.toStop = true;
			debug.log("Sync stopping");
			await new Promise<void>(resolve => {
				let unsubscribe = () => {};
				unsubscribe = this.subscribeStatus(status => {
					if (status.type == "stop") {
						unsubscribe();
						resolve();
					}
				});
			});
		} else {
			await Promise.resolve();
		}
	}
}
