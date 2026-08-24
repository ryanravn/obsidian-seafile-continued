import { describe, expect, test } from "@jest/globals";
import { findCaseCollisions, validatePathSegment } from "../sync/preflight";
import { massDeletionWarning } from "../sync/controller";
import { DEFAULT_SETTINGS } from "../settings";

describe("cross-platform path preflight", () => {
	test.each([
		["notes/question?.md", "character"],
		["notes/trailing.", "ends"],
		["notes/CON.md", "reserved"]
	])("rejects %s", (path, detail) => {
		expect(validatePathSegment(path)?.detail).toContain(detail);
	});

	test("allows ordinary vault paths", () => {
		expect(validatePathSegment("notes/Meeting 2026-08-05.md")).toBeNull();
	});

	test("detects sibling names that collide by case", () => {
		expect(findCaseCollisions("/notes", ["Readme.md", "README.md"])).toEqual([expect.objectContaining({
			kind: "case-collision",
			path: "/notes/README.md"
		})]);
	});
});

describe("mass-deletion safety threshold", () => {
	test("uses the absolute 500-file threshold", () => {
		expect(massDeletionWarning(DEFAULT_SETTINGS, "remote", 500, 10000)).toMatchObject({ deletions: 500 });
	});

	test("uses the percentage threshold after the minimum affected count", () => {
		expect(massDeletionWarning(DEFAULT_SETTINGS, "local", 25, 100)).toMatchObject({ percentage: 25 });
		expect(massDeletionWarning(DEFAULT_SETTINGS, "local", 10, 20)).toBeNull();
	});
});
