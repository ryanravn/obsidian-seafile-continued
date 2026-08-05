import { describe, expect, jest, test } from "@jest/globals";
import { HistoryService } from "../history/service";
import { MODE_DIR, MODE_FILE, TYPE_DIR, TYPE_FILE, type DirSeafDirent, type SeafFsResult } from "../server";

describe("historical content and snapshots", () => {
	test("reads and verifies a file from an arbitrary commit", async () => {
		const root: DirSeafDirent = { id: "root", mode: MODE_DIR, mtime: 1, name: "" };
		const objects = new Map<string, SeafFsResult>([
			["root", ["root", { type: TYPE_DIR, version: 1, dirents: [{ id: "file", mode: MODE_FILE, mtime: 2, name: "note.md", size: 5, modifier: "Alex" }] }]],
			["file", ["file", { type: TYPE_FILE, version: 1, block_ids: ["block"], size: 5 }]]
		]);
		const server = {
			getCommitRoot: jest.fn(async () => root),
			getFs: jest.fn(async (id: string) => objects.get(id)!),
			getBlock: jest.fn(async () => new TextEncoder().encode("hello").buffer)
		};
		const history = new HistoryService(server as never);
		const file = await history.readFile("commit", "/note.md");
		expect(new TextDecoder().decode(file.content)).toBe("hello");
	});

	test("reads a deleted revision directly from its retained filesystem object", async () => {
		const server = {
			getCommitRoot: jest.fn(),
			getFs: jest.fn(async () => ["deleted-file", { type: TYPE_FILE, version: 1, block_ids: ["block"], size: 7 }] as SeafFsResult),
			getBlock: jest.fn(async () => new TextEncoder().encode("deleted").buffer)
		};
		const file = await new HistoryService(server as never).readRevision({
			commitId: "deletion-commit", path: "/gone.md", createdAt: 1_700_000_000_000,
			authorName: "Alex", authorEmail: "", description: "Deleted", size: 7, fileId: "deleted-file"
		});

		expect(new TextDecoder().decode(file.content)).toBe("deleted");
		expect(server.getCommitRoot).not.toHaveBeenCalled();
	});

	test("skips unchanged subtrees and reports changed paths", async () => {
		const roots: Record<string, DirSeafDirent> = {
			current: { id: "current-root", mode: MODE_DIR, mtime: 1, name: "" },
			target: { id: "target-root", mode: MODE_DIR, mtime: 1, name: "" }
		};
		const objects = new Map<string, SeafFsResult>([
			["current-root", ["current-root", { type: TYPE_DIR, version: 1, dirents: [
				{ id: "same-dir", mode: MODE_DIR, mtime: 1, name: "same" },
				{ id: "old", mode: MODE_FILE, mtime: 1, name: "changed.md", size: 1, modifier: "A" }
			] }]],
			["target-root", ["target-root", { type: TYPE_DIR, version: 1, dirents: [
				{ id: "same-dir", mode: MODE_DIR, mtime: 1, name: "same" },
				{ id: "new", mode: MODE_FILE, mtime: 2, name: "changed.md", size: 1, modifier: "A" },
				{ id: "added", mode: MODE_FILE, mtime: 2, name: "added.md", size: 1, modifier: "A" }
			] }]]
		]);
		const server = {
			getCommitRoot: jest.fn(async (id: string) => roots[id]),
			getFs: jest.fn(async (id: string) => objects.get(id)!),
			getBlock: jest.fn()
		};
		const diff = await new HistoryService(server as never).compareSnapshots("current", "target");
		expect(diff.modifiedFiles).toEqual(["/changed.md"]);
		expect(diff.addedFiles).toEqual(["/added.md"]);
		expect(server.getFs).not.toHaveBeenCalledWith("same-dir");
	});
});
