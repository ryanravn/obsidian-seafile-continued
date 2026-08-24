import { expect, test } from "@jest/globals";
import { compactLineDiff, createLineDiff, createLineDiffResult, groupDiffLines } from "../history/text_diff";

test("creates a stable line-oriented history diff", () => {
	expect(createLineDiff("one\ntwo", "one\nthree")).toEqual([
		{ type: "same", text: "one" },
		{ type: "add", text: "three" },
		{ type: "remove", text: "two" }
	]);
});

test("reports exact line statistics and handles empty files", () => {
	expect(createLineDiffResult("", "one\ntwo")).toMatchObject({ additions: 2, deletions: 0, truncated: false });
	expect(createLineDiffResult("one\ntwo", "one\nthree")).toMatchObject({ additions: 1, deletions: 1, truncated: false });
});

test("uses a scalable exact fallback for larger files", () => {
	const result = createLineDiffResult("one\ntwo", "three\nfour", 3);
	expect(result).toMatchObject({ additions: 2, deletions: 2, truncated: false });
	expect(result.lines.filter(line => line.type === "remove").map(line => line.text)).toEqual(["one", "two"]);
	expect(result.lines.filter(line => line.type === "add").map(line => line.text)).toEqual(["three", "four"]);
});

test("the scalable fallback reconstructs both large versions exactly", () => {
	const beforeLines = Array.from({ length: 800 }, (_, index) => `line ${index}`);
	const afterLines = [...beforeLines];
	afterLines[400] = "changed line";
	const result = createLineDiffResult(beforeLines.join("\n"), afterLines.join("\n"));

	expect(result.lines.filter(line => line.type !== "add").map(line => line.text)).toEqual(beforeLines);
	expect(result.lines.filter(line => line.type !== "remove").map(line => line.text)).toEqual(afterLines);
	expect(result).toMatchObject({ additions: 1, deletions: 1, truncated: false });
});

test("collapses unchanged regions while retaining context around edits", () => {
	const diff = createLineDiff(
		["top", "one", "two", "three", "four", "five", "six", "bottom"].join("\n"),
		["top", "one", "two", "three", "changed", "five", "six", "bottom"].join("\n")
	);
	expect(compactLineDiff(diff, 1)).toEqual([
		{ type: "same", text: "⋯ 3 unchanged lines" },
		{ type: "same", text: "three" },
		{ type: "add", text: "changed" },
		{ type: "remove", text: "four" },
		{ type: "same", text: "five" },
		{ type: "same", text: "⋯ 2 unchanged lines" }
	]);
});

test("groups adjacent lines for efficient rendering without losing content", () => {
	expect(groupDiffLines([
		{ type: "remove", text: "one" },
		{ type: "remove", text: "two" },
		{ type: "add", text: "three" }
	])).toEqual([
		{ type: "remove", lines: ["one", "two"] },
		{ type: "add", lines: ["three"] }
	]);
});
