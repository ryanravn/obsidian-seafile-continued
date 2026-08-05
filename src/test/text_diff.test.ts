import { expect, test } from "@jest/globals";
import { createLineDiff } from "../history/text_diff";

test("creates a stable line-oriented history diff", () => {
	expect(createLineDiff("one\ntwo", "one\nthree")).toEqual([
		{ type: "same", text: "one" },
		{ type: "add", text: "three" },
		{ type: "remove", text: "two" }
	]);
});
