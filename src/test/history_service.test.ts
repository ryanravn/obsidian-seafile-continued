import { describe, expect, jest, test } from "@jest/globals";
import { HistoryService } from "../history/service";
import { MODE_DIR, MODE_FILE, TYPE_DIR, TYPE_FILE, type Commit, type DirSeafDirent, type SeafFsResult } from "../server";

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

	test("reads a deleted revision from the parent commit when trash metadata has no object id", async () => {
		const root: DirSeafDirent = { id: "parent-root", mode: MODE_DIR, mtime: 1, name: "" };
		const server = {
			getCommitInfo: jest.fn(async () => ({ parent_id: "parent-commit" })),
			getCommitRoot: jest.fn(async () => root),
			getFs: jest.fn(async (id: string): Promise<SeafFsResult> => {
				if (id === "parent-root") {
					return [id, { type: TYPE_DIR, version: 1, dirents: [{ id: "file", mode: MODE_FILE, mtime: 2, name: "gone.md", size: 4, modifier: "A" }] }];
				}
				return [id, { type: TYPE_FILE, version: 1, block_ids: ["block"], size: 4 }];
			}),
			getBlock: jest.fn(async () => new TextEncoder().encode("gone").buffer)
		};
		const file = await new HistoryService(server as never).readRevision({
			commitId: "deletion-commit", path: "/gone.md", createdAt: 1, authorName: "", authorEmail: "",
			description: "Deleted file", size: 4, fileId: "", deleted: true
		});

		expect(new TextDecoder().decode(file.content)).toBe("gone");
		expect(server.getCommitRoot).toHaveBeenCalledWith("parent-commit");
	});

	test("builds a deleted revision from an activity commit and its parent snapshot", async () => {
		const commit = {
			commit_id: "deletion-commit", parent_id: "parent-commit", root_id: "deleted-root", ctime: 20,
			creator_name: "9977c0c3@auth.local", creator: "device-id", description: "Deleted gone.md"
		};
		const server = {
			getCommitInfo: jest.fn(async () => commit),
			getCachedLibraryRevision: jest.fn(() => ({
				commitId: "deletion-commit", createdAt: 21_000, authorName: "Alex", authorEmail: "alex@example.com",
				description: "Deleted gone.md", clientVersion: "", deviceName: "", tags: []
			})),
			getCommitRoot: jest.fn(async () => ({ id: "parent-root", mode: MODE_DIR, mtime: 10, name: "" })),
			getFs: jest.fn(async (): Promise<SeafFsResult> => ["parent-root", {
				type: TYPE_DIR, version: 1,
				dirents: [{ id: "retained-file", mode: MODE_FILE, mtime: 10, name: "gone.md", size: 4, modifier: "Alex" }]
			}])
		};
		const revision = await new HistoryService(server as never).getDeletedRevision("deletion-commit", "/gone.md");

		expect(revision).toEqual({
			commitId: "deletion-commit", path: "/gone.md", createdAt: 21_000,
			authorName: "Alex", authorEmail: "alex@example.com", description: "Deleted gone.md",
			size: 4, fileId: "retained-file", deleted: true
		});
		expect(server.getCommitRoot).toHaveBeenCalledWith("parent-commit");
	});

	test("finds the latest retained version when a deleted path returns 404 at HEAD", async () => {
		const commit = (id: string, parentId: string, rootId: string, ctime: number): Commit => ({
			commit_id: id, parent_id: parentId, root_id: rootId, ctime,
			creator_name: "Alex", creator: "alex@example.com", description: `Commit ${id}`
		} as Commit);
		const commits: Record<string, Commit> = {
			head: commit("head", "deleted", "head-root", 40),
			deleted: commit("deleted", "retained", "deleted-root", 30),
			retained: commit("retained", "older", "retained-root", 20),
			older: commit("older", "", "older-root", 10)
		};
		const directory = (fileId?: string): SeafFsResult => ["", {
			type: TYPE_DIR, version: 1,
			dirents: fileId ? [{ id: fileId, mode: MODE_FILE, mtime: 20, name: "gone.md", size: 4, modifier: "Alex" }] : []
		}];
		const objects: Record<string, SeafFsResult> = {
			"head-root": directory(),
			"deleted-root": directory(),
			"retained-root": directory("retained-file"),
			"older-root": directory("older-file")
		};
		const server = {
			getHeadCommitId: jest.fn(async () => "head"),
			getCommitInfo: jest.fn(async (id: string) => commits[id]),
			getCachedLibraryRevision: jest.fn((id: string) => id === "deleted" ? {
				commitId: id, createdAt: 31_000, authorName: "Sam", authorEmail: "sam@example.com",
				description: "Deleted gone.md", clientVersion: "", deviceName: "", tags: []
			} : undefined),
			getCommitRoot: jest.fn(async (id: string) => ({
				id: commits[id].root_id, mode: MODE_DIR, mtime: commits[id].ctime, name: ""
			})),
			getFs: jest.fn(async (id: string) => objects[id])
		};

		await expect(new HistoryService(server as never).findRetainedDeletedRevision("/gone.md")).resolves.toEqual({
			commitId: "deleted", path: "/gone.md", createdAt: 31_000,
			authorName: "Sam", authorEmail: "sam@example.com", description: "Deleted gone.md",
			size: 4, fileId: "retained-file", deleted: true
		});
		expect(server.getCommitInfo).toHaveBeenCalledTimes(3);
	});

	test("does not treat a path that still exists at HEAD as deleted", async () => {
		const head = {
			commit_id: "head", parent_id: "", root_id: "head-root", ctime: 20,
			creator_name: "Alex", creator: "alex@example.com", description: "Current"
		} as Commit;
		const server = {
			getHeadCommitId: jest.fn(async () => "head"),
			getCommitInfo: jest.fn(async () => head),
			getCommitRoot: jest.fn(async () => ({ id: "head-root", mode: MODE_DIR, mtime: 20, name: "" })),
			getFs: jest.fn(async (): Promise<SeafFsResult> => ["head-root", {
				type: TYPE_DIR, version: 1,
				dirents: [{ id: "current-file", mode: MODE_FILE, mtime: 20, name: "note.md", size: 4, modifier: "Alex" }]
			}])
		};

		await expect(new HistoryService(server as never).findRetainedDeletedRevision("/note.md")).resolves.toBeNull();
	});

	test("derives deleted file versions from commit trees without the live-path history endpoint", async () => {
		const commit = (id: string, parentId: string, rootId: string, ctime: number): Commit => ({
			commit_id: id, parent_id: parentId, root_id: rootId, ctime,
			creator_name: "Alex", creator: "alex@example.com", description: `Commit ${id}`
		} as Commit);
		const commits: Record<string, Commit> = {
			deleted: commit("deleted", "newest", "deleted-root", 40),
			newest: commit("newest", "same", "newest-root", 30),
			same: commit("same", "older", "same-root", 20),
			older: commit("older", "before-creation", "older-root", 10),
			"before-creation": commit("before-creation", "", "empty-root", 1)
		};
		const directory = (fileId?: string, mtime = 1): SeafFsResult => ["", {
			type: TYPE_DIR, version: 1,
			dirents: fileId ? [{ id: fileId, mode: MODE_FILE, mtime, name: "gone.md", size: 4, modifier: "Alex" }] : []
		}];
		const objects: Record<string, SeafFsResult> = {
			"newest-root": directory("latest-file", 30),
			"same-root": directory("latest-file", 30),
			"older-root": directory("older-file", 10),
			"empty-root": directory()
		};
		const server = {
			getCommitInfo: jest.fn(async (id: string) => commits[id]),
			getCommitRoot: jest.fn(async (id: string) => ({ id: commits[id].root_id, mode: MODE_DIR, mtime: commits[id].ctime, name: "" })),
			getFs: jest.fn(async (id: string) => objects[id])
		};
		const page = await new HistoryService(server as never).getDeletedFileHistory({
			commitId: "deleted", path: "/gone.md", createdAt: 40_000, authorName: "Alex", authorEmail: "",
			description: "Deleted", size: 4, fileId: "latest-file", deleted: true
		});

		expect(page.nextCommit).toBeNull();
		expect(page.revisions).toEqual([expect.objectContaining({
			commitId: "older", fileId: "older-file", path: "/gone.md", createdAt: 10_000
		})]);
	});

	test("skips unchanged subtrees and reports changed paths", async () => {
		const roots: Record<string, DirSeafDirent> = {
			current: { id: "current-root", mode: MODE_DIR, mtime: 1, name: "" },
			target: { id: "target-root", mode: MODE_DIR, mtime: 1, name: "" }
		};
		const objects = new Map<string, SeafFsResult>([
			["current-root", ["current-root", { type: TYPE_DIR, version: 1, dirents: [
				{ id: "same-dir", mode: MODE_DIR, mtime: 1, name: "same" },
				{ id: "old", mode: MODE_FILE, mtime: 1, name: "changed.md", size: 1, modifier: "A" },
				{ id: "same-content", mode: MODE_FILE, mtime: 1, name: "metadata.md", size: 1, modifier: "A" }
			] }]],
			["target-root", ["target-root", { type: TYPE_DIR, version: 1, dirents: [
				{ id: "same-dir", mode: MODE_DIR, mtime: 1, name: "same" },
				{ id: "new", mode: MODE_FILE, mtime: 2, name: "changed.md", size: 1, modifier: "A" },
				{ id: "same-content", mode: MODE_FILE, mtime: 2, name: "metadata.md", size: 1, modifier: "A" },
				{ id: "added", mode: MODE_FILE, mtime: 2, name: "added.md", size: 1, modifier: "A" }
			] }]]
		]);
		const server = {
			getCommitRoot: jest.fn(async (id: string) => roots[id]),
			getFs: jest.fn(async (id: string) => objects.get(id)!),
			getBlock: jest.fn()
		};
		const diff = await new HistoryService(server as never).compareSnapshots("current", "target");
		expect(diff.modifiedFiles).toEqual(["/changed.md", "/metadata.md"]);
		expect(diff.modifiedFileChanges).toEqual([
			{
				path: "/changed.md", kind: "modified", contentChanged: true,
				metadataChanges: [{ field: "mtime", before: 1, after: 2 }]
			},
			{
				path: "/metadata.md", kind: "modified", contentChanged: false,
				metadataChanges: [{ field: "mtime", before: 1, after: 2 }]
			}
		]);
		expect(diff.addedFiles).toEqual(["/added.md"]);
		expect(server.getFs).not.toHaveBeenCalledWith("same-dir");
	});

	test("compares independent snapshot directories with bounded concurrency", async () => {
		const roots: Record<string, DirSeafDirent> = {
			current: { id: "current-root", mode: MODE_DIR, mtime: 1, name: "" },
			target: { id: "target-root", mode: MODE_DIR, mtime: 1, name: "" }
		};
		const directory = (prefix: string): SeafFsResult => [prefix, {
			type: TYPE_DIR,
			version: 1,
			dirents: Array.from({ length: 6 }, (_, index) => ({
				id: `${prefix}-${index}`,
				mode: MODE_DIR,
				mtime: 1,
				name: `folder-${index}`
			}))
		}];
		let active = 0;
		let maximumActive = 0;
		const server = {
			getCommitRoot: jest.fn(async (id: string) => roots[id]),
			getFs: jest.fn(async (id: string): Promise<SeafFsResult> => {
				active++;
				maximumActive = Math.max(maximumActive, active);
				await new Promise(resolve => setTimeout(resolve, 5));
				active--;
				if (id === "current-root" || id === "target-root") return directory(id);
				return [id, { type: TYPE_DIR, version: 1, dirents: [] }];
			})
		};

		await new HistoryService(server as never).compareSnapshots("current", "target");

		expect(maximumActive).toBeGreaterThan(2);
		expect(maximumActive).toBeLessThanOrEqual(8);
	});

	test("builds file-history entries only for metadata-only revisions", async () => {
		const roots: Record<string, DirSeafDirent> = {
			parent: { id: "parent-root", mode: MODE_DIR, mtime: 1, name: "" },
			metadata: { id: "metadata-root", mode: MODE_DIR, mtime: 2, name: "" },
			content: { id: "content-root", mode: MODE_DIR, mtime: 3, name: "" },
			create: { id: "create-root", mode: MODE_DIR, mtime: 4, name: "" },
			rename: { id: "rename-root", mode: MODE_DIR, mtime: 5, name: "" }
		};
		const objects = new Map<string, SeafFsResult>([
			["parent-root", ["parent-root", { type: TYPE_DIR, version: 1, dirents: [
				{ id: "same-file", mode: MODE_FILE, mtime: 1, name: "note.md", size: 4, modifier: "Alex" }
			] }]],
			["metadata-root", ["metadata-root", { type: TYPE_DIR, version: 1, dirents: [
				{ id: "same-file", mode: MODE_FILE, mtime: 2, name: "note.md", size: 4, modifier: "Sam" }
			] }]],
			["content-root", ["content-root", { type: TYPE_DIR, version: 1, dirents: [
				{ id: "new-file", mode: MODE_FILE, mtime: 3, name: "note.md", size: 4, modifier: "Sam" }
			] }]],
			["create-root", ["create-root", { type: TYPE_DIR, version: 1, dirents: [
				{ id: "created-file", mode: MODE_FILE, mtime: 4, name: "new.md", size: 4, modifier: "Sam" }
			] }]],
			["rename-root", ["rename-root", { type: TYPE_DIR, version: 1, dirents: [
				{ id: "same-file", mode: MODE_FILE, mtime: 5, name: "renamed.md", size: 4, modifier: "Sam" }
			] }]]
		]);
		const server = {
			getCommitInfo: jest.fn(async (id: string) => ({ parent_id: "parent", root_id: `${id}-root` })),
			getCommitRoot: jest.fn(async (id: string) => roots[id]),
			getFs: jest.fn(async (id: string) => objects.get(id)!)
		};
		const history = new HistoryService(server as never);
		const base = {
			createdAt: 2_000, authorName: "Sam", authorEmail: "sam@example.test",
			description: "Metadata update", clientVersion: "plugin", deviceName: "laptop", tags: []
		};

		await expect(history.scanFileMetadataRevision({ ...base, commitId: "metadata" }, "/note.md")).resolves.toEqual({
			creationBoundary: false,
			revision: {
				commitId: "metadata", path: "/note.md", createdAt: 2_000, authorName: "Sam",
				authorEmail: "sam@example.test", description: "Metadata update", size: 4, fileId: "same-file",
				contentChanged: false,
				metadataChanges: [
					{ field: "mtime", before: 1, after: 2 },
					{ field: "modifier", before: "Alex", after: "Sam" }
				]
			}
		});
		await expect(history.scanFileMetadataRevision({ ...base, commitId: "content" }, "/note.md")).resolves.toEqual({
			creationBoundary: false, revision: null
		});
		await expect(history.scanFileMetadataRevision({ ...base, commitId: "create" }, "/new.md")).resolves.toEqual({
			creationBoundary: true, revision: null
		});
		await expect(history.scanFileMetadataRevision(
			{ ...base, commitId: "rename" }, "/renamed.md", "/note.md"
		)).resolves.toMatchObject({
			creationBoundary: false,
			revision: {
				path: "/renamed.md", fileId: "same-file", contentChanged: false,
				metadataChanges: expect.arrayContaining([
					{ field: "mtime", before: 1, after: 5 },
					{ field: "modifier", before: "Alex", after: "Sam" }
				])
			}
		});
	});

	test("compares a commit with its real parent and calculates text line statistics", async () => {
		const roots: Record<string, DirSeafDirent> = {
			parent: { id: "parent-root", mode: MODE_DIR, mtime: 1, name: "" },
			commit: { id: "commit-root", mode: MODE_DIR, mtime: 2, name: "" }
		};
		const objects = new Map<string, SeafFsResult>([
			["parent-root", ["parent-root", { type: TYPE_DIR, version: 1, dirents: [
				{ id: "old-file", mode: MODE_FILE, mtime: 1, name: "note.custom-format", size: 7, modifier: "A" }
			] }]],
			["commit-root", ["commit-root", { type: TYPE_DIR, version: 1, dirents: [
				{ id: "new-file", mode: MODE_FILE, mtime: 2, name: "note.custom-format", size: 9, modifier: "A" },
				{ id: "added-file", mode: MODE_FILE, mtime: 2, name: "new.md", size: 3, modifier: "A" }
			] }]],
			["old-file", ["old-file", { type: TYPE_FILE, version: 1, block_ids: ["old-block"], size: 7 }]],
			["new-file", ["new-file", { type: TYPE_FILE, version: 1, block_ids: ["new-block"], size: 9 }]]
		]);
		const server = {
			getCommitInfo: jest.fn(async () => ({ parent_id: "parent" })),
			getCommitRoot: jest.fn(async (id: string) => roots[id]),
			getFs: jest.fn(async (id: string) => objects.get(id)!),
			getBlock: jest.fn(async (id: string) => new TextEncoder().encode(id === "old-block" ? "one\ntwo" : "one\nthree").buffer)
		};
		const history = new HistoryService(server as never);

		const commit = await history.compareCommitToParent("commit");
		const text = await history.compareTextFile("parent", "commit", "/note.custom-format", "modified");

		expect(commit.parentCommitId).toBe("parent");
		expect(commit.files).toEqual([
			{ path: "/new.md", kind: "added" },
			{
				path: "/note.custom-format", kind: "modified", contentChanged: true,
				metadataChanges: [
					{ field: "mtime", before: 1, after: 2 },
					{ field: "size", before: 7, after: 9 }
				]
			}
		]);
		expect(text).toMatchObject({ additions: 1, deletions: 1, truncated: false });
	});
});
