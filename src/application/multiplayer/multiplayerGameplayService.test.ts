import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationError } from "../errors.ts";
import { MultiplayerRoomNotifier } from "./multiplayerRoomNotifier.ts";
import { createMultiplayerKit, testOrigin } from "./multiplayerTestKit.ts";

const rejectsWith = (code: string) => (error: unknown) => error instanceof ApplicationError && error.code === code;

test("$connect validates Origin against configuration; the connection starts unidentified", async () => {
  const kit = createMultiplayerKit();
  assert.equal(kit.gameplay.connect("c1", testOrigin), true);
  assert.equal(kit.gameplay.connect("c2", "https://evil.example.com"), false);
  assert.equal(kit.gameplay.connect("c3", undefined), false);
  await assert.rejects(kit.gameplay.syncRoom({ connectionId: "c1" }), rejectsWith("NOT_IDENTIFIED"));
  await assert.rejects(kit.gameplay.startGame({ connectionId: "c1" }), rejectsWith("NOT_IDENTIFIED"));
  await assert.rejects(kit.gameplay.submitAnswer({ connectionId: "c1" }, { questionId: "q", answerId: "a" }), rejectsWith("NOT_IDENTIFIED"));
});

test("IDENTIFY binds the connection only with a valid token and returns personal ROOM_STATE", async () => {
  const kit = createMultiplayerKit();
  const created = await kit.roomService.createRoom({ gameId: "animals", playerId: "ana" });
  const joined = await kit.roomService.joinRoom({ roomCode: created.roomCode, playerId: "beto" });

  // Wrong token, another member's token, unknown member: same safe error, nothing bound.
  for (const [playerId, participantToken] of [["ana", "nope"], ["ana", joined.participantToken], ["ghost", created.participantToken], ["ana", 42]]) {
    await assert.rejects(kit.gameplay.identify({ connectionId: "bad", roomCode: created.roomCode, playerId, participantToken }), rejectsWith("INVALID_PARTICIPANT_TOKEN"));
  }
  await assert.rejects(kit.gameplay.identify({ connectionId: "bad", roomCode: "ZZZZZZ", playerId: "ana", participantToken: created.participantToken }), rejectsWith("ROOM_NOT_FOUND"));
  assert.equal(await kit.repository.getConnection("bad"), null);

  await kit.gameplay.identify({ connectionId: "conn-ana", roomCode: created.roomCode, playerId: "ana", participantToken: created.participantToken, requestId: "r-1" });
  const state = kit.lastEvent("conn-ana", "ROOM_STATE");
  assert.equal(state.requestId, "r-1");
  assert.deepEqual(state.self, { playerId: "ana", role: "HOST" });
  assert.equal(state.room.status, "WAITING");
  assert.equal(state.room.roomCode, created.roomCode);
  assert.equal(typeof state.serverTime, "number");
  assert.deepEqual(state.room.members.map((member) => [member.playerId, member.connected]), [["ana", true], ["beto", false]]);
  assert.deepEqual(await kit.repository.getConnection("conn-ana"), { roomId: created.roomId, playerId: "ana" });
  assert.ok(kit.logs.some((log) => log.event === "MULTIPLAYER_CONNECTED"));

  kit.clock.now += 121 * 60_000;
  await assert.rejects(kit.gameplay.identify({ connectionId: "late", roomCode: created.roomCode, playerId: "ana", participantToken: created.participantToken }), rejectsWith("ROOM_EXPIRED"));
});

test("re-identifying a socket as another member releases its previous membership binding", async () => {
  const kit = createMultiplayerKit();
  const created = await kit.roomService.createRoom({ gameId: "animals", playerId: "ana" });
  const joined = await kit.roomService.joinRoom({ roomCode: created.roomCode, playerId: "beto" });
  await kit.gameplay.identify({ connectionId: "shared", roomCode: created.roomCode, playerId: "ana", participantToken: created.participantToken });
  await kit.gameplay.identify({ connectionId: "shared", roomCode: created.roomCode, playerId: "beto", participantToken: joined.participantToken });
  assert.equal((await kit.repository.getMember(created.roomId, "ana"))!.connectionId, undefined);
  assert.equal((await kit.repository.getMember(created.roomId, "beto"))!.connectionId, "shared");
  assert.deepEqual(await kit.repository.getConnection("shared"), { roomId: created.roomId, playerId: "beto" });
});

test("START_GAME is host-only, needs 2 players, is atomic/idempotent and opens question 1", async () => {
  const kit = createMultiplayerKit();
  const created = await kit.createIdentifiedRoom();
  await assert.rejects(kit.gameplay.startGame({ connectionId: "conn-ana" }), rejectsWith("NOT_ENOUGH_PLAYERS"));
  await kit.joinAndIdentify(created.roomCode, "beto");
  await assert.rejects(kit.gameplay.startGame({ connectionId: "conn-beto" }), rejectsWith("HOST_ONLY_ACTION"));

  await Promise.all([kit.gameplay.startGame({ connectionId: "conn-ana" }), kit.gameplay.startGame({ connectionId: "conn-ana" })]);
  const room = (await kit.repository.getRoom(created.roomId))!;
  assert.equal(room.status, "IN_PROGRESS");
  assert.equal(room.questionState, "OPEN");
  assert.equal(room.currentQuestionIndex, 0);
  assert.equal(room.questionStartedAt, kit.clock.now);
  assert.equal(room.questionDeadlineAt, kit.clock.now + 30_000);
  assert.deepEqual(room.eligiblePlayerIds, ["ana", "beto"]);
  for (const connection of ["conn-ana", "conn-beto"]) {
    assert.equal(kit.eventsFor(connection, "GAME_STARTED").length, 1, "transition applied once");
    assert.equal(kit.eventsFor(connection, "QUESTION_OPENED").length, 1);
  }
  const opened = kit.lastEvent("conn-beto", "QUESTION_OPENED");
  assert.equal(opened.room.currentQuestion?.id, room.questionIds[0]);
  assert.equal(opened.room.questionNumber, 1);
  assert.equal(opened.version, room.version);
  const serialized = JSON.stringify(opened);
  assert.equal(serialized.includes("isCorrect"), false, "QUESTION_OPENED never exposes correctness");
  assert.equal(serialized.includes("correctAnswerId"), false);
  assert.equal(opened.room.reveal, undefined);
  await assert.rejects(kit.roomService.joinRoom({ roomCode: created.roomCode, playerId: "cami" }), rejectsWith("ROOM_ALREADY_STARTED"));
});

test("scenario A/B: all-answered reveal; fast incorrect = 0, slower correct = 1st = 1300; identical scoreboard", async () => {
  const kit = createMultiplayerKit();
  const { created, questionId } = await kit.startedRoom(["beto"]);
  kit.clock.now += 2_000;
  await kit.gameplay.submitAnswer({ connectionId: "conn-ana", requestId: "a-1" }, { questionId, answerId: await kit.wrongAnswerId(questionId) });

  const ack = kit.lastEvent("conn-ana", "ANSWER_ACCEPTED");
  assert.equal(ack.requestId, "a-1");
  assert.equal(ack.answerId, await kit.wrongAnswerId(questionId));
  assert.equal(JSON.stringify(ack).includes("isCorrect"), false, "the ACK does not reveal correctness");
  const othersAck = kit.lastEvent("conn-beto", "ANSWER_ACCEPTED");
  assert.equal(othersAck.answerId, undefined, "other players never learn the chosen answer");
  assert.equal(kit.eventsFor("conn-ana", "QUESTION_REVEALED").length, 0);

  kit.clock.now += 3_000;
  await kit.gameplay.submitAnswer({ connectionId: "conn-beto" }, { questionId, answerId: await kit.correctAnswerId(questionId) });
  const anaReveal = kit.lastEvent("conn-ana", "QUESTION_REVEALED");
  const betoReveal = kit.lastEvent("conn-beto", "QUESTION_REVEALED");
  assert.deepEqual(anaReveal, betoReveal);
  assert.equal(anaReveal.correctAnswerId, await kit.correctAnswerId(questionId));
  assert.deepEqual(anaReveal.results.map((result) => [result.playerId, result.isCorrect, result.placement, result.pointsAwarded]), [
    ["ana", false, null, 0],
    ["beto", true, 1, 1_300],
  ]);
  assert.deepEqual(anaReveal.scoreboard.map((entry) => [entry.playerId, entry.rank, entry.totalPoints, entry.correctAnswers]), [["beto", 1, 1_300, 1], ["ana", 2, 0, 0]]);
  assert.equal(anaReveal.scoreboard[0].cumulativeCorrectResponseTimeMs, 5_000, "server-measured response time");
  assert.deepEqual(kit.lastEvent("conn-ana", "SCOREBOARD_UPDATED").scoreboard, kit.lastEvent("conn-beto", "SCOREBOARD_UPDATED").scoreboard);
  const room = (await kit.repository.getRoom(created.roomId))!;
  assert.equal(room.questionState, "REVEALED");
  assert.equal(anaReveal.room.reveal?.correctAnswerId, anaReveal.correctAnswerId);
  assert.ok(anaReveal.version > kit.lastEvent("conn-ana", "QUESTION_OPENED").version, "versions increase monotonically");
});

test("faster correct answers get the higher speed bonus across four players", async () => {
  const kit = createMultiplayerKit();
  const { questionId } = await kit.startedRoom(["beto", "cami", "dani"]);
  const correct = await kit.correctAnswerId(questionId);
  for (const playerId of ["cami", "ana", "dani", "beto"]) {
    kit.clock.now += 500;
    await kit.gameplay.submitAnswer({ connectionId: `conn-${playerId}` }, { questionId, answerId: correct });
  }
  const reveal = kit.lastEvent("conn-ana", "QUESTION_REVEALED");
  assert.deepEqual(Object.fromEntries(reveal.results.map((result) => [result.playerId, result.pointsAwarded])), { cami: 1_300, ana: 1_200, dani: 1_100, beto: 1_000 });
});

test("SUBMIT_ANSWER: first valid submission wins; duplicates, wrong question, invalid answer and late answers are rejected", async () => {
  const kit = createMultiplayerKit();
  const { created, room, questionId } = await kit.startedRoom(["beto", "cami"]);
  const correct = await kit.correctAnswerId(questionId);
  await assert.rejects(kit.gameplay.submitAnswer({ connectionId: "conn-ana" }, { questionId: room.questionIds[1], answerId: correct }), rejectsWith("INVALID_QUESTION"));
  await assert.rejects(kit.gameplay.submitAnswer({ connectionId: "conn-ana" }, { questionId, answerId: "not-an-option" }), rejectsWith("INVALID_ANSWER"));

  await kit.gameplay.submitAnswer({ connectionId: "conn-ana" }, { questionId, answerId: await kit.wrongAnswerId(questionId) });
  await assert.rejects(kit.gameplay.submitAnswer({ connectionId: "conn-ana" }, { questionId, answerId: correct }), rejectsWith("ANSWER_ALREADY_SUBMITTED"));
  const concurrent = await Promise.allSettled([
    kit.gameplay.submitAnswer({ connectionId: "conn-beto" }, { questionId, answerId: correct }),
    kit.gameplay.submitAnswer({ connectionId: "conn-beto" }, { questionId, answerId: correct }),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  const answers = await kit.repository.listAnswers(created.roomId, questionId);
  assert.equal(answers.length, 2);
  assert.equal(answers.find((answer) => answer.playerId === "ana")!.isCorrect, false, "the first answer is kept");
  assert.equal((await kit.repository.getRoom(created.roomId))!.answeredCount, 2);

  kit.clock.now += 30_000;
  await assert.rejects(kit.gameplay.submitAnswer({ connectionId: "conn-cami" }, { questionId, answerId: correct }), rejectsWith("ANSWER_DEADLINE_EXPIRED"));
  // The late command also ran the deadline guard: the question closed, cami (no answer) scored 0.
  const reveal = kit.lastEvent("conn-cami", "QUESTION_REVEALED");
  assert.deepEqual(reveal.results.find((result) => result.playerId === "cami"), { playerId: "cami", answered: false, isCorrect: false, placement: null, pointsAwarded: 0 });
  await assert.rejects(kit.gameplay.submitAnswer({ connectionId: "conn-cami" }, { questionId, answerId: correct }), rejectsWith("INVALID_QUESTION_STATE"));
});

test("scenario C/D: QUESTION_TIMEOUT is only a trigger; simultaneous timeouts reveal and score exactly once", async () => {
  const kit = createMultiplayerKit();
  const { created, questionId } = await kit.startedRoom(["beto", "cami"]);
  kit.clock.now += 1_000;
  await kit.gameplay.submitAnswer({ connectionId: "conn-ana" }, { questionId, answerId: await kit.correctAnswerId(questionId) });

  await assert.rejects(kit.gameplay.questionTimeout({ connectionId: "conn-beto" }, { questionId }), rejectsWith("INVALID_QUESTION_STATE"));
  assert.equal((await kit.repository.getRoom(created.roomId))!.questionState, "OPEN", "client timers are not authority");
  assert.equal(kit.eventsFor("conn-ana", "QUESTION_REVEALED").length, 0, "no reveal before the server deadline");
  assert.equal((await kit.repository.getMember(created.roomId, "ana"))!.score.totalPoints, 0, "no scoring before the server deadline");

  kit.clock.now += 29_000;
  await Promise.all(["conn-ana", "conn-beto", "conn-cami", "conn-beto"].map((connectionId) => kit.gameplay.questionTimeout({ connectionId }, { questionId })));
  for (const connection of ["conn-ana", "conn-beto", "conn-cami"]) {
    assert.equal(kit.eventsFor(connection, "QUESTION_REVEALED").length, 1, "one reveal per player");
    assert.equal(kit.eventsFor(connection, "SCOREBOARD_UPDATED").length, 1);
  }
  const members = await kit.repository.listMembers(created.roomId);
  assert.deepEqual(Object.fromEntries(members.map((member) => [member.playerId, member.score.totalPoints])), { ana: 1_300, beto: 0, cami: 0 }, "scored once");

  // Late duplicates and stale timers after the reveal are harmless no-ops.
  await kit.gameplay.questionTimeout({ connectionId: "conn-cami" }, { questionId });
  await kit.gameplay.questionTimeout({ connectionId: "conn-cami" }, {});
  assert.equal(kit.eventsFor("conn-cami", "QUESTION_REVEALED").length, 1);
  assert.equal((await kit.repository.getMember(created.roomId, "ana"))!.score.totalPoints, 1_300);
});

test("the last answer racing a timeout still reveals once with every answer counted", async () => {
  const kit = createMultiplayerKit();
  const { created, questionId } = await kit.startedRoom(["beto"]);
  const correct = await kit.correctAnswerId(questionId);
  await kit.gameplay.submitAnswer({ connectionId: "conn-ana" }, { questionId, answerId: correct });
  kit.clock.now += 29_999;
  await Promise.allSettled([
    kit.gameplay.submitAnswer({ connectionId: "conn-beto" }, { questionId, answerId: correct }),
    kit.gameplay.questionTimeout({ connectionId: "conn-ana" }, { questionId }),
  ]);
  assert.equal(kit.eventsFor("conn-ana", "QUESTION_REVEALED").length, 1);
  const total = (await kit.repository.listMembers(created.roomId)).reduce((sum, member) => sum + member.score.totalPoints, 0);
  assert.equal(total, 1_300 + 1_200);
});

test("NEXT_QUESTION is host-only, rejected while OPEN, idempotent, and the last reveal finishes with an identical podium", async () => {
  const kit = createMultiplayerKit({ questionsPerRoom: 2 });
  const { created, room, questionId } = await kit.startedRoom(["beto"]);
  assert.equal(room.questionIds.length, 2);
  await assert.rejects(kit.gameplay.nextQuestion({ connectionId: "conn-ana" }), rejectsWith("INVALID_QUESTION_STATE"));
  for (const playerId of ["beto", "ana"]) {
    kit.clock.now += 1_000;
    await kit.gameplay.submitAnswer({ connectionId: `conn-${playerId}` }, { questionId, answerId: await kit.correctAnswerId(questionId) });
  }
  await assert.rejects(kit.gameplay.nextQuestion({ connectionId: "conn-beto" }), rejectsWith("HOST_ONLY_ACTION"));

  kit.clock.now += 5_000;
  await Promise.all([kit.gameplay.nextQuestion({ connectionId: "conn-ana" }), kit.gameplay.nextQuestion({ connectionId: "conn-ana" })]);
  assert.equal(kit.eventsFor("conn-beto", "QUESTION_OPENED").length, 2, "question 1 and question 2, each once");
  const second = (await kit.repository.getRoom(created.roomId))!;
  assert.equal(second.currentQuestionIndex, 1);
  assert.equal(second.questionState, "OPEN");
  assert.equal(second.questionStartedAt, kit.clock.now);
  assert.equal(second.questionDeadlineAt, kit.clock.now + 30_000);
  assert.equal(second.answeredCount, 0);

  const lastQuestion = second.questionIds[1];
  kit.clock.now += 1_000;
  await kit.gameplay.submitAnswer({ connectionId: "conn-ana" }, { questionId: lastQuestion, answerId: await kit.correctAnswerId(lastQuestion) });
  kit.clock.now += 1_000;
  await kit.gameplay.submitAnswer({ connectionId: "conn-beto" }, { questionId: lastQuestion, answerId: await kit.wrongAnswerId(lastQuestion) });

  const finished = (await kit.repository.getRoom(created.roomId))!;
  assert.equal(finished.status, "FINISHED");
  const anaFinal = kit.lastEvent("conn-ana", "GAME_FINISHED");
  assert.deepEqual(anaFinal.podium, kit.lastEvent("conn-beto", "GAME_FINISHED").podium);
  // ana: 2 correct (1200 + 1300); beto: 1 correct (1300). Accuracy decides.
  assert.deepEqual(anaFinal.podium.map((entry) => [entry.playerId, entry.rank, entry.correctAnswers, entry.totalPoints]), [["ana", 1, 2, 2_500], ["beto", 2, 1, 1_300]]);
  assert.equal(anaFinal.room.status, "FINISHED");
  await assert.rejects(kit.gameplay.nextQuestion({ connectionId: "conn-ana" }), rejectsWith("INVALID_ROOM_STATE"));
  await assert.rejects(kit.gameplay.submitAnswer({ connectionId: "conn-beto" }, { questionId: lastQuestion, answerId: await kit.correctAnswerId(lastQuestion) }), rejectsWith("INVALID_ROOM_STATE"));
  assert.ok(kit.logs.some((log) => log.event === "MULTIPLAYER_GAME_FINISHED"));
});

test("$disconnect keeps membership and eligibility: disconnecting cannot close a question early", async () => {
  const kit = createMultiplayerKit();
  const { created, questionId } = await kit.startedRoom(["beto", "cami"]);
  const answerId = await kit.correctAnswerId(questionId);
  await kit.gameplay.submitAnswer({ connectionId: "conn-beto" }, { questionId, answerId });

  await kit.gameplay.disconnect({ connectionId: "conn-cami" });
  assert.equal(kit.lastEvent("conn-ana", "PLAYER_DISCONNECTED").playerId, "cami");
  assert.deepEqual(kit.lastEvent("conn-ana", "PLAYER_DISCONNECTED").room.members.map((member) => [member.playerId, member.connected]), [["ana", true], ["beto", true], ["cami", false]]);
  assert.ok(await kit.repository.getMember(created.roomId, "cami"), "membership is kept");
  await kit.gameplay.disconnect({ connectionId: "conn-cami" }); // duplicate $disconnect is idempotent
  assert.equal(kit.eventsFor("conn-ana", "PLAYER_DISCONNECTED").length, 1);

  await kit.gameplay.submitAnswer({ connectionId: "conn-ana" }, { questionId, answerId });
  assert.equal((await kit.repository.getRoom(created.roomId))!.questionState, "OPEN", "cami is still eligible");
});

test("reconnect flow end to end with the original token and SYNC_ROOM personal state", async () => {
  const kit = createMultiplayerKit();
  const created = await kit.createIdentifiedRoom();
  const joined = await kit.joinAndIdentify(created.roomCode, "beto", "conn-beto-1");
  await kit.gameplay.startGame({ connectionId: "conn-ana" });
  const questionId = (await kit.repository.getRoom(created.roomId))!.questionIds[0];
  const answerId = await kit.correctAnswerId(questionId);
  await kit.gameplay.submitAnswer({ connectionId: "conn-beto-1" }, { questionId, answerId });

  await kit.gameplay.identify({ connectionId: "conn-beto-2", roomCode: created.roomCode, playerId: "beto", participantToken: joined.participantToken });
  const state = kit.lastEvent("conn-beto-2", "ROOM_STATE");
  assert.deepEqual(state.self, { playerId: "beto", role: "PLAYER", currentAnswerId: answerId });
  assert.equal(state.room.status, "IN_PROGRESS");
  assert.equal(state.room.questionState, "OPEN");
  assert.equal(state.room.currentQuestion?.id, questionId);
  assert.deepEqual(state.room.answeredPlayerIds, ["beto"]);
  assert.ok(kit.logs.some((log) => log.event === "MULTIPLAYER_RECONNECTED"));

  // The replaced connection can no longer act for the member; its reverse lookup is gone.
  await assert.rejects(kit.gameplay.syncRoom({ connectionId: "conn-beto-1" }), rejectsWith("NOT_IDENTIFIED"));
  assert.equal(await kit.repository.getConnection("conn-beto-1"), null);
  // A late $disconnect of the old connection does not mark the new one disconnected.
  await kit.gameplay.disconnect({ connectionId: "conn-beto-1" });
  assert.equal((await kit.repository.getMember(created.roomId, "beto"))!.connectionId, "conn-beto-2");

  await kit.gameplay.syncRoom({ connectionId: "conn-beto-2", requestId: "s-1" });
  const synced = kit.lastEvent("conn-beto-2", "ROOM_STATE");
  assert.equal(synced.requestId, "s-1");
  assert.equal(JSON.stringify(synced).includes("isCorrect"), false, "SYNC_ROOM never exposes correctness while OPEN");

  // Score survives reconnect after the reveal.
  await kit.gameplay.submitAnswer({ connectionId: "conn-ana" }, { questionId, answerId: await kit.wrongAnswerId(questionId) });
  await kit.gameplay.identify({ connectionId: "conn-beto-3", roomCode: created.roomCode, playerId: "beto", participantToken: joined.participantToken });
  const after = kit.lastEvent("conn-beto-3", "ROOM_STATE");
  assert.equal(after.room.scoreboard.find((entry) => entry.playerId === "beto")!.totalPoints, 1_300);
  assert.equal(after.room.reveal?.correctAnswerId, answerId);
  assert.equal(after.self?.role, "PLAYER");
});

test("SYNC_ROOM after an unattended deadline closes the question (deadline guard)", async () => {
  const kit = createMultiplayerKit();
  const { created } = await kit.startedRoom(["beto"]);
  kit.clock.now += 31_000;
  await kit.gameplay.syncRoom({ connectionId: "conn-beto" });
  assert.equal((await kit.repository.getRoom(created.roomId))!.questionState, "REVEALED");
  assert.equal(kit.lastEvent("conn-beto", "ROOM_STATE").room.questionState, "REVEALED");
});

test("stale connections are dropped during broadcast without failing delivery to others", async () => {
  const kit = createMultiplayerKit();
  const { created, questionId } = await kit.startedRoom(["beto", "cami"]);
  kit.gone.add("conn-cami");
  for (const playerId of ["ana", "beto"]) {
    await kit.gameplay.submitAnswer({ connectionId: `conn-${playerId}` }, { questionId, answerId: await kit.correctAnswerId(questionId) });
  }
  assert.ok(kit.eventsFor("conn-ana", "ANSWER_ACCEPTED").length >= 1);
  assert.equal((await kit.repository.getMember(created.roomId, "cami"))!.connectionId, undefined, "stale mapping removed");
  assert.equal(await kit.repository.getConnection("conn-cami"), null);
  assert.ok(kit.logs.some((log) => log.event === "MULTIPLAYER_BROADCAST_STALE_CONNECTION"));
  assert.equal(JSON.stringify(kit.logs).includes("conn-cami"), false, "connection ids are hashed in logs");

});

test("a throwing postToConnection is isolated per connection and logged safely", async () => {
  const kit = createMultiplayerKit();
  const { created } = await kit.startedRoom(["beto"]);
  const delivered: string[] = [];
  const notifier = new MultiplayerRoomNotifier({
    repository: kit.repository,
    games: kit.games,
    broadcaster: { send: async (connectionId) => { if (connectionId === "conn-ana") throw new Error("boom"); delivered.push(connectionId); return "delivered"; } },
    now: () => kit.clock.now,
    logEvent: (event) => kit.logs.push(event),
  });
  await notifier.broadcast(created.roomId, await kit.repository.listMembers(created.roomId), { type: "SCOREBOARD_UPDATED", roomId: created.roomId, serverTime: 0, version: 1, scoreboard: [] });
  assert.deepEqual(delivered, ["conn-beto"]);
  assert.ok(kit.logs.some((log) => log.event === "MULTIPLAYER_BROADCAST_FAILED" && log.errorName === "Error"));
  assert.equal((await kit.repository.getMember(created.roomId, "ana"))!.connectionId, "conn-ana", "only a Gone connection is released");
});

test("an expired room rejects commands even before DynamoDB TTL removes it", async () => {
  const kit = createMultiplayerKit();
  await kit.startedRoom(["beto"]);
  kit.clock.now += 2 * 60 * 60_000;
  await assert.rejects(kit.gameplay.syncRoom({ connectionId: "conn-ana" }), rejectsWith("ROOM_EXPIRED"));
  await assert.rejects(kit.gameplay.nextQuestion({ connectionId: "conn-ana" }), rejectsWith("ROOM_EXPIRED"));
});

test("an expired OPEN question with no processed timeout is recovered by later activity (reconnect, NEXT_QUESTION)", async () => {
  // Every client vanished before the deadline: nothing reached the backend, so the question is still OPEN.
  const kit = createMultiplayerKit();
  const created = await kit.createIdentifiedRoom();
  const joined = await kit.joinAndIdentify(created.roomCode, "beto");
  await kit.gameplay.startGame({ connectionId: "conn-ana" });
  const questionId = (await kit.repository.getRoom(created.roomId))!.questionIds[0];
  await kit.gameplay.submitAnswer({ connectionId: "conn-ana" }, { questionId, answerId: await kit.correctAnswerId(questionId) });
  await kit.gameplay.disconnect({ connectionId: "conn-ana" });
  await kit.gameplay.disconnect({ connectionId: "conn-beto" });
  kit.clock.now += 10 * 60_000;
  assert.equal((await kit.repository.getRoom(created.roomId))!.questionState, "OPEN", "event-driven: no activity, no transition");

  // A reconnect (IDENTIFY) is the next activity: it closes the question through the normal reveal path.
  await kit.gameplay.identify({ connectionId: "conn-beto-2", roomCode: created.roomCode, playerId: "beto", participantToken: joined.participantToken });
  const state = kit.lastEvent("conn-beto-2", "ROOM_STATE");
  assert.equal(state.room.questionState, "REVEALED");
  assert.equal(state.room.reveal?.results.find((result) => result.playerId === "ana")?.pointsAwarded, 1_300);
  assert.equal(kit.eventsFor("conn-beto-2", "QUESTION_REVEALED").length, 1);

  // NEXT_QUESTION while an expired question is still OPEN closes it (and is then rejected until the host sees the reveal).
  const other = createMultiplayerKit();
  const { created: room2 } = await other.startedRoom(["beto"]);
  other.clock.now += 31_000;
  await assert.rejects(other.gameplay.nextQuestion({ connectionId: "conn-ana" }), rejectsWith("INVALID_QUESTION_STATE"));
  assert.equal((await other.repository.getRoom(room2.roomId))!.questionState, "REVEALED");
  assert.equal(other.eventsFor("conn-beto", "QUESTION_REVEALED").length, 1);
});

test("concurrent activity on an expired question recovers it once: one reveal, scoring finalized once", async () => {
  const kit = createMultiplayerKit();
  const { created, questionId } = await kit.startedRoom(["beto", "cami"]);
  kit.clock.now += 1_000;
  await kit.gameplay.submitAnswer({ connectionId: "conn-beto" }, { questionId, answerId: await kit.correctAnswerId(questionId) });
  kit.clock.now += 40_000;
  await Promise.allSettled([
    kit.gameplay.syncRoom({ connectionId: "conn-ana" }),
    kit.gameplay.syncRoom({ connectionId: "conn-cami" }),
    kit.gameplay.questionTimeout({ connectionId: "conn-beto" }, { questionId }),
    kit.gameplay.submitAnswer({ connectionId: "conn-cami" }, { questionId, answerId: await kit.correctAnswerId(questionId) }),
    kit.gameplay.nextQuestion({ connectionId: "conn-ana" }),
  ]);
  for (const connection of ["conn-ana", "conn-beto", "conn-cami"]) {
    assert.equal(kit.eventsFor(connection, "QUESTION_REVEALED").length, 1, connection);
  }
  const room = (await kit.repository.getRoom(created.roomId))!;
  assert.equal(room.questionState, "REVEALED");
  assert.equal(room.currentQuestionIndex, 0, "recovery never skips the reveal");
  const points = Object.fromEntries((await kit.repository.listMembers(created.roomId)).map((member) => [member.playerId, member.score.totalPoints]));
  assert.deepEqual(points, { ana: 0, beto: 1_300, cami: 0 }, "late answer rejected, no duplicated points");
});
