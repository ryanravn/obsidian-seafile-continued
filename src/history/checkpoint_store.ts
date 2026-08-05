import { arrayBufferToHex, type App, type DataAdapter } from "obsidian";
import type { SeafileSettings } from "../settings";
import type { LocalCheckpoint } from "./types";

interface CheckpointIndex {
	version: 1
	checkpoints: LocalCheckpoint[]
}

export class LocalCheckpointStore {
	private readonly root: string;
	private readonly objectsRoot: string;
	private readonly indexPath: string;
	private readonly timers = new Map<string, number>();
	private index: CheckpointIndex | null = null;

	constructor(
		private readonly app: App,
		private readonly adapter: DataAdapter,
		private readonly settings: SeafileSettings,
		pluginId: string,
		private readonly getRemoteHead: () => string
	) {
		this.root = `${app.vault.configDir}/plugins/${pluginId}/history`;
		this.objectsRoot = `${this.root}/objects`;
		this.indexPath = `${this.root}/index.json`;
	}

	schedule(path: string): void {
		if (!this.settings.localHistoryEnabled || !this.isSupported(path)) return;
		// Throttle instead of debounce: long editing sessions should still receive
		// periodic recovery points even when changes never become quiet.
		if (this.timers.has(path)) return;
		const delay = Math.max(1, this.settings.localHistoryIntervalMinutes) * 60 * 1000;
		this.timers.set(path, window.setTimeout(() => {
			this.timers.delete(path);
			void this.capture(path);
		}, delay));
	}

	dispose(): void {
		for (const timer of this.timers.values()) window.clearTimeout(timer);
		this.timers.clear();
	}

	async capture(path: string, force = false): Promise<LocalCheckpoint | null> {
		if ((!this.settings.localHistoryEnabled && !force) || !this.isSupported(path) || !await this.adapter.exists(path)) return null;
		const data = await this.adapter.readBinary(path);
		const objectId = arrayBufferToHex(await crypto.subtle.digest("SHA-256", data));
		await this.ensureLoaded();
		await this.ensureDirectories();
		const objectPath = `${this.objectsRoot}/${objectId}`;
		if (!await this.adapter.exists(objectPath)) await this.adapter.writeBinary(objectPath, data);

		const latest = this.index!.checkpoints.find(checkpoint => checkpoint.path === path);
		if (latest?.objectId === objectId) return latest;
		const checkpoint: LocalCheckpoint = {
			id: `${Date.now()}-${objectId.slice(0, 12)}`,
			path,
			createdAt: Date.now(),
			objectId,
			size: data.byteLength,
			baseRemoteHead: this.getRemoteHead()
		};
		this.index!.checkpoints.unshift(checkpoint);
		await this.prune();
		await this.saveIndex();
		return checkpoint;
	}

	async list(path?: string): Promise<LocalCheckpoint[]> {
		await this.ensureLoaded();
		return this.index!.checkpoints.filter(checkpoint => path === undefined || checkpoint.path === path).map(checkpoint => ({ ...checkpoint }));
	}

	async read(checkpoint: LocalCheckpoint): Promise<ArrayBuffer> {
		if (!/^[a-f0-9]{64}$/i.test(checkpoint.objectId)) throw new Error("Local checkpoint object identifier is invalid.");
		return await this.adapter.readBinary(`${this.objectsRoot}/${checkpoint.objectId}`);
	}

	async markPublished(checkpointId: string, commitId: string): Promise<void> {
		await this.ensureLoaded();
		const checkpoint = this.index!.checkpoints.find(item => item.id === checkpointId);
		if (!checkpoint) throw new Error("Local checkpoint no longer exists.");
		checkpoint.publishedCommitId = commitId;
		await this.saveIndex();
	}

	async clear(): Promise<void> {
		this.dispose();
		if (await this.adapter.exists(this.root)) await this.adapter.rmdir(this.root, true);
		this.index = { version: 1, checkpoints: [] };
	}

	async getStorageBytes(): Promise<number> {
		await this.ensureLoaded();
		const unique = new Map<string, number>();
		for (const checkpoint of this.index!.checkpoints) unique.set(checkpoint.objectId, checkpoint.size);
		return Array.from(unique.values()).reduce((total, size) => total + size, 0);
	}

	private isSupported(path: string): boolean {
		if (path.startsWith("/") || path.split("/").includes("..")) return false;
		const normalized = path.toLowerCase();
		return normalized.endsWith(".md") || normalized.endsWith(".canvas");
	}

	private async ensureDirectories(): Promise<void> {
		if (!await this.adapter.exists(this.root)) await this.adapter.mkdir(this.root);
		if (!await this.adapter.exists(this.objectsRoot)) await this.adapter.mkdir(this.objectsRoot);
	}

	private async ensureLoaded(): Promise<void> {
		if (this.index) return;
		try {
			const parsed = JSON.parse(await this.adapter.read(this.indexPath)) as Partial<CheckpointIndex>;
			const checkpoints = Array.isArray(parsed.checkpoints)
				? parsed.checkpoints.filter((value): value is LocalCheckpoint => this.isValidCheckpoint(value))
				: [];
			this.index = { version: 1, checkpoints };
		} catch {
			this.index = { version: 1, checkpoints: [] };
		}
	}

	private isValidCheckpoint(value: unknown): value is LocalCheckpoint {
		if (!value || typeof value !== "object") return false;
		const item = value as Partial<LocalCheckpoint>;
		return typeof item.id === "string"
			&& typeof item.path === "string"
			&& this.isSupported(item.path)
			&& typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
			&& typeof item.objectId === "string" && /^[a-f0-9]{64}$/i.test(item.objectId)
			&& typeof item.size === "number" && Number.isFinite(item.size) && item.size >= 0
			&& typeof item.baseRemoteHead === "string"
			&& (item.publishedCommitId === undefined || typeof item.publishedCommitId === "string");
	}

	private async saveIndex(): Promise<void> {
		await this.ensureDirectories();
		await this.adapter.write(this.indexPath, JSON.stringify(this.index));
	}

	private async prune(): Promise<void> {
		const cutoff = Date.now() - Math.max(1, this.settings.localHistoryRetentionDays) * 24 * 60 * 60 * 1000;
		this.index!.checkpoints = this.index!.checkpoints.filter(checkpoint => checkpoint.createdAt >= cutoff);
		let bytes = await this.getStorageBytes();
		while (bytes > this.settings.localHistoryMaxBytes && this.index!.checkpoints.length > 0) {
			this.index!.checkpoints.pop();
			bytes = await this.getStorageBytes();
		}

		const referenced = new Set(this.index!.checkpoints.map(checkpoint => checkpoint.objectId));
		if (!await this.adapter.exists(this.objectsRoot)) return;
		for (const objectPath of (await this.adapter.list(this.objectsRoot)).files) {
			const objectId = objectPath.split("/").pop() ?? "";
			if (!referenced.has(objectId)) await this.adapter.remove(objectPath);
		}
	}
}
