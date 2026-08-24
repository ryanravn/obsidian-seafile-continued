import { describe, expect, jest, test } from "@jest/globals";
import Server, { HttpError } from "../server";
import { debug } from "../utils";

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
	test("prefers indexed, page-based file history", async () => {
		const { server, request } = createServer({
			data: [{
				commit_id: "commit-a", path: "/note.md", ctime: "2026-08-05T10:00:00+00:00",
				creator_name: "Alex", creator_email: "alex@example.test", op_type: "modify",
				size: 12, rev_file_id: "file-a", old_path: "/old.md"
			}],
			total_count: 60
		});

		const result = await server.getFileHistory("/note.md");

		expect(result).toMatchObject({
			revisions: [expect.objectContaining({
				commitId: "commit-a", description: "modify", renamedFrom: "/old.md"
			})],
			nextCommit: "indexed-page:2"
		});
		expect(request).toHaveBeenCalledWith(expect.objectContaining({
			url: expect.stringContaining("file/new_history/?path=%2Fnote.md&page=1&per_page=50"),
			retry: 0,
			timeoutMs: 15 * 1000
		}));
	});

	test("falls back to legacy file history on older servers", async () => {
		const { server, request } = createServer({});
		const warning = jest.spyOn(debug, "warn").mockImplementation(() => undefined);
		request
			.mockRejectedValueOnce(new HttpError(404, "Not found", "GET /api/v2.1/repos/{id}/file/new_history/"))
			.mockResolvedValueOnce({ data: [], next_start_commit: null });

		await expect(server.getFileHistory("/note.md")).resolves.toEqual({ revisions: [], nextCommit: null });

		expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({
			url: expect.stringContaining("file/history/?path=%2Fnote.md&limit=50")
		}));
		expect(warning).toHaveBeenCalledTimes(1);
		warning.mockRestore();
	});

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
			url: expect.stringContaining("file/history/?path=%2Fnote.md&limit=25&commit_id=start"),
			retry: 0,
			timeoutMs: 15 * 1000
		}));
	});

	test("caches human-facing library history metadata by commit", async () => {
		const { server } = createServer({
			data: [{
				commit_id: "commit-a", time: "2026-08-05T10:00:00+00:00", name: "Alex",
				email: "alex@example.test", description: "Created note", device_name: "Laptop"
			}],
			more: false
		});

		await server.getLibraryHistory();

		expect(server.getCachedLibraryRevision("commit-a")).toMatchObject({
			authorName: "Alex", authorEmail: "alex@example.test", deviceName: "Laptop"
		});
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

	test("falls back when the modern trash restore route is absent", async () => {
		const { server, request } = createServer({});
		const warning = jest.spyOn(debug, "warn").mockImplementation(() => undefined);
		request
			.mockRejectedValueOnce(new HttpError(
				404,
				"<!doctype html><html><title>Personal Files</title></html>",
				"POST /api/v2.1/repos/{id}/trash2/revert/"
			))
			.mockResolvedValueOnce({ success: [{ path: "/one.md" }, { path: "/two.md" }], failed: [] });

		const result = await server.restoreDeletedEntries([
			{ commitId: "commit-a", path: "/one.md" },
			{ commitId: "commit-a", path: "/two.md" }
		]);

		expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({
			url: "repos/repo/trash/revert-dirents/",
			method: "POST",
			body: "path=%2Fone.md&path=%2Ftwo.md&commit_id=commit-a",
			contentType: "application/x-www-form-urlencoded"
		}));
		expect(result).toEqual({ success: ["/one.md", "/two.md"], failed: [] });
		expect(warning).toHaveBeenCalledWith(
			"[Seafile Improved] Modern trash restore endpoint is unavailable; using the compatibility endpoint.",
			expect.objectContaining({ status: 404 })
		);
		warning.mockRestore();
	});

	test("does not hide a real repository-not-found response behind the compatibility endpoint", async () => {
		const { server, request } = createServer({});
		const error = new HttpError(
			404,
			{ error_msg: "Library repo not found." },
			"POST /api/v2.1/repos/{id}/trash2/revert/"
		);
		request.mockRejectedValueOnce(error);

		await expect(server.restoreDeletedEntries([{ commitId: "commit-a", path: "/one.md" }])).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	test("does not include HTML response bodies in HTTP errors", () => {
		const error = new HttpError(
			404,
			"<!doctype html><html><head><title>Page not found</title></head><body>large proxy page</body></html>",
			"POST /api/v2.1/repos/{id}/trash2/revert/"
		);
		expect(error.message).toBe("HTTP 404 during POST /api/v2.1/repos/{id}/trash2/revert/: Server returned an HTML error page (Page not found).");
		expect(error.message).not.toContain("<html>");
	});

	test("describes renames with both full paths", () => {
		const { server } = createServer({});
		expect(server.describeCommit({
			addedFiles: [], removedFiles: [], modifiedFiles: [], addedDirectories: [], removedDirectories: [],
			renamedFiles: [{ from: "/old/note.md", to: "/new/note.md" }], renamedDirectories: []
		})).toBe("Renamed \"/old/note.md\" to \"/new/note.md\".");
	});
});
