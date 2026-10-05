import type { MultiplayerClientAction, MultiplayerServerEvent } from "../../application/multiplayer/contracts.ts";

/**
 * v0.9 browser WebSocket client for multiplayer rooms (ADR-018/020).
 *
 * - Online only: nothing here is cached or persisted, and the Service Worker
 *   never sees WebSocket traffic.
 * - The participant token travels only in the first IDENTIFY message after
 *   the socket opens, never in the URL.
 * - On an unexpected close it reconnects with bounded backoff and identifies
 *   again; the server then replies with the authoritative ROOM_STATE.
 */

export interface MultiplayerIdentity {
  roomCode: string;
  playerId: string;
  participantToken: string;
}

export type MultiplayerConnectionStatus = "connecting" | "connected" | "reconnecting" | "closed";

export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface MultiplayerSocketClientOptions {
  url: string;
  identity: MultiplayerIdentity;
  onEvent: (event: MultiplayerServerEvent) => void;
  onStatus: (status: MultiplayerConnectionStatus) => void;
  createSocket?: (url: string) => SocketLike;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  createRequestId?: () => string;
}

const OPEN = 1;
const reconnectDelaysMs = [1_000, 2_000, 4_000, 8_000, 10_000];

export class MultiplayerSocketClient {
  private readonly options: MultiplayerSocketClientOptions;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly createRequestId: () => string;
  private socket: SocketLike | null = null;
  private reconnectTimer: unknown = null;
  private attempts = 0;
  private closedByClient = false;

  constructor(options: MultiplayerSocketClientOptions) {
    this.options = options;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    let sequence = 0;
    this.createRequestId = options.createRequestId
      ?? (() => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `req-${Date.now()}-${++sequence}`));
  }

  connect(): void {
    this.closedByClient = false;
    this.open(this.attempts === 0 ? "connecting" : "reconnecting");
  }

  /** Sends a command; returns its requestId, or `null` while disconnected (the UI resyncs on reconnect). */
  send(action: Exclude<MultiplayerClientAction, "IDENTIFY">, payload?: Record<string, unknown>): string | null {
    if (!this.socket || this.socket.readyState !== OPEN) return null;
    const requestId = this.createRequestId();
    this.socket.send(JSON.stringify({ action, requestId, ...(payload ? { payload } : {}) }));
    return requestId;
  }

  /** Stops for good (leaving the room, or a non-recoverable membership error). */
  close(): void {
    this.closedByClient = true;
    if (this.reconnectTimer !== null) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.options.onStatus("closed");
  }

  private open(status: MultiplayerConnectionStatus): void {
    this.options.onStatus(status);
    const socket = this.createSocket(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      const { roomCode, playerId, participantToken } = this.options.identity;
      socket.send(JSON.stringify({ action: "IDENTIFY", requestId: this.createRequestId(), roomCode, playerId, participantToken }));
      this.options.onStatus("connected");
    };
    socket.onmessage = (message) => {
      if (this.socket !== socket || typeof message.data !== "string") return;
      try {
        const event = JSON.parse(message.data) as MultiplayerServerEvent;
        if (event && typeof event === "object" && typeof event.type === "string") this.options.onEvent(event);
      } catch {
        // Ignore malformed frames; the next authoritative event or SYNC_ROOM repairs state.
      }
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (this.socket !== socket || this.closedByClient) return;
      this.socket = null;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const delay = reconnectDelaysMs[Math.min(this.attempts, reconnectDelaysMs.length - 1)];
    this.attempts += 1;
    this.options.onStatus("reconnecting");
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (!this.closedByClient) this.open("reconnecting");
    }, delay);
  }
}

/** Public, non-secret configuration (like NEXT_PUBLIC_GAME_API_BASE_URL). */
export function readMultiplayerSocketUrl(): string | undefined {
  const url = process.env.NEXT_PUBLIC_MULTIPLAYER_WEBSOCKET_URL?.trim();
  return url ? url : undefined;
}
