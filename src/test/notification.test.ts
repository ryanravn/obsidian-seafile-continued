import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { resolveNotificationUrl, SeafileNotificationClient, toWebSocketUrl } from "../notification";
import { DEFAULT_SETTINGS } from "../settings";
import { debug } from "../utils";

class FakeWebSocket {
	readyState = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: (() => void) | null = null;
	sent: string[] = [];

	send(message: string): void { this.sent.push(message); }
	close(): void { this.readyState = 3; }
	open(): void { this.readyState = 1; this.onopen?.(); }
	message(message: unknown): void { this.onmessage?.({ data: JSON.stringify(message) }); }
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => {
	jest.restoreAllMocks();
	jest.useRealTimers();
});

describe("Seafile notification client", () => {
	test("resolves default, custom, and WebSocket URLs", () => {
		expect(resolveNotificationUrl("https://cloud.example", "")).toBe("https://cloud.example/notification");
		expect(resolveNotificationUrl("https://cloud.example", "http://notify.example:8083/"))
			.toBe("http://notify.example:8083");
		expect(toWebSocketUrl("https://cloud.example/notification")).toBe("wss://cloud.example/notification");
		expect(() => resolveNotificationUrl("https://cloud.example", "ftp://notify.example"))
			.toThrow("HTTP or HTTPS");
	});

	test("subscribes with a JWT and triggers sync for repository updates", async () => {
		const server = {
			checkNotificationServer: jest.fn(async () => {}),
			getNotificationJwtToken: jest.fn(async () => "jwt-secret")
		};
		const onRepoUpdate = jest.fn();
		const socket = new FakeWebSocket();
		const factory = jest.fn(() => socket as unknown as WebSocket);
		const settings = {
			...DEFAULT_SETTINGS,
			host: "https://cloud.example",
			repoId: "repo-id",
			repoToken: "repo-token",
			enableNotifications: true
		};
		const client = new SeafileNotificationClient(settings, server as never, onRepoUpdate, factory);

		client.start();
		await flushPromises();
		expect(factory).toHaveBeenCalledWith("wss://cloud.example/notification");
		socket.open();
		expect(client.status.type).toBe("connected");
		expect(JSON.parse(socket.sent[0])).toEqual({
			type: "subscribe",
			content: { repos: [{ id: "repo-id", jwt_token: "jwt-secret" }] }
		});

		socket.message({ type: "repo-update", content: { repo_id: "other-repo", commit_id: "ignored" } });
		socket.message({ type: "repo-update", content: { repo_id: "repo-id", commit_id: "new-head" } });
		expect(onRepoUpdate).toHaveBeenCalledTimes(1);
		expect(onRepoUpdate).toHaveBeenCalledWith("new-head");
		client.stop();
	});

	test("renews an expired repository JWT on the existing socket", async () => {
		const getToken = jest.fn(async () => getToken.mock.calls.length === 1 ? "first-token" : "renewed-token");
		const server = { checkNotificationServer: async () => {}, getNotificationJwtToken: getToken };
		const socket = new FakeWebSocket();
		const settings = {
			...DEFAULT_SETTINGS,
			host: "https://cloud.example",
			repoId: "repo-id",
			repoToken: "repo-token",
			enableNotifications: true
		};
		const client = new SeafileNotificationClient(
			settings, server as never, jest.fn(), () => socket as unknown as WebSocket
		);

		client.start();
		await flushPromises();
		socket.open();
		socket.message({ type: "jwt-expired", content: { repo_id: "repo-id" } });
		await flushPromises();

		expect(getToken).toHaveBeenCalledTimes(2);
		expect(JSON.parse(socket.sent[1]).content.repos[0].jwt_token).toBe("renewed-token");
		client.stop();
	});

	test("shows polling fallback and retries when the notification server is unavailable", async () => {
		jest.useFakeTimers();
		jest.spyOn(debug, "warn").mockImplementation(() => {});
		const checkServer = jest.fn(async () => { throw new Error("Unavailable"); });
		const server = { checkNotificationServer: checkServer, getNotificationJwtToken: jest.fn() };
		const settings = {
			...DEFAULT_SETTINGS,
			host: "https://cloud.example",
			repoId: "repo-id",
			repoToken: "repo-token",
			enableNotifications: true
		};
		const client = new SeafileNotificationClient(settings, server as never, jest.fn());

		client.start();
		await flushPromises();
		expect(client.status).toEqual({ type: "fallback", retryInSeconds: 1 });

		await jest.advanceTimersByTimeAsync(1000);
		await flushPromises();
		expect(checkServer).toHaveBeenCalledTimes(2);
		client.stop();
	});
});
