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
});
