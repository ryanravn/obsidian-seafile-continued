import { describe, expect, test } from "@jest/globals";
import { mergeFileContents } from "../sync/merge";

describe("three-way synchronization merges", () => {
	test("combines independent Markdown edits", () => {
		const result = mergeFileContents(
			"markdown",
			"title\nfirst\nsecond\n",
			"new title\nfirst\nsecond\n",
			"title\nfirst\nnew second\n"
		);
		expect(result).toEqual({ status: "merged", content: "new title\nfirst\nnew second\n" });
	});

	test("rejects overlapping text edits", () => {
		const result = mergeFileContents("text", "same\n", "local\n", "remote\n");
		expect(result).toMatchObject({ status: "conflict" });
	});

	test("recursively merges independent settings keys and deletions", () => {
		const result = mergeFileContents(
			"json-object",
			"{\n  \"editor\": { \"lineNumbers\": false, \"width\": 80 },\n  \"obsolete\": true\n}\n",
			"{\n  \"editor\": { \"lineNumbers\": true, \"width\": 80 }\n}\n",
			"{\n  \"editor\": { \"lineNumbers\": false, \"width\": 100 },\n  \"obsolete\": true\n}\n"
		);
		expect(result.status).toBe("merged");
		if (result.status !== "merged") return;
		expect(JSON.parse(result.content)).toEqual({ editor: { lineNumbers: true, width: 100 } });
		expect(result.content.endsWith("\n")).toBe(true);
	});

	test("does not guess when both devices change the same JSON key", () => {
		const result = mergeFileContents("json-object", "{\"theme\":\"base\"}", "{\"theme\":\"light\"}", "{\"theme\":\"dark\"}");
		expect(result).toMatchObject({ status: "conflict", reason: expect.stringContaining("$.theme") });
	});

	test("merges Canvas records by stable IDs", () => {
		const base = JSON.stringify({ nodes: [{ id: "a", text: "A", x: 0 }, { id: "b", text: "B", x: 0 }] });
		const local = JSON.stringify({ nodes: [{ id: "a", text: "local", x: 0 }, { id: "b", text: "B", x: 0 }] });
		const remote = JSON.stringify({ nodes: [{ id: "a", text: "A", x: 0 }, { id: "b", text: "B", x: 10 }] });
		const result = mergeFileContents("structured-json", base, local, remote);
		expect(result.status).toBe("merged");
		if (result.status !== "merged") return;
		expect(JSON.parse(result.content)).toEqual({
			nodes: [{ id: "a", text: "local", x: 0 }, { id: "b", text: "B", x: 10 }]
		});
	});

	test("merges Bases views by stable names", () => {
		const base = "views:\n  - name: Books\n    type: table\n    limit: 10\n  - name: Cards\n    type: cards\n    limit: 20\n";
		const local = "views:\n  - name: Books\n    type: table\n    limit: 50\n  - name: Cards\n    type: cards\n    limit: 20\n";
		const remote = "views:\n  - name: Books\n    type: table\n    limit: 10\n  - name: Cards\n    type: cards\n    limit: 30\n";
		const result = mergeFileContents("structured-yaml", base, local, remote);
		expect(result.status).toBe("merged");
		if (result.status !== "merged") return;
		expect(result.content).toContain("limit: 50");
		expect(result.content).toContain("limit: 30");
	});

	test("uses the unchanged side without manufacturing a merge", () => {
		expect(mergeFileContents("markdown", "base", "base", "remote")).toEqual({ status: "remote", content: "remote" });
		expect(mergeFileContents("markdown", "base", "local", "base")).toEqual({ status: "local", content: "local" });
	});
});
