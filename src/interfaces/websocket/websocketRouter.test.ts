import assert from "node:assert/strict";
import test from "node:test";

import { createMultiplayerKit, testOrigin } from "../../application/multiplayer/multiplayerTestKit.ts";
import { createWebSocketRouter, type WebSocketRequestLog } from "./websocketRouter.ts";

function setup() {
  const kit = createMultiplayerKit();
  const logs: WebSocketRequestLog[] = [];
  const router = createWebSocketRouter({ gameplay: kit.gameplay, log: (record) => logs.push(record) });
  const message = (connectionId: string, body: unknown) =>
    router({ eventType: "MESSAGE", connectionId, requestId: "req", body: typeof body === "string" ? body : JSON.stringify(body) });
  return { kit, logs, router, message };
}

test("$connect accepts configured origins and rejects others with 403", async () => {
  const { router } = setup();
  assert.deepEqual(await router({ eventType: "CONNECT", connectionId: "c1", requestId: "r", origin: testOrigin }), { statusCode: 200 });
  assert.deepEqual(await router({ eventType: "CONNECT", connectionId: "c2", requestId: "r", origin: "https://other.example.com" }), { statusCode: 403 });
  assert.deepEqual(await router({ eventType: "CONNECT", connectionId: "c3", requestId: "r" }), { statusCode: 403 });
});

test("malformed, unknown and non-identified messages get safe ERROR events and never mutate state", async () => {
  const { kit, message } = setup();
  for (const [body, code] of [["not json", "INVALID_REQUEST"], [{ action: "HACK" }, "INVALID_REQUEST"], [[1], "INVALID_REQUEST"], [{ action: "START_GAME", requestId: "r-9" }, "NOT_IDENTIFIED"], [{ action: "SUBMIT_ANSWER", payload: { questionId: "q", answerId: "a" } }, "NOT_IDENTIFIED"]] as const) {
    assert.deepEqual(await message("anon", body), { statusCode: 200 });
    const error = kit.lastEvent("anon", "ERROR");
    assert.equal(error.error.code, code);
  }
  assert.equal(kit.lastEvent("anon", "ERROR").requestId, undefined);
  assert.equal(kit.eventsFor("anon", "ERROR").find((event) => event.type === "ERROR" && event.requestId === "r-9")?.type, "ERROR");
  assert.equal(kit.repository.rooms.size, 0);
});

test("IDENTIFY → START_GAME → SUBMIT_ANSWER → reveal → NEXT_QUESTION → SYNC_ROOM through the router", async () => {
  const { kit, logs, message, router } = setup();
  const created = await kit.roomService.createRoom({ gameId: "animals", playerId: "ana" });
  const joined = await kit.roomService.joinRoom({ roomCode: created.roomCode, playerId: "beto" });

  await message("conn-ana", { action: "IDENTIFY", roomCode: created.roomCode, playerId: "ana", participantToken: "wrong" });
  assert.equal(kit.lastEvent("conn-ana", "ERROR").error.code, "INVALID_PARTICIPANT_TOKEN");
  await message("conn-ana", { action: "IDENTIFY", requestId: "id-1", roomCode: created.roomCode, playerId: "ana", participantToken: created.participantToken });
  await message("conn-beto", { action: "IDENTIFY", payload: { roomCode: created.roomCode, playerId: "beto", participantToken: joined.participantToken } });
  const personal = kit.eventsFor("conn-ana", "ROOM_STATE").find((event) => event.type === "ROOM_STATE" && event.requestId === "id-1");
  assert.equal(personal?.type === "ROOM_STATE" && personal.self?.role, "HOST");
  // beto's IDENTIFY then refreshed ana's lobby with a non-personal snapshot.
  assert.equal(kit.lastEvent("conn-ana", "ROOM_STATE").self, undefined);
  assert.equal(kit.lastEvent("conn-beto", "ROOM_STATE").self?.playerId, "beto");

  await message("conn-beto", { action: "START_GAME" });
  assert.equal(kit.lastEvent("conn-beto", "ERROR").error.code, "HOST_ONLY_ACTION");
  await message("conn-ana", { action: "START_GAME" });
  const questionId = kit.lastEvent("conn-beto", "QUESTION_OPENED").room.currentQuestion!.id;

  await message("conn-ana", { action: "NEXT_QUESTION" });
  assert.equal(kit.lastEvent("conn-ana", "ERROR").error.code, "INVALID_QUESTION_STATE");
  await message("conn-ana", { action: "SUBMIT_ANSWER", requestId: "ans-1", payload: { questionId, answerId: await kit.correctAnswerId(questionId) } });
  assert.equal(kit.lastEvent("conn-ana", "ANSWER_ACCEPTED").requestId, "ans-1");
  await message("conn-beto", { action: "SUBMIT_ANSWER", payload: { questionId, answerId: await kit.correctAnswerId(questionId) } });
  assert.equal(kit.lastEvent("conn-beto", "QUESTION_REVEALED").questionId, questionId);
  await message("conn-beto", { action: "QUESTION_TIMEOUT", payload: { questionId } }); // duplicate trigger: no-op
  assert.equal(kit.eventsFor("conn-beto", "QUESTION_REVEALED").length, 1);

  await message("conn-ana", { action: "NEXT_QUESTION" });
  assert.equal(kit.lastEvent("conn-beto", "QUESTION_OPENED").room.questionNumber, 2);
  await message("conn-beto", { action: "SYNC_ROOM", requestId: "sync-1" });
  assert.equal(kit.lastEvent("conn-beto", "ROOM_STATE").requestId, "sync-1");

  assert.deepEqual(await router({ eventType: "DISCONNECT", connectionId: "conn-beto", requestId: "r" }), { statusCode: 200 });
  assert.equal(kit.lastEvent("conn-ana", "PLAYER_DISCONNECTED").playerId, "beto");

  const serializedLogs = JSON.stringify([...logs, ...kit.logs]);
  for (const secret of [created.participantToken, joined.participantToken, "conn-ana", "Ana", "Beto"]) {
    assert.equal(serializedLogs.includes(secret), false, `logs must not contain ${secret}`);
  }
  assert.ok(logs.some((log) => log.action === "SUBMIT_ANSWER" && log.result === "ok"));
});

test("unexpected failures become a generic ERROR without internal details", async () => {
  const { kit } = setup();
  kit.gameplay.syncRoom = async () => { throw Object.assign(new Error("DynamoDB exploded: arn:aws:..."), { name: "InternalServerError" }); };
  const logs: WebSocketRequestLog[] = [];
  const router = createWebSocketRouter({ gameplay: kit.gameplay, log: (record) => logs.push(record) });
  await router({ eventType: "MESSAGE", connectionId: "c", requestId: "r", body: JSON.stringify({ action: "SYNC_ROOM" }) });
  const error = kit.lastEvent("c", "ERROR");
  assert.deepEqual(error.error, { code: "UNEXPECTED_ERROR", message: "An unexpected error occurred." });
  assert.equal(logs[0].errorName, "InternalServerError");
  assert.equal(JSON.stringify(logs).includes("arn:aws"), false);
});
