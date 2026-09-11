import { afterAll, beforeAll, describe, expect, jest, test } from "@jest/globals";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import Server from "../server";
import { DEFAULT_SETTINGS } from "../settings";
import { debug } from "../utils";

interface RecordedRequest {
	method: string
	path: string
	headers: Record<string, string | string[] | undefined>
	body: string
}

describe("Seafile HTTP contract", () => {
	let fixture: HttpServer;
	let host = "";
	const requests: RecordedRequest[] = [];
	const block = new TextEncoder().encode("contract block");
	const blockId = createHash("sha1").update(block).digest("hex");

	beforeAll(async () => {
		fixture = createHttpServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", chunk => chunks.push(Buffer.from(chunk)));
			request.on("end", () => {
				const path = request.url ?? "/";
				requests.push({
					method: request.method ?? "GET",
					path,
					headers: request.headers,
					body: Buffer.concat(chunks).toString("utf8")
				});
				if (path === "/api/v2.1/repos/") return json(response, { repos: [{ repo_id: "repo", permission: "rw" }] });
				if (path === "/seafhttp/repo/repo/commit/HEAD") return json(response, { head_commit_id: "head" });
				if (path === "/seafhttp/repo/repo/commit/head") return json(response, {
					commit_id: "head", root_id: "root-fs", ctime: 1700000000
				});
				if (path === "/api/v2.1/repos/repo/history/?page=1&per_page=10") return json(response, {
					data: [{
						commit_id: "head", time: "2026-08-11T10:00:00+00:00", name: "Alex",
						email: "alex@example.test", description: "Updated vault", device_name: "Laptop"
					}],
					more: false
				});
				if (path === `/seafhttp/repo/repo/block/${blockId}`) return binary(response, block);
				if (path === "/api/v2.1/repos/repo/trash2/revert/") {
					response.writeHead(404, { "Content-Type": "text/html" });
					return response.end("<!doctype html><html><title>Personal Files</title></html>");
				}
				if (path === "/api/v2.1/repos/repo/trash/revert-dirents/") {
					return json(response, { success: [{ path: "/deleted.md" }], failed: [] });
				}
				return json(response, { error_msg: `Unexpected contract request: ${path}` }, 500);
			});
		});
		await new Promise<void>((resolve, reject) => {
			fixture.once("error", reject);
			fixture.listen(0, "127.0.0.1", resolve);
		});
		const address = fixture.address();
		if (!address || typeof address === "string") throw new Error("HTTP contract fixture did not bind a TCP port.");
		host = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
	});

	test("matches current authentication, metadata, history, block, and restore routes", async () => {
		const compatibilityWarning = jest.spyOn(debug, "warn").mockImplementation(() => undefined);
		const client = new Server({
			...DEFAULT_SETTINGS,
			host,
			authToken: "account-token",
			repoId: "repo",
			repoToken: "repository-token"
		}, { manifest: { version: "test" } } as never);

		await expect(client.getRepoPermission()).resolves.toBe("rw");
		await expect(client.getHeadCommitId()).resolves.toBe("head");
		await expect(client.getCommitRoot("head")).resolves.toMatchObject({ id: "root-fs", mtime: 1700000000 });
		await expect(client.getLibraryHistory(1, 10)).resolves.toMatchObject({
			revisions: [expect.objectContaining({ commitId: "head", authorName: "Alex", deviceName: "Laptop" })],
			more: false
		});
		await expect(client.getBlock(blockId)).resolves.toEqual(block.buffer);
		await expect(client.restoreDeletedEntries([{ commitId: "head", path: "/deleted.md" }])).resolves.toEqual({
			success: ["/deleted.md"], failed: []
		});

		const accountRequest = requests.find(request => request.path === "/api/v2.1/repos/");
		expect(accountRequest?.headers.authorization).toBe("Token account-token");
		const repoRequests = requests.filter(request => request.path.startsWith("/seafhttp/"));
		expect(repoRequests.every(request => request.headers["seafile-repo-token"] === "repository-token")).toBe(true);
		const modernRestore = requests.find(request => request.path.endsWith("/trash2/revert/"));
		expect(modernRestore).toMatchObject({ method: "POST", body: "{\"head\":[\"/deleted.md\"]}" });
		const compatibilityRestore = requests.find(request => request.path.endsWith("/trash/revert-dirents/"));
		expect(compatibilityRestore).toMatchObject({
			method: "POST",
			body: "path=%2Fdeleted.md&commit_id=head"
		});
		expect(compatibilityWarning).toHaveBeenCalledTimes(1);
	});
});

function json(response: import("node:http").ServerResponse, value: unknown, status = 200): void {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(value));
}

function binary(response: import("node:http").ServerResponse, value: Uint8Array): void {
	response.writeHead(200, { "Content-Type": "application/octet-stream" });
	response.end(value);
}
