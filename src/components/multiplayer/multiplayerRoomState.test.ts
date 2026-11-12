import assert from "node:assert/strict";
import test from "node:test";

import type { MultiplayerServerEvent, PublicMultiplayerRoom } from "../../application/multiplayer/contracts.ts";
import {
  ANSWER_CONFIRMATION_TIMEOUT_MS,
  applyServerEvent,
  clearMultiplayerSession,
  initialMultiplayerViewState,
  isTerminalMultiplayerError,
  loadMultiplayerSession,
  multiplayerErrorMessage,
  multiplayerNotices,
  questionTimeoutToSend,
  QUESTION_TIMEOUT_RETRY_MS,
  reduceMultiplayerView,
  remainingSeconds,
  type MultiplayerViewAction,
  type MultiplayerViewState,
  RESYNC_MIN_INTERVAL_MS,
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

// ---- v0.9.2: unconfirmed answers, gateway errors and bounded resync -------------------

const opened = () => reduceMultiplayerView(
  reduceMultiplayerView(initialMultiplayerViewState, { kind: "server-event", now: 0, event: { type: "ROOM_STATE", roomId: "r", serverTime: 0, version: 3, room: room(), self: { playerId: "ana", role: "PLAYER" } } }),
  { kind: "answer-sent", questionId: "q1", answerId: "a1", requestId: "req-7", now: 1_000 },
);

test("a sent answer stays pending (not accepted) until the server confirms it", () => {
  const pending = opened();
  assert.equal(pending.pendingAnswer?.answerId, "a1");
  assert.equal(pending.myAnswerId, null, "never shown as accepted without confirmation");
  const confirmed = reduceMultiplayerView(pending, { kind: "server-event", now: 1_200, event: { type: "ANSWER_ACCEPTED", roomId: "r", serverTime: 1_200, version: 3, questionId: "q1", playerId: "ana", answeredCount: 1, answerId: "a1", requestId: "req-7" } });
  assert.equal(confirmed.pendingAnswer, null);
  assert.equal(confirmed.myAnswerId, "a1");
  assert.equal(confirmed.resyncRequests, 0, "no resync when the ACK arrives");
});

test("a server ERROR for the pending request unlocks the answer (no automatic resend)", () => {
  const rejected = reduceMultiplayerView(opened(), { kind: "server-event", now: 1_100, event: { type: "ERROR", serverTime: 1_100, requestId: "req-7", error: { code: "ANSWER_DEADLINE_EXPIRED", message: "late" } } });
  assert.equal(rejected.pendingAnswer, null);
  assert.equal(rejected.error?.code, "ANSWER_DEADLINE_EXPIRED");
  assert.equal(rejected.resyncRequests, 0);
  const other = reduceMultiplayerView(opened(), { kind: "server-event", now: 1_100, event: { type: "ERROR", serverTime: 1_100, requestId: "req-other", error: { code: "X", message: "y" } } });
  assert.notEqual(other.pendingAnswer, null, "errors for other requests do not resolve this answer");
  const already = reduceMultiplayerView(opened(), { kind: "server-event", now: 9_000, event: { type: "ERROR", serverTime: 9_000, requestId: "req-7", error: { code: "ANSWER_ALREADY_SUBMITTED", message: "dup" } } });
  assert.equal(already.resyncRequests, 1, "fetches which answer the server holds");
});

test("without an ACK: one SYNC_ROOM after the timeout, then unlock with a notice if still unconfirmed", () => {
  let current = opened();
  current = reduceMultiplayerView(current, { kind: "tick", now: 1_000 + ANSWER_CONFIRMATION_TIMEOUT_MS - 1 });
  assert.equal(current.resyncRequests, 0);
  current = reduceMultiplayerView(current, { kind: "tick", now: 1_000 + ANSWER_CONFIRMATION_TIMEOUT_MS });
  assert.equal(current.resyncRequests, 1);
  assert.equal(current.notice?.message, multiplayerNotices.checkingAnswer);
  const again = reduceMultiplayerView(current, { kind: "tick", now: 1_000 + ANSWER_CONFIRMATION_TIMEOUT_MS + 100 });
  assert.equal(again, current, "a tick with nothing to do returns the same state");
  // The requested snapshot shows no answer from this player: unlock so they can choose again.
  const snapshot = reduceMultiplayerView(current, { kind: "server-event", now: 6_500, event: { type: "ROOM_STATE", roomId: "r", serverTime: 6_500, version: 3, room: room(), self: { playerId: "ana", role: "PLAYER" } } });
  assert.equal(snapshot.pendingAnswer, null);
  assert.equal(snapshot.notice?.message, multiplayerNotices.answerUnconfirmed);
  // If even the SYNC_ROOM reply is lost, the lock is released after a second timeout.
  const gaveUp = reduceMultiplayerView(current, { kind: "tick", now: 1_000 + 2 * ANSWER_CONFIRMATION_TIMEOUT_MS });
  assert.equal(gaveUp.pendingAnswer, null);
  assert.equal(gaveUp.notice?.message, multiplayerNotices.answerUnconfirmed);
  assert.equal(gaveUp.resyncRequests, 1, "never more than one SYNC_ROOM per answer");
});

test("the requested snapshot confirms an answer the server did record (lost ACK)", () => {
  const checking = reduceMultiplayerView(opened(), { kind: "tick", now: 1_000 + ANSWER_CONFIRMATION_TIMEOUT_MS });
  const restored = reduceMultiplayerView(checking, { kind: "server-event", now: 7_000, event: { type: "ROOM_STATE", roomId: "r", serverTime: 7_000, version: 3, room: room(), self: { playerId: "ana", role: "PLAYER", currentAnswerId: "a1" } } });
  assert.equal(restored.pendingAnswer, null);
  assert.equal(restored.myAnswerId, "a1");
  assert.equal(restored.notice, null);
});

test("a gateway error frame triggers a rate-limited SYNC_ROOM and informs the player", () => {
  const idle = reduceMultiplayerView(initialMultiplayerViewState, { kind: "transport-error", now: 10_000 });
  assert.equal(idle.resyncRequests, 1);
  assert.equal(idle.notice?.message, multiplayerNotices.serverBusy);
  const burst = reduceMultiplayerView(idle, { kind: "transport-error", now: 10_000 + RESYNC_MIN_INTERVAL_MS - 1 });
  assert.equal(burst.resyncRequests, 1, "no SYNC_ROOM storm under throttling");
  const later = reduceMultiplayerView(burst, { kind: "transport-error", now: 10_000 + RESYNC_MIN_INTERVAL_MS });
  assert.equal(later.resyncRequests, 2);
  const synced = reduceMultiplayerView(later, { kind: "server-event", now: 16_000, event: { type: "ROOM_STATE", roomId: "r", serverTime: 16_000, version: 4, room: room(), self: { playerId: "ana", role: "PLAYER" } } });
  assert.equal(synced.notice, null, "the snapshot clears the busy notice");

  const pending = reduceMultiplayerView(opened(), { kind: "transport-error", now: 1_500 });
  assert.equal(pending.notice?.message, multiplayerNotices.checkingAnswer);
  assert.notEqual(pending.pendingAnswer?.resyncRequestedAtMs, null);
  assert.equal(pending.resyncRequests, 1);
});

test("the question closing while pending clears the lock; the reveal says whether it was recorded", () => {
  const revealed = (answered: boolean) => reduceMultiplayerView(opened(), { kind: "server-event", now: 2_000, event: {
    type: "QUESTION_REVEALED", roomId: "r", serverTime: 2_000, version: 4, questionId: "q1", correctAnswerId: "a1", scoreboard: [],
    results: [{ playerId: "ana", answered, isCorrect: false, placement: null, pointsAwarded: 0 }],
    room: room({ questionState: "REVEALED", reveal: { questionId: "q1", correctAnswerId: "a1", results: [{ playerId: "ana", answered, isCorrect: false, placement: null, pointsAwarded: 0 }] } }),
  } as MultiplayerServerEvent });
  assert.equal(revealed(false).pendingAnswer, null);
  assert.equal(revealed(false).notice?.message, multiplayerNotices.answerNotRecorded);
  assert.equal(revealed(true).notice, null);
});

test("v0.9.2: throttling error codes map to a generic message", () => {
  assert.match(multiplayerErrorMessage({ code: "REQUEST_THROTTLED" }, ""), /muchas solicitudes/i);
  assert.match(multiplayerErrorMessage({ code: "RATE_LIMITED" }, ""), /muchas solicitudes/i);
});

// ---- v0.9.2 pre-production defect: answer notices outliving their question -----------

const q2 = { id: "q2", text: "?", answers: [{ id: "b1", text: "B" }] };
const ack = (questionId: string, answerId: string, now: number): MultiplayerViewAction => ({ kind: "server-event", now, event: { type: "ANSWER_ACCEPTED", roomId: "r", serverTime: now, version: 3, questionId, playerId: "ana", answeredCount: 1, answerId } });
const ownSnapshot = (now: number, overrides: Partial<PublicMultiplayerRoom> = {}, currentAnswerId?: string): MultiplayerViewAction => ({ kind: "server-event", now, event: { type: "ROOM_STATE", roomId: "r", serverTime: now, version: 3, room: room(overrides), self: { playerId: "ana", role: "PLAYER", ...(currentAnswerId ? { currentAnswerId } : {}) } } });
const play = (from: MultiplayerViewState, ...actions: MultiplayerViewAction[]) => actions.reduce(reduceMultiplayerView, from);
/** Pending answer for q1 that timed out twice: unlocked with the "unconfirmed" notice (the original defect's starting point). */
const gaveUp = () => play(opened(), { kind: "tick", now: 1_000 + ANSWER_CONFIRMATION_TIMEOUT_MS }, { kind: "tick", now: 1_000 + 2 * ANSWER_CONFIRMATION_TIMEOUT_MS });

test("defect repro: after giving up, the notice is bound to its question", () => {
  const state = gaveUp();
  assert.equal(state.pendingAnswer, null);
  assert.deepEqual(state.notice, { message: multiplayerNotices.answerUnconfirmed, questionId: "q1" });
  assert.equal(state.resyncRequests, 1, "exactly one recovery SYNC_ROOM for this answer");
});

test("pending → ACK: confirmed, no notice, no resync", () => {
  const state = play(opened(), { kind: "tick", now: 1_000 + ANSWER_CONFIRMATION_TIMEOUT_MS }, ack("q1", "a1", 6_100));
  assert.equal(state.pendingAnswer, null);
  assert.equal(state.myAnswerId, "a1");
  assert.equal(state.answeredQuestionId, "q1");
  assert.equal(state.notice, null, "the 'checking' notice is cleared by the confirmation");
});

test("pending → own snapshot with currentAnswerId: confirmed and notice cleared", () => {
  const state = play(opened(), { kind: "transport-error", now: 1_200 }, ownSnapshot(1_400, {}, "a1"));
  assert.equal(state.pendingAnswer, null);
  assert.equal(state.myAnswerId, "a1");
  assert.equal(state.notice, null);
});

test("timeout then late ACK: the stale 'unconfirmed' notice is cleared and the answer is confirmed", () => {
  const state = play(gaveUp(), ack("q1", "a1", 12_000));
  assert.equal(state.myAnswerId, "a1");
  assert.equal(state.answeredQuestionId, "q1");
  assert.equal(state.notice, null);
  assert.equal(state.resyncRequests, 1, "a late ACK causes no further SYNC_ROOM");
});

test("timeout then late confirmation through a snapshot (e.g. reconnect IDENTIFY)", () => {
  const state = play(gaveUp(), ownSnapshot(12_000, {}, "a1"));
  assert.equal(state.myAnswerId, "a1");
  assert.equal(state.notice, null);
});

test("race: gateway error of another message, SYNC_ROOM answered before the SUBMIT committed, then the ACK", () => {
  const unlocked = play(opened(), { kind: "transport-error", now: 1_100 }, ownSnapshot(1_200));
  assert.equal(unlocked.pendingAnswer, null);
  assert.equal(unlocked.notice?.message, multiplayerNotices.answerUnconfirmed);
  const confirmed = play(unlocked, ack("q1", "a1", 1_300));
  assert.equal(confirmed.myAnswerId, "a1");
  assert.equal(confirmed.notice, null, "no 'unconfirmed' notice next to 'Respuesta enviada'");
  assert.equal(confirmed.resyncRequests, 1);
});

test("a new question clears the previous question's answer notice", () => {
  const state = play(gaveUp(), { kind: "server-event", now: 40_000, event: { type: "QUESTION_OPENED", roomId: "r", serverTime: 40_000, version: 6, room: room({ currentQuestion: q2, version: 6 }) } });
  assert.equal(state.room?.currentQuestion?.id, "q2");
  assert.equal(state.notice, null);
  assert.equal(state.myAnswerId, null, "nothing carried over to the new question");
});

test("finishing the game clears answer notices (never shown on the podium)", () => {
  const notRecorded = play(opened(), { kind: "server-event", now: 2_000, event: {
    type: "QUESTION_REVEALED", roomId: "r", serverTime: 2_000, version: 4, questionId: "q1", correctAnswerId: "a1", scoreboard: [],
    results: [{ playerId: "ana", answered: false, isCorrect: false, placement: null, pointsAwarded: 0 }],
    room: room({ questionState: "REVEALED", reveal: { questionId: "q1", correctAnswerId: "a1", results: [{ playerId: "ana", answered: false, isCorrect: false, placement: null, pointsAwarded: 0 }] } }),
  } as MultiplayerServerEvent });
  assert.equal(notRecorded.notice?.message, multiplayerNotices.answerNotRecorded, "still shown while q1 is revealed");
  const finished = play(notRecorded, { kind: "server-event", now: 3_000, event: { type: "GAME_FINISHED", roomId: "r", serverTime: 3_000, version: 5, podium: [], room: room({ status: "FINISHED", questionState: "REVEALED", version: 5 }) } });
  assert.equal(finished.notice, null);
  assert.deepEqual(finished.podium, []);
  // The original repro: give up on the final question, then the game ends.
  const fromGaveUp = play(gaveUp(), { kind: "server-event", now: 40_000, event: { type: "GAME_FINISHED", roomId: "r", serverTime: 40_000, version: 9, podium: [], room: room({ status: "FINISHED", questionState: "REVEALED", version: 9 }) } });
  assert.equal(fromGaveUp.notice, null);
});

test("gateway error while pending: 'checking' notice for that question, one SYNC_ROOM, then resolution", () => {
  const checking = play(opened(), { kind: "transport-error", now: 1_500 }, { kind: "transport-error", now: 2_000 });
  assert.deepEqual(checking.notice, { message: multiplayerNotices.checkingAnswer, questionId: "q1" });
  assert.equal(checking.resyncRequests, 1, "a second gateway error does not add a SYNC_ROOM");
  assert.notEqual(checking.pendingAnswer, null, "an uncorrelated gateway error never unlocks by itself");
  const timedOut = play(checking, { kind: "tick", now: 1_500 + ANSWER_CONFIRMATION_TIMEOUT_MS });
  assert.equal(timedOut.pendingAnswer, null);
  assert.equal(timedOut.resyncRequests, 1, "giving up does not send another SYNC_ROOM");
});

test("duplicate confirmation is a no-op", () => {
  const once = play(opened(), ack("q1", "a1", 1_200));
  const twice = play(once, ack("q1", "a1", 1_300));
  assert.equal(twice.myAnswerId, "a1");
  assert.equal(twice.pendingAnswer, null);
  assert.equal(twice.notice, null);
  assert.equal(twice.resyncRequests, 0);
});

test("an ACK for a previous question never confirms or clears the new question's pending answer", () => {
  const onQ2 = play(opened(),
    { kind: "server-event", now: 40_000, event: { type: "QUESTION_OPENED", roomId: "r", serverTime: 40_000, version: 6, room: room({ currentQuestion: q2, version: 6 }) } },
    { kind: "answer-sent", questionId: "q2", answerId: "b1", requestId: "req-8", now: 41_000 },
    { kind: "tick", now: 41_000 + ANSWER_CONFIRMATION_TIMEOUT_MS });
  assert.deepEqual(onQ2.notice, { message: multiplayerNotices.checkingAnswer, questionId: "q2" });
  const stale = play(onQ2, ack("q1", "a1", 46_500));
  assert.equal(stale.pendingAnswer?.questionId, "q2", "still pending");
  assert.equal(stale.myAnswerId, null);
  assert.equal(stale.answeredQuestionId, null);
  assert.deepEqual(stale.notice, onQ2.notice, "the q2 notice is not cleared by a q1 event");
  // An out-of-order, older-version snapshot does not resolve q2 either.
  const old = play(onQ2, { kind: "server-event", now: 46_600, event: { type: "ROOM_STATE", roomId: "r", serverTime: 46_600, version: 2, room: room({ version: 2 }), self: { playerId: "ana", role: "PLAYER", currentAnswerId: "a1" } } });
  assert.equal(old.pendingAnswer?.questionId, "q2");
  assert.equal(old.room?.currentQuestion?.id, "q2");
});

test("answer notices never erase connection notices or server errors of other operations", () => {
  const busy = play(initialMultiplayerViewState, ownSnapshot(0), { kind: "transport-error", now: 10_000 });
  assert.deepEqual(busy.notice, { message: multiplayerNotices.serverBusy, questionId: null });
  const sent = play(busy, { kind: "answer-sent", questionId: "q1", answerId: "a1", requestId: "req-9", now: 10_100 });
  assert.equal(sent.notice?.message, multiplayerNotices.serverBusy, "connection notice kept when answering");
  const hostError = play(gaveUp(), { kind: "server-event", now: 11_000, event: { type: "ERROR", serverTime: 11_000, requestId: "req-host", error: { code: "HOST_ONLY_ACTION", message: "host" } } });
  assert.equal(hostError.error?.code, "HOST_ONLY_ACTION", "server error kept");
  assert.equal(hostError.notice?.message, multiplayerNotices.answerUnconfirmed, "same question still open: notice kept");
});
