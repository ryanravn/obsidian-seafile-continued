import { describe, expect, test } from "@jest/globals";
import { assertReviewedFileUnchanged, normalizeConflictPaths } from "../sync/conflict_resolution";

const file = { type: "file" as const, size: 10, ctime: 1, mtime: 2 };

describe("conflict resolution safety", () => {
	test("normalizes distinct current and preserved paths", () => {
		expect(normalizeConflictPaths("/folder/note.md", "/folder/note (SFConflict).md")).toEqual({
			currentPath: "folder/note.md",
			conflictPath: "folder/note (SFConflict).md"
		});
		expect(() => normalizeConflictPaths("note.md", "note.md")).toThrow("invalid");
	});

	test("rejects a file that changed after review", () => {
		expect(() => assertReviewedFileUnchanged("note.md", file, { ...file, mtime: 3 })).toThrow("changed while");
		expect(() => assertReviewedFileUnchanged("note.md", file, file)).not.toThrow();
		expect(() => assertReviewedFileUnchanged("note.md", null, null)).not.toThrow();
	});
});
