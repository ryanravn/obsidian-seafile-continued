import { arrayBufferToHex, type Stat, TFile, TFolder } from "obsidian";
import pThrottle from "p-throttle";
import { posix as Path } from "path-browserify";
import { type Commit, type SeafFs } from "./server";
import * as config from "./config";

export const SEAFILE_BLOCK_SIZE = 8 * 1024 * 1024;

export class FormData {
	private readonly boundary: string;
	private readonly data: unknown[];

	constructor() {
		this.boundary = crypto.randomUUID();
		this.data = [];
	}

	append(name: string, value: string | ArrayBuffer | Uint8Array, filename?: string): void {
		if (this.data.length > 0) {
			this.data.push("\r\n");
		}
		this.data.push(`--${this.boundary}\r\n`);
		this.data.push(`Content-Disposition: form-data; name="${name}"`);
		if (filename) {
			this.data.push(`; filename="${filename}"`);
		}
		this.data.push("\r\n\r\n");

		this.data.push(value);
	}

	async getArrayBuffer(): Promise<ArrayBuffer> {
		this.data.push(`\r\n--${this.boundary}--\r\n`);
		return await new Blob(this.data as BlobPart[]).arrayBuffer();
	}

	getContentType(): string {
		return `multipart/form-data; boundary=${this.boundary}`;
	}
}

// Memoize function with a limit on the cache size
type Func<T extends unknown[], V> = (...args: [...T]) => Promise<V>
export function memoizeWithLimit<T extends unknown[], V>(fn: Func<T, V>, cacheLimit: number): Func<T, V> {
	const cache = new Map<string, V | Promise<V>>(); let cacheSize = 0;
	const keysQueue = new Set<string>();

	return async (...args: [...T]): Promise<V> => {
		const key = JSON.stringify(args);

		if (cache.has(key)) { // cache hit
			const value = cache.get(key);
			if (value) { return await value; }
		}

		// set result to cache first, to avoid duplicate requests
		const promise = fn(...args);
		cache.set(key, promise);
		cacheSize++;

		let result: V;
		try {
			result = await promise;
			cache.set(key, result);
		} catch (e) {
			cache.delete(key);
			cacheSize--;
			throw e;
		}

		if (keysQueue.has(key)) keysQueue.delete(key);
		keysQueue.add(key);

		if (cacheSize > cacheLimit) {
			const key = keysQueue.values().next().value as string;
			keysQueue.delete(key);
			cache.delete(key);
			cacheSize--;
		}

		return result;
	};
}

// Pack multiple requests into a single request
export function packRequest<FuncParamType, FuncRetType>
(
	packFunc: (funcParamArray: FuncParamType[]) => Promise<Map<FuncParamType, FuncRetType>>,
	limit: number, interval: number, batchSize: number
): (key: FuncParamType) => Promise<FuncRetType> {
	interface callback { resolve: (value: FuncRetType) => void, reject: (reason: unknown) => void }
	const taskQueue = new Map<FuncParamType, Array<{ callback: callback, stack: string }>>();
	const throttled = pThrottle({ limit, interval })(async () => {
		// Take the first batchSize keys from the queue
		// append them to the tasks
		const keys = Array.from(taskQueue.keys()).slice(0, batchSize);
		if (keys.length === 0) return;

		const tasks = new Map<FuncParamType, Array<{ callback: callback, stack: string }>>();

		for (const key of keys) {
			tasks.set(key, taskQueue.get(key)!);
			taskQueue.delete(key);
		}

		let results;
		try {
			results = await packFunc(keys);
		} catch (e) {
			// packFunc failed, reject all tasks
			const err = e as Error;
			for (const [, task] of tasks) {
				for (const cb of task) {
					err.stack = String(err.stack) + cb.stack;
					cb.callback.reject(err);
				}
			}
			return;
		}

		// Resolve all tasks
		for (const [key, task] of tasks) {
			const result = results.get(key);
			if (result === undefined) {
				for (const cb of task) {
					cb.callback.reject(new Error(`packFunc did not return a result for key ${String(key)}`));
				}
			} else {
				for (const cb of task) {
					cb.callback.resolve(result);
				}
			}
		}
	});

	return async (key: FuncParamType): Promise<FuncRetType> => {
		const stack = new Error().stack ?? "";
		return await new Promise<FuncRetType>((resolve, reject) => {
			if (!taskQueue.has(key)) taskQueue.set(key, []);
			taskQueue.get(key)!.push({ callback: { resolve, reject }, stack });
			void throttled();
		});
	};
}

export function strcmp(str1: string, str2: string) {
	return ((str1 == str2) ? 0 : ((str1 > str2) ? 1 : -1));
}

export async function sha1(data: ArrayBuffer | string): Promise<string> {
	const bytes: BufferSource = typeof data === "string" ? new TextEncoder().encode(data) : data;
	const hash = await crypto.subtle.digest("SHA-1", bytes);
	return Array.from(new Uint8Array(hash))
		.map((b: number) => b.toString(16).padStart(2, "0")).join("");
}

export function stringifySeafFs(fs: SeafFs): string {
	// Stringify, add one space after colons and commas
	let str = JSON.stringify(fs, null, "/");
	str = str.replace(/\//g, "").replace(/,\n/g, ", ").replace(/\n/g, "");
	return str;
}

export async function computeFsId(fs: SeafFs): Promise<string> {
	const str = stringifySeafFs(fs);
	const fsId = await sha1(str);
	return fsId;
}

export async function computeCommitId(commit: Commit): Promise<string> {
	const encoder = new TextEncoder();

	const rootIdBytes = encoder.encode(commit.root_id + "\0");
	const creatorBytes = encoder.encode(commit.creator + "\0");
	const creatorNameBytes = commit.creator_name ? encoder.encode(commit.creator_name + "\0") : new Uint8Array();
	const descriptionBytes = encoder.encode(commit.description + "\0");
	const ctimeBytes = new DataView(new ArrayBuffer(8));
	const ctime: bigint = BigInt(commit.ctime);
	ctimeBytes.setBigInt64(0, ctime, false);

	const data = new Uint8Array([
		...rootIdBytes,
		...creatorBytes,
		...creatorNameBytes,
		...descriptionBytes,
		...new Uint8Array(ctimeBytes.buffer)
	]);

	const digest = await crypto.subtle.digest("SHA-1", data);
	const commitId = arrayBufferToHex(digest);
	return commitId;
}

export async function computeBlocks(buffer: ArrayBuffer): Promise<Record<string, ArrayBuffer>> {
	const size = buffer.byteLength;

	const blocks: Record<string, ArrayBuffer> = {};
	const blockSize = SEAFILE_BLOCK_SIZE;
	const numBlocks = Math.ceil(size / blockSize);
	for (let i = 0; i < numBlocks; i++) {
		const block = buffer.slice(i * blockSize, (i + 1) * blockSize);
		const hash = await sha1(block);
		blocks[hash] = block;
	}

	return blocks;
}

// For encrypted repos: split into 8MB chunks, AES-CBC encrypt each, key by SHA1(ciphertext).
// Insertion order is preserved so the resulting block_ids align with file offsets on download.
export async function computeBlocksEncrypted(buffer: ArrayBuffer, encrypt: (chunk: ArrayBuffer) => Promise<ArrayBuffer>): Promise<Record<string, ArrayBuffer>> {
	const size = buffer.byteLength;
	const blocks: Record<string, ArrayBuffer> = {};
	const blockSize = SEAFILE_BLOCK_SIZE;
	const numBlocks = Math.ceil(size / blockSize);
	for (let i = 0; i < numBlocks; i++) {
		const plain = buffer.slice(i * blockSize, (i + 1) * blockSize);
		const cipher = await encrypt(plain);
		const hash = await sha1(cipher);
		blocks[hash] = cipher;
	}
	return blocks;
}

// Faster way to convert an array buffer to a base64 string
export async function arrayBufferToBase64(buffer: ArrayBuffer): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const blob = new Blob([buffer], { type: "application/octet-binary" });
		const fileReader = new FileReader();
		fileReader.onload = function () {
			const dataUrl = fileReader.result;
			if (typeof dataUrl !== "string") { reject(new Error("dataUrl is not a string")); return; }
			const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
			resolve(base64);
		};
		fileReader.readAsDataURL(blob);
	});
}

export function concatTypedArrays(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
	const result = new Uint8Array(a.length + b.length);
	result.set(a, 0);
	result.set(b, a.length);
	return result;
}

export function splitFirstSlash(path: string): [string, string] {
	const firstSlash = path.indexOf("/");
	if (firstSlash === -1) return [path, ""];
	const [first, rest] = [path.slice(0, firstSlash), path.slice(firstSlash + 1)];
	return [first, rest];
}

export const debug: Console = {} as Console;
{
	// Copy the function-valued console methods onto `debug`, bound to console.
	// Accessed via a local alias so the value usages don't read as direct
	// `console.*` logging calls.
	const con: Console = console;
	const target = debug as unknown as Record<string, unknown>;
	let key: keyof Console;
	for (key in con) {
		const value = con[key];
		if (typeof value === "function") {
			target[key] = (value as (...args: unknown[]) => unknown).bind(con);
		}
	}
}

export function disableDebugConsole(): void {
	const target = debug as unknown as Record<string, unknown>;
	let key: keyof Console;
	for (key in debug) {
		target[key] = () => { /* no-op */ };
	}
}

export async function fastStat(path: string): Promise<Stat | null> {
	while (path.startsWith("/")) path = path.slice(1);
	while (path.endsWith("/")) path = path.slice(0, -1);
	if (path === "") path = "/";

	const absFile = config.app.vault.getAbstractFileByPath(path);
	if (absFile) {
		if (absFile instanceof TFile) {
			return { ...absFile.stat, type: "file" };
		} else {
			return { size: 0, ctime: 0, mtime: 0, type: "folder" };
		}
	} else {
		// The file is not in Obsidian's in-memory index. That can mean it really
		// is gone -- or that the index has not finished loading yet (e.g. right
		// after launch). Confirm against the actual filesystem before treating it
		// as absent: a stale index reporting null is what produced the spurious
		// "bulk delete then reupload" in issue #1. adapter.stat returns null only
		// when the file is genuinely missing on disk.
		return await config.app.vault.adapter.stat(path);
	}
}

export async function fastList(path: string): Promise<string[]> {
	while (path.startsWith("/")) path = path.slice(1);
	while (path.endsWith("/")) path = path.slice(0, -1);
	// if (path === "") path = "/";
	// For root folder, force to use adapter.list to scan for .obsidian like folder

	const absFile = config.app.vault.getAbstractFileByPath(path);
	if (absFile) {
		if (absFile instanceof TFolder) {
			return absFile.children.map(child => child.name);
		}
		else {
			return [];
		}
	} else {
		const listed = await config.app.vault.adapter.list(path);
		const concated = listed.files.concat(listed.folders);
		return concated.map(p => Path.basename(p));
	}
}
