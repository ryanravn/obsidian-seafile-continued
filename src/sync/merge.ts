import { createLineDiff, type DiffLine } from "../history/text_diff";
import { parseYaml, stringifyYaml } from "obsidian";

export type MergeStrategyName = "markdown" | "text" | "json-object" | "structured-json" | "structured-yaml" | "conflict-copy";

export type MergeResult = {
	status: "local" | "remote" | "merged"
	content: string
} | {
	status: "conflict"
	reason: string
};

const MISSING = Symbol("missing");
type MaybeMissing = unknown | typeof MISSING;

interface TextEdit {
	start: number
	end: number
	replacement: string[]
}

interface JsonMergeResult {
	ok: boolean
	value?: MaybeMissing
	conflictPath?: string
}

export function mergeFileContents(
	strategy: MergeStrategyName,
	base: string,
	local: string,
	remote: string
): MergeResult {
	if (local === remote) return { status: "local", content: local };
	if (local === base) return { status: "remote", content: remote };
	if (remote === base) return { status: "local", content: local };
	if (strategy === "conflict-copy") return { status: "conflict", reason: "This file type is not safe to merge automatically." };
	if (strategy === "json-object" || strategy === "structured-json") {
		return mergeJson(base, local, remote, strategy === "structured-json");
	}
	if (strategy === "structured-yaml") return mergeYaml(base, local, remote);
	return mergeText(base, local, remote);
}

function mergeText(base: string, local: string, remote: string): MergeResult {
	const baseLines = splitLines(base);
	const localEdits = diffToEdits(createLineDiff(base, local), baseLines.length);
	const remoteEdits = diffToEdits(createLineDiff(base, remote), baseLines.length);
	const combined: TextEdit[] = [];
	for (const edit of [...localEdits, ...remoteEdits]) {
		const identical = combined.find(candidate => sameEdit(candidate, edit));
		if (identical) continue;
		if (combined.some(candidate => editsConflict(candidate, edit))) {
			return { status: "conflict", reason: "Both devices changed the same lines." };
		}
		combined.push(edit);
	}
	combined.sort((left, right) => left.start - right.start || left.end - right.end);
	const output: string[] = [];
	let cursor = 0;
	for (const edit of combined) {
		output.push(...baseLines.slice(cursor, edit.start), ...edit.replacement);
		cursor = edit.end;
	}
	output.push(...baseLines.slice(cursor));
	return { status: "merged", content: output.join("\n") };
}

function splitLines(text: string): string[] {
	return text === "" ? [] : text.split("\n");
}

function diffToEdits(diff: DiffLine[], baseLineCount: number): TextEdit[] {
	const edits: TextEdit[] = [];
	let baseIndex = 0;
	let pending: TextEdit | null = null;
	const flush = (): void => {
		if (pending) edits.push(pending);
		pending = null;
	};
	for (const line of diff) {
		if (line.type === "same") {
			flush();
			baseIndex++;
			continue;
		}
		pending ??= { start: baseIndex, end: baseIndex, replacement: [] };
		if (line.type === "remove") {
			baseIndex++;
			pending.end = baseIndex;
		} else {
			pending.replacement.push(line.text);
		}
	}
	flush();
	if (baseIndex !== baseLineCount) throw new Error("Text diff did not consume the complete merge base.");
	return edits;
}

function sameEdit(left: TextEdit, right: TextEdit): boolean {
	return left.start === right.start && left.end === right.end
		&& left.replacement.length === right.replacement.length
		&& left.replacement.every((line, index) => line === right.replacement[index]);
}

function editsConflict(left: TextEdit, right: TextEdit): boolean {
	if (left.start === left.end && right.start === right.end) return left.start === right.start;
	return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

function mergeJson(baseText: string, localText: string, remoteText: string, structuredArrays: boolean): MergeResult {
	let base: unknown;
	let local: unknown;
	let remote: unknown;
	try {
		base = JSON.parse(baseText) as unknown;
		local = JSON.parse(localText) as unknown;
		remote = JSON.parse(remoteText) as unknown;
	} catch {
		return { status: "conflict", reason: "A JSON version could not be parsed." };
	}
	const result = mergeJsonValue(base, local, remote, "$", structuredArrays);
	if (!result.ok || result.value === MISSING) {
		return { status: "conflict", reason: `Both devices changed ${result.conflictPath ?? "the same JSON value"}.` };
	}
	return {
		status: "merged",
		content: formatJson(result.value, localText)
	};
}

function mergeYaml(baseText: string, localText: string, remoteText: string): MergeResult {
	let base: unknown;
	let local: unknown;
	let remote: unknown;
	try {
		base = parseYaml(baseText) as unknown;
		local = parseYaml(localText) as unknown;
		remote = parseYaml(remoteText) as unknown;
	} catch {
		return { status: "conflict", reason: "A Bases YAML version could not be parsed." };
	}
	const result = mergeJsonValue(base, local, remote, "$", true);
	if (!result.ok || result.value === MISSING) {
		return { status: "conflict", reason: `Both devices changed ${result.conflictPath ?? "the same Bases value"}.` };
	}
	const newline = localText.includes("\r\n") ? "\r\n" : "\n";
	const formatted = stringifyYaml(result.value).replace(/\n/g, newline);
	return { status: "merged", content: formatted.endsWith(newline) ? formatted : formatted + newline };
}

function mergeJsonValue(
	base: MaybeMissing,
	local: MaybeMissing,
	remote: MaybeMissing,
	path: string,
	structuredArrays: boolean
): JsonMergeResult {
	if (jsonEqual(local, remote)) return { ok: true, value: local };
	if (jsonEqual(local, base)) return { ok: true, value: remote };
	if (jsonEqual(remote, base)) return { ok: true, value: local };
	if (isPlainObject(local) && isPlainObject(remote) && (isPlainObject(base) || base === MISSING)) {
		const baseObject = base === MISSING ? {} : base;
		const keys = orderedKeys(baseObject, local, remote);
		const merged = Object.create(null) as Record<string, unknown>;
		for (const key of keys) {
			const child = mergeJsonValue(
				Object.prototype.hasOwnProperty.call(baseObject, key) ? baseObject[key] : MISSING,
				Object.prototype.hasOwnProperty.call(local, key) ? local[key] : MISSING,
				Object.prototype.hasOwnProperty.call(remote, key) ? remote[key] : MISSING,
				`${path}.${key}`,
				structuredArrays
			);
			if (!child.ok) return child;
			if (child.value !== MISSING) merged[key] = child.value;
		}
		return { ok: true, value: merged };
	}
	if (structuredArrays && Array.isArray(local) && Array.isArray(remote) && (Array.isArray(base) || base === MISSING)) {
		const merged = mergeKeyedArray(base === MISSING ? [] : base, local, remote, path, structuredArrays);
		if (merged) return merged;
	}
	return { ok: false, conflictPath: path };
}

function mergeKeyedArray(
	base: unknown[],
	local: unknown[],
	remote: unknown[],
	path: string,
	structuredArrays: boolean
): JsonMergeResult | null {
	const keyName = commonArrayKey(base, local, remote);
	if (!keyName) return null;
	const baseMap = arrayMap(base, keyName);
	const localMap = arrayMap(local, keyName);
	const remoteMap = arrayMap(remote, keyName);
	if (!baseMap || !localMap || !remoteMap) return null;
	const order = Array.from(new Set([...localMap.keys(), ...remoteMap.keys(), ...baseMap.keys()]));
	const merged: unknown[] = [];
	for (const key of order) {
		const child = mergeJsonValue(
			baseMap.get(key) ?? MISSING,
			localMap.get(key) ?? MISSING,
			remoteMap.get(key) ?? MISSING,
			`${path}[${keyName}=${JSON.stringify(key)}]`,
			structuredArrays
		);
		if (!child.ok) return child;
		if (child.value !== MISSING) merged.push(child.value);
	}
	return { ok: true, value: merged };
}

function commonArrayKey(...arrays: unknown[][]): "id" | "name" | null {
	const values = arrays.flat();
	if (values.length === 0) return null;
	for (const key of ["id", "name"] as const) {
		if (values.every(value => isPlainObject(value) && typeof value[key] === "string")) return key;
	}
	return null;
}

function arrayMap(values: unknown[], key: "id" | "name"): Map<string, unknown> | null {
	const result = new Map<string, unknown>();
	for (const value of values) {
		if (!isPlainObject(value) || typeof value[key] !== "string" || result.has(value[key])) return null;
		result.set(value[key], value);
	}
	return result;
}

function orderedKeys(...objects: Array<Record<string, unknown>>): string[] {
	return Array.from(new Set(objects.flatMap(object => Object.keys(object))));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}

function jsonEqual(left: MaybeMissing, right: MaybeMissing): boolean {
	if (left === MISSING || right === MISSING) return left === right;
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
	}
	if (isPlainObject(left) && isPlainObject(right)) {
		const leftKeys = Object.keys(left);
		const rightKeys = Object.keys(right);
		return leftKeys.length === rightKeys.length
			&& leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && jsonEqual(left[key], right[key]));
	}
	return false;
}

function formatJson(value: unknown, localText: string): string {
	const newline = localText.includes("\r\n") ? "\r\n" : "\n";
	const indentMatch = localText.match(/\n([\t ]+)\S/);
	const indent = indentMatch?.[1] ?? "  ";
	const trailingNewline = /\r?\n$/.test(localText);
	return JSON.stringify(value, null, indent).replace(/\n/g, newline) + (trailingNewline ? newline : "");
}
