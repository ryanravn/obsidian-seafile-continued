import { describe, expect, test } from "@jest/globals";
import { formatHistoryText, historyTextDiffLimit, historyTextKind, isLikelyTextContent } from "../history/text_format";

describe("history text formatting", () => {
	test("recognizes Markdown and structured JSON history", () => {
		expect(historyTextKind("README.md")).toBe("markdown");
		expect(historyTextKind("data.json")).toBe("json");
		expect(historyTextKind("drawing.canvas")).toBe("json");
		expect(historyTextKind("archive.zip")).toBeNull();
		expect(historyTextDiffLimit("README.md")!).toBeGreaterThan(historyTextDiffLimit("data.json")!);
		expect(historyTextDiffLimit("calendar.ics")).not.toBeNull();
		expect(historyTextDiffLimit("notes.custom-format")).not.toBeNull();
		expect(historyTextDiffLimit("photo.png")).toBeNull();
	});

	test("normalizes JSON formatting and object key order before comparison", () => {
		const left = formatHistoryText("data.json", "{\"b\":2,\"a\":{\"z\":1,\"x\":0}}");
		const right = formatHistoryText("data.json", "{\n  \"a\": { \"x\": 0, \"z\": 1 },\n  \"b\": 2\n}");
		expect(left).toBe(right);
		expect(left).toContain("\n");
	});

	test("keeps invalid JSON available as a raw text diff", () => {
		expect(formatHistoryText("broken.json", "{not-json")).toBe("{not-json");
	});

	test("detects extensionless UTF-8 text without treating binary data as text", () => {
		expect(isLikelyTextContent(new TextEncoder().encode("BEGIN:VCALENDAR\nEND:VCALENDAR").buffer)).toBe(true);
		expect(isLikelyTextContent(new Uint8Array([0, 1, 2, 3]).buffer)).toBe(false);
	});
});
