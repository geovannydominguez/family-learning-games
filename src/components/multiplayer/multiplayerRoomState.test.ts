import assert from "node:assert/strict";
import test from "node:test";

import type { MultiplayerServerEvent, PublicMultiplayerRoom } from "../../application/multiplayer/contracts.ts";
import {
  applyServerEvent,
  clearMultiplayerSession,
  initialMultiplayerViewState,
  isTerminalMultiplayerError,
  loadMultiplayerSession,
  questionTimeoutToSend,
  QUESTION_TIMEOUT_RETRY_MS,
  remainingSeconds,
  saveMultiplayerSession,
} from "./multiplayerRoomState.ts";

const room = (overrides: Partial<PublicMultiplayerRoom> = {}): PublicMultiplayerRoom => ({
  roomId: "r", roomCode: "AB7K2M", gameId: "animals", gameTitle: "Animales", hostPlayerId: "ana", status: "IN_PROGRESS",
  questionState: "OPEN", questionNumber: 1, totalQuestions: 2, questionTimeLimitSeconds: 30, questionStartedAt: 1_000, questionDeadlineAt: 31_000,
  members: [], answeredPlayerIds: [], currentQuestion: { id: "q1", text: "?", answers: [{ id: "a1", text: "A" }] }, scoreboard: [], version: 3,
  ...overrides,
});

const state = (event: MultiplayerServerEvent, now = 0, from = initialMultiplayerViewState) => applyServerEvent(from, event, now);

test("snapshots replace local state; stale versions are ignored", () => {
  const current = state({ type: "QUESTION_OPENED", roomId: "r", serverTime: 5_000, version: 3, room: room() }, 4_000);
  assert.equal(current.version, 3);
  assert.equal(current.clockOffsetMs, 1_000, "server clock offset");
  const stale = state({ type: "ROOM_STATE", roomId: "r", serverTime: 6_000, version: 2, room: room({ status: "WAITING" }) }, 6_000, current);
  assert.equal(stale.room?.status, "IN_PROGRESS");
  assert.equal(state({ type: "SCOREBOARD_UPDATED", roomId: "r", serverTime: 1, version: 1, scoreboard: [{ playerId: "x" } as never] }, 0, current).room?.scoreboard.length, 0);
});

test("ROOM_STATE self restores role and a previously submitted answer (reconnect)", () => {
  const restored = state({ type: "ROOM_STATE", roomId: "r", serverTime: 0, version: 3, room: room(), self: { playerId: "beto", role: "PLAYER", currentAnswerId: "a1" } });
  assert.deepEqual(restored.self, { playerId: "beto", role: "PLAYER" });
  assert.equal(restored.myAnswerId, "a1");
  // The next question clears the lock.
  const next = state({ type: "QUESTION_OPENED", roomId: "r", serverTime: 0, version: 5, room: room({ currentQuestion: { id: "q2", text: "?", answers: [] } }) }, 0, restored);
  assert.equal(next.myAnswerId, null);
});

test("ANSWER_ACCEPTED locks only the sender and counts responders without correctness", () => {
  const opened = state({ type: "QUESTION_OPENED", roomId: "r", serverTime: 0, version: 3, room: room() });
  const mine = state({ type: "ANSWER_ACCEPTED", roomId: "r", serverTime: 0, version: 3, questionId: "q1", playerId: "ana", answeredCount: 1, answerId: "a1" }, 0, opened);
  assert.equal(mine.myAnswerId, "a1");
  const theirs = state({ type: "ANSWER_ACCEPTED", roomId: "r", serverTime: 0, version: 3, questionId: "q1", playerId: "beto", answeredCount: 2 }, 0, mine);
  assert.deepEqual(theirs.room?.answeredPlayerIds, ["ana", "beto"]);
  assert.equal(theirs.myAnswerId, "a1");
  const stale = state({ type: "ANSWER_ACCEPTED", roomId: "r", serverTime: 0, version: 3, questionId: "q0", playerId: "cami", answeredCount: 3 }, 0, theirs);
  assert.deepEqual(stale.room?.answeredPlayerIds, ["ana", "beto"]);
});

test("GAME_FINISHED keeps the server podium; ERROR is surfaced", () => {
  const podium = [{ playerId: "ana", displayName: "Ana", rank: 1, correctAnswers: 2, totalPoints: 2_500, firstPlaceCorrectAnswers: 1, secondPlaceCorrectAnswers: 1, thirdPlaceCorrectAnswers: 0, cumulativeCorrectResponseTimeMs: 3_000 }];
  const finished = state({ type: "GAME_FINISHED", roomId: "r", serverTime: 0, version: 9, room: room({ status: "FINISHED", questionState: "REVEALED" }), podium });
  assert.deepEqual(finished.podium, podium);
  const failed = state({ type: "ERROR", serverTime: 0, error: { code: "ROOM_EXPIRED", message: "Room has expired." } }, 0, finished);
  assert.equal(failed.error?.code, "ROOM_EXPIRED");
  assert.equal(isTerminalMultiplayerError("ROOM_EXPIRED"), true);
  assert.equal(isTerminalMultiplayerError("ANSWER_DEADLINE_EXPIRED"), false);
});

test("the countdown renders from the server deadline and clock offset", () => {
  assert.equal(remainingSeconds(room(), 0, 1_000), 30);
  assert.equal(remainingSeconds(room(), 2_000, 1_000), 28, "local clock behind the server");
  assert.equal(remainingSeconds(room(), 0, 40_000), 0);
  assert.equal(remainingSeconds(room({ questionState: "REVEALED" }), 0, 1_000), null);
});

test("membership is kept in (session) storage only and tolerates broken storage", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key) };
  const session = { roomId: "r", roomCode: "AB7K2M", playerId: "ana", participantToken: "t" };
  saveMultiplayerSession(session, storage);
  assert.deepEqual(loadMultiplayerSession(storage), session);
  clearMultiplayerSession(storage);
  assert.equal(loadMultiplayerSession(storage), null);
  values.set("joam-multiplayer-session", "{bad");
  assert.equal(loadMultiplayerSession(storage), null);
  const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
  assert.doesNotThrow(() => saveMultiplayerSession(session, throwing));
  assert.equal(loadMultiplayerSession(throwing), null);
  assert.equal(loadMultiplayerSession(null), null);
});

test("multiplayer client code never uses localStorage or IndexedDB for the participant token", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["./multiplayerRoomState.ts", "./MultiplayerGame.tsx", "../../infrastructure/websocket/MultiplayerSocketClient.ts"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.equal(/localStorage|indexedDB/i.test(source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")), false, file);
  }
});

test("the client sends QUESTION_TIMEOUT automatically once the server-estimated deadline is reached", () => {
  // QUESTION_OPENED with deadline 31_000 (server time); this device's clock runs 2 s behind the server.
  const opened = state({ type: "QUESTION_OPENED", roomId: "r", serverTime: 3_000, version: 3, room: room() }, 1_000);
  assert.equal(questionTimeoutToSend(opened.room, opened.clockOffsetMs, 28_000, null), null, "before the deadline: nothing is sent");
  assert.equal(questionTimeoutToSend(opened.room, opened.clockOffsetMs, 29_000, null), "q1", "deadline reached in server time: send without any click");
  assert.equal(questionTimeoutToSend(opened.room, opened.clockOffsetMs, 29_500, { questionId: "q1", at: 29_000 }), null, "once per question");
  assert.equal(questionTimeoutToSend(opened.room, opened.clockOffsetMs, 29_000 + QUESTION_TIMEOUT_RETRY_MS, { questionId: "q1", at: 29_000 }), "q1", "bounded retry while still OPEN");
  const revealed = room({ questionState: "REVEALED" });
  assert.equal(questionTimeoutToSend(revealed, 0, 60_000, null), null, "never after the reveal");
  assert.equal(questionTimeoutToSend(room({ status: "FINISHED" }), 0, 60_000, null), null);
});
