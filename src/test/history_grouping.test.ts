import { describe, expect, test } from "@jest/globals";
import { groupHistory, inferHistoryOperation } from "../history/grouping";
import type { LibraryRevision } from "../history/types";

function revision(commitId: string, createdAt: number, description: string, deviceName = "laptop"): LibraryRevision {
	return {
		commitId, createdAt, description, deviceName,
		authorName: "Alex", authorEmail: "alex@example.test", clientVersion: "plugin", tags: []
	};
}

describe("history grouping", () => {
	test("groups nearby activity from the same editor", () => {
		const groups = groupHistory([
			revision("a", 10 * 60_000, "Modified \"one.md\"."),
			revision("b", 8 * 60_000, "Modified \"two.md\".")
		], 5);
		expect(groups).toHaveLength(1);
		expect(groups[0].paths).toEqual(["one.md", "two.md"]);
	});

	test("keeps devices and destructive boundaries separate", () => {
		const groups = groupHistory([
			revision("a", 10 * 60_000, "Modified \"one.md\"."),
			revision("b", 9 * 60_000, "Modified \"one.md\".", "phone"),
			revision("c", 8 * 60_000, "Deleted \"one.md\".", "phone"),
			revision("d", 7 * 60_000, "Modified \"two.md\".", "phone")
		], 5);
		expect(groups).toHaveLength(4);
	});

	test("classifies commit descriptions", () => {
		expect(inferHistoryOperation("Renamed \"old.md\" to \"new.md\".")).toBe("rename");
		expect(inferHistoryOperation("Added \"new.md\".\nDeleted \"old.md\".")).toBe("delete");
		expect(inferHistoryOperation("Restored library snapshot")).toBe("restore");
	});
});
