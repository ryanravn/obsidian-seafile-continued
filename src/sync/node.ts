import { adapter, SYNC_DATA_PATH, SYNC_DLOG_PATH } from "../config";
import { SeafDirent, SeafFs } from "../server";
import * as utils from "../utils";
import { debug } from "../utils";

export type STATE_DOWNLOAD = {
	type: "download",
	param: number
}
export type STATE_UPLOAD = {
	type: "upload",
	param: {
		progress: number,
		fs: SeafFs | null,
		source?: {
			path: string,
			size: number,
			mtime: number
		}
	}
}
export type STATE_SYNC = {
	type: "sync"
}
export type STATE_INIT = {
	type: "init"
}
export type STATE_DELETE = {
	type: "delete"
}

export type SyncState = STATE_INIT | STATE_DOWNLOAD | STATE_UPLOAD | STATE_SYNC | STATE_DELETE;

export type SyncStateChangedListener = (node: SyncNode) => void;
export type SyncStatesChangedListener = (nodes: SyncNode[]) => void;

export type SerializedSyncNode = {
	prev: SeafDirent | null,
	policyExcluded?: boolean,
	children: Record<string, SerializedSyncNode>
}

export type SerializedLogData = [string, SeafDirent | null, boolean?];

export class SyncNode {
	public static onStateChanged: SyncStateChangedListener | undefined;
	public static onStatesChanged: SyncStatesChangedListener | undefined;
	private static notificationBatchDepth = 0;
	private static readonly batchedNotifications = new Set<SyncNode>();
	private static _dataLogCount = 0;
	public static get dataLogCount() { return this._dataLogCount; }
	private static set dataLogCount(value: number) { this._dataLogCount = value; }

	public readonly path: string;
	private children: Record<string, SyncNode> = {};
	private _prev?: SeafDirent;
	public policyExcluded = false;
	public prevDirty = true; // prev means the last synced state
	public next?: SeafDirent;
	public nextDirty = true; // next means the pending upload state

	private constructor(
		public readonly name: string,
		public readonly parent?: SyncNode,
	) {
		this.path = this.parent ? this.parent.path + "/" + this.name : this.name;
		this.state = { type: "init" };
	}

	private _state: SyncState;
	get state(): SyncState {
		return this._state;
	}
	set state(value: SyncState) {
		this._state = new Proxy(value, {
			set: (target, prop, value) => {
				Reflect.set(target, prop, value);
				SyncNode.notifyStateChanged(this);
				return true;
			}
		});
		SyncNode.notifyStateChanged(this);
	}

	private static notifyStateChanged(node: SyncNode): void {
		if (this.notificationBatchDepth > 0) {
			this.batchedNotifications.add(node);
			return;
		}
		this.onStateChanged?.(node);
	}

	private static beginNotificationBatch(): void {
		this.notificationBatchDepth++;
	}

	private static endNotificationBatch(): void {
		this.notificationBatchDepth--;
		if (this.notificationBatchDepth !== 0 || this.batchedNotifications.size === 0) return;
		const nodes = Array.from(this.batchedNotifications);
		this.batchedNotifications.clear();
		if (this.onStatesChanged) this.onStatesChanged(nodes);
		else for (const node of nodes) this.onStateChanged?.(node);
	}

	public static serialize(node: SyncNode): SerializedSyncNode {
		const children: Record<string, SerializedSyncNode> = {};
		const entries: [string, SyncNode][] = Object.entries(node.children);
		for (const [name, child] of entries) {
			if (child.prev)
				children[name] = SyncNode.serialize(child);
		}
		return {
			prev: node.prev!,
			...(node.policyExcluded ? { policyExcluded: true } : {}),
			children: children
		};
	}

	public static async deserialize(name: string, data: SerializedSyncNode, parent?: SyncNode): Promise<SyncNode> {
		const node = new SyncNode(name, parent);
		node.prev = data.prev ?? undefined;
		node.policyExcluded = data.policyExcluded ?? false;
		parent?.addChild(node);

		const childEntries: [string, SerializedSyncNode][] = Object.entries(data.children);
		for (const [name, childData] of childEntries) {
			await this.deserialize(name, childData, node);
		}

		return node;
	}

	public static async load(): Promise<SyncNode> {
		let fullData = { prev: null, children: {} } as SerializedSyncNode;
		try {
			fullData = JSON.parse(await adapter.read(SYNC_DATA_PATH)) as SerializedSyncNode;
		} catch { /* empty */ }

		let logData = [] as string[];
		try {
			logData = (await adapter.read(SYNC_DLOG_PATH)).split("\n");
			this.dataLogCount = logData.length;
		} catch { /* empty */ }

		for (const line of logData) {
			if (!line.trim()) continue;
			try {
				const [rawPath, dirent, policyExcluded] = JSON.parse(line) as SerializedLogData;
				let path = rawPath;
				while (path.startsWith("/")) path = path.slice(1);
				const parts = path.split("/");
				const name = parts.pop()!;
				let base = fullData;
				for (const part of parts) {
					if (!Object.prototype.hasOwnProperty.call(base.children, part)) {
						base.children[part] = { prev: null, children: {} };
					}
					base = base.children[part];
				}
				if (dirent) {
					if (name === "") {
						base.prev = dirent;
						base.policyExcluded = policyExcluded ?? false;
					} else if (!Object.prototype.hasOwnProperty.call(base.children, name)) {
						base.children[name] = { prev: dirent, policyExcluded: policyExcluded ?? false, children: {} };
					} else {
						base.children[name].prev = dirent;
						base.children[name].policyExcluded = policyExcluded ?? false;
					}
				}
				else {
					if (name === "")
						base.prev = null;
					else if (Object.prototype.hasOwnProperty.call(base.children, name))
						delete base.children[name];
				}
			}
			catch (e) {
				debug.error(`Failed to parse log data: ${line}`, e);
				break;
			}
		}

		return await this.deserialize("", fullData);
	}

	public static async save(root: SyncNode) {
		const data = this.serialize(root);
		await adapter.write(SYNC_DATA_PATH, JSON.stringify(data));
		await adapter.write(SYNC_DLOG_PATH, "");
		SyncNode.dataLogCount = 0;
	}

	public static async applyNextBatch(nodes: SyncNode[], onProgress?: (completed: number) => void): Promise<void> {
		const changed = new Set<SyncNode>();
		const lines: string[] = [];
		for (const node of nodes) {
			const next = node.next;
			if (!(next?.id === node.prev?.id && next?.mtime === node.prev?.mtime)) {
				changed.add(node);
				lines.push(JSON.stringify([node.path, next ?? null] as SerializedLogData));
			}
		}
		if (lines.length > 0) {
			await adapter.append(SYNC_DLOG_PATH, lines.join("\n") + "\n");
			SyncNode.dataLogCount += lines.length;
		}

		this.beginNotificationBatch();
		try {
			let completed = 0;
			for (const node of nodes) {
				if (changed.has(node)) node.prev = node.next;
				node.policyExcluded = false;
				node.prevDirty = node.nextDirty;
				node.setNext(undefined, true);
				node.state = node.prevDirty ? { type: "init" } : { type: "sync" };
				onProgress?.(++completed);
			}
		} finally {
			this.endNotificationBatch();
		}
	}

	private async appendDataLog(dirent: SeafDirent | undefined | null) {
		if (!dirent) dirent = null;
		await adapter.append(SYNC_DLOG_PATH, JSON.stringify([this.path, dirent, this.policyExcluded || undefined] as SerializedLogData) + "\n");
		SyncNode.dataLogCount++;
	}

	exec(path: string, callback: (node: SyncNode) => boolean, order: "pre" | "post" = "pre", throwError = true): boolean {
		while (path.startsWith("/")) path = path.slice(1);

		let [first, rest] = utils.splitFirstSlash(path);
		while (!first && rest) {
			[first, rest] = utils.splitFirstSlash(rest);
		}

		if (order == "pre") {
			if (callback(this))
				return true;
		}
		if (first) {
			const child = this.children[first];
			if (!child) {
				if (throwError)
					throw new Error("Cannot find child " + first);
			}
			else {
				if (rest) {
					if (child.exec(rest, callback, order, throwError)) {
						return true;
					}
				}
				else {
					if (callback(child))
						return true;
				}
			}
		}
		if (order == "post") {
			if (callback(this))
				return true;
		}

		return false;
	}

	find(path: string): SyncNode | null {
		let found: SyncNode | null = null;
		try {
			this.exec(path, (node) => {
				found = node;
				return true;
			}, "post", true);
			return found;
		}
		catch {
			return null;
		}
	}

	setDirty(path: string) {
		this.exec(path, (node) => {
			node.prevDirty = true;
			if (node.next) {
				node.nextDirty = true;
			}
			else {
				node.state = { "type": "init" };
			}

			return false;
		}, "post", false);
	}

	private addChild(node: SyncNode) {
		this.children[node.name] = node;
	}

	createChild(name: string): SyncNode {
		const child = new SyncNode(name, this);
		this.addChild(child);
		return child;
	}



	removeChild(node: SyncNode) {
		if (Object.prototype.hasOwnProperty.call(this.children, node.name)) {
			delete this.children[node.name];
		}
	}

	clearChildren() {
		Object.keys(this.children).forEach((name) => {
			delete this.children[name];
		});
	}

	setNext(next?: SeafDirent, dirty = true) {
		this.next = next;
		this.nextDirty = dirty;
	}

	/** Discard computed upload state so the next cycle recomputes it from disk. */
	clearPendingTree() {
		this.next = undefined;
		this.nextDirty = true;
		if (this.state.type === "upload" || this.state.type === "download") {
			this.state = { type: "init" };
		}
		for (const child of Object.values(this.children)) child.clearPendingTree();
	}

	markTreeDirty(): void {
		this.prevDirty = true;
		if (this.next) this.nextDirty = true;
		if (this.state.type === "sync") this.state = { type: "init" };
		for (const child of Object.values(this.children)) child.markTreeDirty();
	}

	/** Accept the existing remote baseline after dropping a metadata-only upload. */
	discardPendingAsSynchronized() {
		this.next = undefined;
		this.nextDirty = true;
		this.prevDirty = false;
		this.state = this.prev ? { type: "sync" } : { type: "init" };
	}

	get prev(): SeafDirent | undefined {
		return this._prev;
	}

	private set prev(value: SeafDirent | undefined) {
		this._prev = value;
	}

	async setPrevAsync(prev?: SeafDirent, dirty = true) {
		if (!(prev?.id === this.prev?.id && prev?.mtime === this.prev?.mtime)) {
			await this.appendDataLog(prev);
			this.prev = prev;
		}
		this.prevDirty = dirty;
	}

	async setPolicyExcludedAsync(excluded: boolean): Promise<void> {
		if (this.policyExcluded === excluded) return;
		this.policyExcluded = excluded;
		await this.appendDataLog(this.prev);
	}

	async applyNext() {
		this.policyExcluded = false;
		await this.setPrevAsync(this.next, this.nextDirty);
		this.setNext(undefined, true);
		if (!this.prevDirty) {
			this.state = { "type": "sync" };
		}
		else {
			this.state = { "type": "init" };
		}
	}

	getChildren(): Record<string, SyncNode> {
		return this.children;
	}

	async delete() {
		this.setNext(undefined, true);
		this.policyExcluded = false;
		if (this.parent) {
			this.parent.removeChild(this);
		}
		await this.setPrevAsync(undefined, true);
		this.state = { "type": "delete" };
	}

	toJson(): DebugJson {
		const cjson: Record<string, DebugJson> = {};
		Object.entries(this.children).forEach(([name, node]: [string, SyncNode]) => {
			cjson[name] = node.toJson();
		});
		return {
			name: this.name,
			policyExcluded: this.policyExcluded,
			prevDirty: this.prevDirty,
			prev: this.prev,
			nextDirty: this.nextDirty,
			next: this.next,
			children: cjson
		};
	}
}

// Debug-only serialization (used by the manual integration test), kept
// separate from SerializedSyncNode which is the real on-disk format.
export interface DebugJson {
	name: string
	policyExcluded: boolean
	prevDirty: boolean
	prev?: SeafDirent
	nextDirty: boolean
	next?: SeafDirent
	children: Record<string, DebugJson>
}
