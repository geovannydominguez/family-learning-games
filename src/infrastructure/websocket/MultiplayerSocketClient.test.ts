import assert from "node:assert/strict";
import test from "node:test";

import type { MultiplayerServerEvent } from "../../application/multiplayer/contracts.ts";
import { MultiplayerSocketClient, type MultiplayerConnectionStatus, type SocketLike } from "./MultiplayerSocketClient.ts";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) { this.url = url; }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
  drop() { this.readyState = 3; this.onclose?.({}); }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const statuses: MultiplayerConnectionStatus[] = [];
  const events: MultiplayerServerEvent[] = [];
  let sequence = 0;
  const client = new MultiplayerSocketClient({
    url: "wss://ws.example.com/production",
    identity: { roomCode: "AB7K2M", playerId: "ana", participantToken: "secret-token" },
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    createSocket: (url) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
    setTimer: (callback, delayMs) => { timers.push({ callback, delayMs }); return timers.length; },
    clearTimer: () => {},
    createRequestId: () => `req-${++sequence}`,
  });
  return { client, sockets, timers, statuses, events };
}

test("identifies with the token in the first message, never in the URL", () => {
  const { client, sockets, statuses } = setup();
  client.connect();
  assert.equal(sockets[0].url, "wss://ws.example.com/production");
  assert.equal(sockets[0].url.includes("secret-token"), false);
  assert.equal(client.send("SYNC_ROOM"), null, "commands are not sent before the socket opens");
  sockets[0].open();
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), { action: "IDENTIFY", requestId: "req-1", roomCode: "AB7K2M", playerId: "ana", participantToken: "secret-token" });
  assert.deepEqual(statuses, ["connecting", "connected"]);
});

test("sends commands with a requestId and delivers parsed server events", () => {
  const { client, sockets, events } = setup();
  client.connect();
  sockets[0].open();
  assert.equal(client.send("SUBMIT_ANSWER", { questionId: "q1", answerId: "a1" }), "req-2");
  assert.deepEqual(JSON.parse(sockets[0].sent[1]), { action: "SUBMIT_ANSWER", requestId: "req-2", payload: { questionId: "q1", answerId: "a1" } });
  sockets[0].onmessage?.({ data: JSON.stringify({ type: "ERROR", serverTime: 1, error: { code: "X", message: "y" } }) });
  sockets[0].onmessage?.({ data: "not json" });
  assert.equal(events.length, 1);
});

test("reconnects with bounded backoff after an unexpected close and identifies again", () => {
  const { client, sockets, timers, statuses } = setup();
  client.connect();
  sockets[0].open();
  sockets[0].drop();
  assert.equal(statuses.at(-1), "reconnecting");
  assert.equal(timers[0].delayMs, 1_000);
  timers[0].callback();
  sockets[1].drop();
  assert.equal(timers[1].delayMs, 2_000);
  timers[1].callback();
  sockets[2].open();
  assert.equal(JSON.parse(sockets[2].sent[0]).action, "IDENTIFY");
  assert.equal(statuses.at(-1), "connected");
  sockets[2].drop();
  assert.equal(timers[2].delayMs, 1_000, "backoff resets after a successful connection");
});

test("close() stops for good: no reconnect after leaving", () => {
  const { client, sockets, timers, statuses } = setup();
  client.connect();
  sockets[0].open();
  client.close();
  sockets[0].drop();
  assert.equal(sockets[0].closed, true);
  assert.equal(timers.length, 0);
  assert.equal(statuses.at(-1), "closed");
});
