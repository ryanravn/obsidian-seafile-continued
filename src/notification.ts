import type Server from "./server";
import type { SeafileSettings } from "./settings";
import { debug } from "./utils";
import pTimeout from "p-timeout";

const WEBSOCKET_OPEN = 1;
const REQUEST_TIMEOUT_MS = 15000;
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000, 60000];

export type NotificationStatus =
	| { type: "disabled" }
	| { type: "connecting" }
	| { type: "connected" }
	| { type: "fallback", retryInSeconds: number };

type WebSocketFactory = (url: string) => WebSocket;

export function resolveNotificationUrl(host: string, configuredUrl: string): string {
	const url = new URL(configuredUrl.trim() || "/notification", host);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Notification URL must use HTTP or HTTPS.");
	}
	url.hash = "";
	url.search = "";
	return url.toString().replace(/\/$/, "");
}

export function toWebSocketUrl(notificationUrl: string): string {
	const url = new URL(notificationUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

export class SeafileNotificationClient {
	private socket: WebSocket | null = null;
	private reconnectTimer: number | null = null;
	private connectionTimer: number | null = null;
	private reconnectAttempt = 0;
	private generation = 0;
	private stopped = true;
	private _status: NotificationStatus = { type: "disabled" };
	private readonly statusListeners = new Set<(status: NotificationStatus) => void>();

	constructor(
		private readonly settings: SeafileSettings,
		private readonly server: Server,
		private readonly onRepoUpdate: (commitId: string) => void,
		private readonly webSocketFactory: WebSocketFactory = url => new WebSocket(url)
	) {}

	get status(): NotificationStatus {
		return this._status;
	}

	subscribeStatus(listener: (status: NotificationStatus) => void): () => void {
		this.statusListeners.add(listener);
		listener(this._status);
		return () => this.statusListeners.delete(listener);
	}

	private setStatus(status: NotificationStatus): void {
		this._status = status;
		for (const listener of this.statusListeners) listener(status);
	}

	start(): void {
		this.stop();
		if (!this.settings.enableNotifications || !this.settings.host || !this.settings.repoId || !this.settings.repoToken) return;
		this.stopped = false;
		this.reconnectAttempt = 0;
		void this.connect(this.generation);
	}

	stop(): void {
		this.stopped = true;
		this.generation++;
		if (this.reconnectTimer !== null) {
			window.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.clearConnectionTimer();
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			socket.onopen = null;
			socket.onmessage = null;
			socket.onerror = null;
			socket.onclose = null;
			socket.close();
		}
		this.setStatus({ type: "disabled" });
	}

	private async connect(generation: number): Promise<void> {
		if (this.stopped || generation !== this.generation) return;
		this.setStatus({ type: "connecting" });
		try {
			const notificationUrl = resolveNotificationUrl(this.settings.host, this.settings.notificationUrl);
			await pTimeout(this.server.checkNotificationServer(notificationUrl), { milliseconds: REQUEST_TIMEOUT_MS });
			const jwtToken = await pTimeout(
				this.server.getNotificationJwtToken(this.settings.repoId),
				{ milliseconds: REQUEST_TIMEOUT_MS }
			);
			if (this.stopped || generation !== this.generation) return;

			// Seafile's browser-facing notification endpoint does not negotiate a
			// Sec-WebSocket-Protocol value. Supplying the native client's internal
			// protocol name makes Chromium reject an otherwise valid 101 response.
			const socket = this.webSocketFactory(toWebSocketUrl(notificationUrl));
			this.socket = socket;
			socket.onopen = () => {
				if (this.stopped || generation !== this.generation || socket !== this.socket) return;
				this.clearConnectionTimer();
				this.sendSubscription(socket, jwtToken);
				this.reconnectAttempt = 0;
				this.setStatus({ type: "connected" });
			};
			socket.onmessage = event => {
				if (!this.stopped && generation === this.generation && socket === this.socket) {
					void this.handleMessage(socket, event.data);
				}
			};
			socket.onerror = () => {
				if (socket === this.socket) this.handleDisconnect(socket, generation);
			};
			socket.onclose = () => {
				if (socket === this.socket) this.handleDisconnect(socket, generation);
			};
			this.connectionTimer = window.setTimeout(() => {
				if (socket === this.socket) this.handleDisconnect(socket, generation);
			}, 15000);
		} catch (error) {
			debug.warn("Seafile notification connection failed; periodic sync remains active", error);
			this.scheduleReconnect(generation);
		}
	}

	private sendSubscription(socket: WebSocket, jwtToken: string): void {
		socket.send(JSON.stringify({
			type: "subscribe",
			content: { repos: [{ id: this.settings.repoId, jwt_token: jwtToken }] }
		}));
	}

	private async handleMessage(socket: WebSocket, rawData: unknown): Promise<void> {
		if (typeof rawData !== "string") return;
		let message: { type?: unknown, content?: { repo_id?: unknown, commit_id?: unknown } };
		try {
			message = JSON.parse(rawData) as typeof message;
		} catch {
			debug.warn("Ignoring malformed Seafile notification message");
			return;
		}

		if (message.content?.repo_id !== this.settings.repoId) return;
		if (message.type === "repo-update" && typeof message.content.commit_id === "string") {
			this.onRepoUpdate(message.content.commit_id);
		} else if (message.type === "jwt-expired" && socket.readyState === WEBSOCKET_OPEN) {
			try {
				const jwtToken = await pTimeout(
					this.server.getNotificationJwtToken(this.settings.repoId),
					{ milliseconds: REQUEST_TIMEOUT_MS }
				);
				if (socket === this.socket && socket.readyState === WEBSOCKET_OPEN) {
					this.sendSubscription(socket, jwtToken);
				}
			} catch (error) {
				debug.warn("Failed to renew Seafile notification token", error);
				this.handleDisconnect(socket, this.generation);
			}
		}
	}

	private handleDisconnect(socket: WebSocket, generation: number): void {
		if (socket !== this.socket) return;
		this.clearConnectionTimer();
		this.socket = null;
		socket.onopen = null;
		socket.onmessage = null;
		socket.onerror = null;
		socket.onclose = null;
		if (socket.readyState <= WEBSOCKET_OPEN) socket.close();
		this.scheduleReconnect(generation);
	}

	private clearConnectionTimer(): void {
		if (this.connectionTimer !== null) {
			window.clearTimeout(this.connectionTimer);
			this.connectionTimer = null;
		}
	}

	private scheduleReconnect(generation: number): void {
		if (this.stopped || generation !== this.generation || this.reconnectTimer !== null) return;
		const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
		this.reconnectAttempt++;
		this.setStatus({ type: "fallback", retryInSeconds: delay / 1000 });
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			void this.connect(generation);
		}, delay);
	}
}
