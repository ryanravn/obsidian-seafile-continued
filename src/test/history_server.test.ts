import { describe, expect, jest, test } from "@jest/globals";
import Server from "../server";

function createServer(response: unknown): { server: Server, request: jest.Mock } {
	const server = new Server(
		{ repoId: "repo", host: "https://seafile.example", authToken: "token" } as never,
		{ manifest: { version: "test" } } as never
	);
	const request = jest.fn(async () => response);
	(server as unknown as { requestAPIv21: typeof request }).requestAPIv21 = request;
	return { server, request };
}

describe("Seafile history APIs", () => {
	test("maps file-history fields and continuation commits", async () => {
		const { server, request } = createServer({
			data: [{
				commit_id: "commit-a", path: "/note.md", ctime: "2026-08-05T10:00:00+00:00",
				creator_name: "Alex", creator_email: "alex@example.test", description: "Modified note",
				size: 12, rev_file_id: "file-a", rev_renamed_old_path: "/old.md"
			}],
			next_start_commit: "commit-b"
		});

		const result = await server.getFileHistory("/note.md", "start", 25);

		expect(result.revisions[0]).toMatchObject({
			commitId: "commit-a", path: "/note.md", authorName: "Alex", size: 12,
			fileId: "file-a", renamedFrom: "/old.md"
		});
		expect(result.nextCommit).toBe("commit-b");
		expect(request).toHaveBeenCalledWith(expect.objectContaining({
			url: expect.stringContaining("file/history/?path=%2Fnote.md&limit=25&commit_id=start")
		}));
	});

	test("groups trash restore requests by deletion commit", async () => {
		const { server, request } = createServer({
			success: [{ path: "/one.md" }, { path: "/two.md" }],
			failed: [{ path: "/missing.md", error_msg: "expired" }]
		});

		const result = await server.restoreDeletedEntries([
			{ commitId: "a", path: "/one.md" },
			{ commitId: "a", path: "/two.md" },
			{ commitId: "b", path: "/missing.md" }
		]);

		expect(request).toHaveBeenCalledWith(expect.objectContaining({
			method: "POST",
			body: JSON.stringify({ a: ["/one.md", "/two.md"], b: ["/missing.md"] })
		}));
		expect(result).toEqual({
			success: ["/one.md", "/two.md"],
			failed: [{ path: "/missing.md", error: "expired" }]
		});
	});

	test("describes renames with both full paths", () => {
		const { server } = createServer({});
		expect(server.describeCommit({
			addedFiles: [], removedFiles: [], modifiedFiles: [], addedDirectories: [], removedDirectories: [],
			renamedFiles: [{ from: "/old/note.md", to: "/new/note.md" }], renamedDirectories: []
		})).toBe("Renamed \"/old/note.md\" to \"/new/note.md\".");
	});
});
