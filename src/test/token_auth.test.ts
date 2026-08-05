import { afterEach, describe, expect, jest, test } from "@jest/globals";
import Server from "../server";
import { DEFAULT_SETTINGS } from "../settings";

function makeServer(): Server {
	return new Server(
		{ ...DEFAULT_SETTINGS, host: "https://example.test" },
		{ manifest: { version: "test" } } as never
	);
}

afterEach(() => {
	jest.restoreAllMocks();
});

describe("manual API token authentication", () => {
	test("validates a trimmed token without changing the stored token", async () => {
		const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(new Response(
			JSON.stringify({ repos: [] }),
			{ status: 200, headers: { "Content-Type": "application/json" } }
		));
		const client = makeServer();

		await client.validateAuthToken("  manually-entered-token  ");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const request = fetchMock.mock.calls[0];
		expect(request[0]).toBe("https://example.test/api/v2.1/repos/");
		expect(request[1]?.headers).toEqual({ Authorization: "Token manually-entered-token" });
	});

	test("rejects a token the server does not authorize", async () => {
		jest.spyOn(global, "fetch").mockResolvedValue(new Response(
			JSON.stringify({ detail: "Invalid token" }),
			{ status: 401, headers: { "Content-Type": "application/json" } }
		));

		await expect(makeServer().validateAuthToken("invalid-token")).rejects.toThrow("HTTP 401");
	});

	test("rejects an empty token without making a request", async () => {
		const fetchMock = jest.spyOn(global, "fetch");

		await expect(makeServer().validateAuthToken("   ")).rejects.toThrow("API token is required");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("uses the repository token to obtain a notification JWT", async () => {
		const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(new Response(
			JSON.stringify({ jwt_token: "notification-jwt" }),
			{ status: 200, headers: { "Content-Type": "application/json" } }
		));
		const client = new Server(
			{ ...DEFAULT_SETTINGS, host: "https://example.test", repoToken: "repository-token" },
			{ manifest: { version: "test" } } as never
		);

		await expect(client.getNotificationJwtToken("repo/id")).resolves.toBe("notification-jwt");
		expect(fetchMock.mock.calls[0][0]).toBe("https://example.test/seafhttp/repo/repo%2Fid/jwt-token");
		expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ "Seafile-Repo-Token": "repository-token" });
	});

	test("reads the current repository permission", async () => {
		jest.spyOn(global, "fetch").mockResolvedValue(new Response(
			JSON.stringify({ repos: [{ repo_id: "repo", permission: "r" }] }),
			{ status: 200, headers: { "Content-Type": "application/json" } }
		));
		const client = new Server(
			{ ...DEFAULT_SETTINGS, host: "https://example.test", authToken: "token", repoId: "repo" },
			{ manifest: { version: "test" } } as never
		);

		await expect(client.getRepoPermission()).resolves.toBe("r");
	});

	test("recognizes the notification server ping response", async () => {
		const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(new Response(
			JSON.stringify({ ret: "pong" }),
			{ status: 200, headers: { "Content-Type": "application/json" } }
		));
		const client = makeServer();

		await client.checkNotificationServer("https://example.test/notification/");
		expect(fetchMock.mock.calls[0][0]).toBe("https://example.test/notification/ping");
	});

	test("rejects a downloaded block whose content does not match its ID", async () => {
		jest.spyOn(global, "fetch").mockResolvedValue(new Response(new TextEncoder().encode("corrupt"), { status: 200 }));
		const client = new Server(
			{ ...DEFAULT_SETTINGS, host: "https://example.test", repoId: "repo", repoToken: "repository-token" },
			{ manifest: { version: "test" } } as never
		);

		await expect(client.getBlock("0000000000000000000000000000000000000000"))
			.rejects.toThrow("integrity verification");
	});
});

describe("repository availability", () => {
	test.each([403, 404, 444])("classifies repository-unavailable HTTP %i while fetching HEAD", async (status) => {
		jest.spyOn(global, "fetch").mockResolvedValue(new Response("Repository unavailable", { status }));
		const client = new Server(
			{ ...DEFAULT_SETTINGS, host: "https://example.test", repoId: "deleted-repo", repoToken: "old-token" },
			{ manifest: { version: "test" } } as never
		);

		await expect(client.getHeadCommitId()).rejects.toMatchObject({
			status,
			message: "The configured Seafile repository no longer exists or is no longer accessible.",
		});
	});

	test("does not classify a transient server error as repository deletion", async () => {
		jest.spyOn(global, "fetch").mockResolvedValue(new Response(
			JSON.stringify({ error_msg: "Temporary failure" }),
			{ status: 503, headers: { "Content-Type": "application/json" } }
		));

		await expect(makeServer().getHeadCommitId()).rejects.toThrow("HTTP 503");
	});
});
