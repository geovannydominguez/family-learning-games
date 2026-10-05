import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationError } from "../errors.ts";
import { createMultiplayerKit } from "./multiplayerTestKit.ts";
import { participantTokens, randomRoomCodes, roomCodePattern } from "./participantTokens.ts";
import { selectRoomQuestionIds } from "./multiplayerRoomService.ts";

const rejectsWith = (code: string) => (error: unknown) => error instanceof ApplicationError && error.code === code;

test("create room: host membership, 6-char code, one-time token persisted only as a hash", async () => {
  const kit = createMultiplayerKit();
  const created = await kit.roomService.createRoom({ gameId: "animals", playerId: "ana", questionTimeLimitSeconds: 45 });

  assert.equal(created.role, "HOST");
  assert.equal(created.playerId, "ana");
  assert.equal(created.questionTimeLimitSeconds, 45);
  assert.match(created.roomCode, roomCodePattern);
  assert.ok(Buffer.from(created.participantToken, "base64url").length >= 16, "at least 128 bits");

  const room = (await kit.repository.getRoom(created.roomId))!;
  assert.equal(room.status, "WAITING");
  assert.equal(room.questionState, "NOT_STARTED");
  assert.equal(room.hostPlayerId, "ana");
  assert.equal(room.questionIds.length, 10);
  assert.equal(room.expiresAt, Math.ceil((kit.clock.now + 120 * 60_000) / 1_000), "2 hour lifetime");
  const host = (await kit.repository.getMember(created.roomId, "ana"))!;
  assert.equal(host.role, "HOST");
  assert.notEqual(host.participantTokenHash, created.participantToken);
  assert.ok(participantTokens.matches(created.participantToken, host.participantTokenHash));
  assert.equal(JSON.stringify([...kit.repository.members.values(), ...kit.repository.rooms.values()]).includes(created.participantToken), false);
  assert.equal(JSON.stringify(kit.logs).includes(created.participantToken), false);
  assert.equal(JSON.stringify(kit.logs).includes(host.participantTokenHash), false);
  assert.equal(JSON.stringify(kit.logs).includes("Ana"), false, "no player names in logs");
});

test("create room validates game, player, time limit and defaults to 30 seconds", async () => {
  const kit = createMultiplayerKit();
  assert.equal((await kit.roomService.createRoom({ gameId: "animals", playerId: "ana" })).questionTimeLimitSeconds, 30);
  await assert.rejects(kit.roomService.createRoom({ gameId: "missing", playerId: "ana" }), rejectsWith("RESOURCE_NOT_FOUND"));
  await assert.rejects(kit.roomService.createRoom({ gameId: "animals", playerId: "ghost" }), rejectsWith("PLAYER_NOT_FOUND"));
  for (const questionTimeLimitSeconds of [9, 121, 15.5, Number.NaN]) {
    await assert.rejects(kit.roomService.createRoom({ gameId: "animals", playerId: "ana", questionTimeLimitSeconds }), rejectsWith("INVALID_REQUEST"));
  }
  await assert.rejects(kit.roomService.createRoom({ gameId: "animals", playerId: "ana", difficulty: "extreme" as never }), rejectsWith("INVALID_REQUEST"));
});

test("room-code collisions retry with a new code (bounded)", async () => {
  const kit = createMultiplayerKit();
  kit.codes.push("AB7K2M");
  const first = await kit.roomService.createRoom({ gameId: "animals", playerId: "ana" });
  kit.codes.push("AB7K2M", "AB7K2M", "QW3RTY");
  const second = await kit.roomService.createRoom({ gameId: "animals", playerId: "beto" });
  assert.equal(first.roomCode, "AB7K2M");
  assert.equal(second.roomCode, "QW3RTY");
  assert.equal(await kit.repository.findRoomIdByCode("AB7K2M"), first.roomId);

  kit.codes.push(...Array(5).fill("AB7K2M"));
  await assert.rejects(kit.roomService.createRoom({ gameId: "animals", playerId: "cami" }), /unique room code/);
});

test("join room returns a PLAYER token and broadcasts PLAYER_JOINED to the lobby", async () => {
  const kit = createMultiplayerKit();
  const created = await kit.createIdentifiedRoom();
  const joined = await kit.roomService.joinRoom({ roomCode: created.roomCode.toLowerCase(), playerId: "beto" });

  assert.deepEqual({ ...joined, participantToken: "x" }, { roomId: created.roomId, roomCode: created.roomCode, playerId: "beto", role: "PLAYER", participantToken: "x" });
  assert.notEqual(joined.participantToken, created.participantToken);
  const event = kit.lastEvent("conn-ana", "PLAYER_JOINED");
  assert.equal(event.playerId, "beto");
  assert.deepEqual(event.room.members.map((member) => [member.playerId, member.role]), [["ana", "HOST"], ["beto", "PLAYER"]]);
  assert.equal(JSON.stringify(event).includes(joined.participantToken), false, "tokens are never broadcast");
  assert.equal((await kit.repository.getRoom(created.roomId))!.memberCount, 2);
});

test("join rejects unknown, expired, started rooms, unknown or duplicate players and full rooms", async () => {
  const kit = createMultiplayerKit({ maxPlayers: 3 });
  const created = await kit.createIdentifiedRoom();
  await assert.rejects(kit.roomService.joinRoom({ roomCode: "ZZZZZZ", playerId: "beto" }), rejectsWith("ROOM_NOT_FOUND"));
  await assert.rejects(kit.roomService.joinRoom({ roomCode: "bad!", playerId: "beto" }), rejectsWith("ROOM_NOT_FOUND"));
  await assert.rejects(kit.roomService.joinRoom({ roomCode: created.roomCode, playerId: "ghost" }), rejectsWith("PLAYER_NOT_FOUND"));
  await assert.rejects(kit.roomService.joinRoom({ roomCode: created.roomCode, playerId: "ana" }), rejectsWith("PLAYER_ALREADY_JOINED"));
  await kit.roomService.joinRoom({ roomCode: created.roomCode, playerId: "beto" });
  await assert.rejects(kit.roomService.joinRoom({ roomCode: created.roomCode, playerId: "beto" }), rejectsWith("PLAYER_ALREADY_JOINED"));
  await kit.roomService.joinRoom({ roomCode: created.roomCode, playerId: "cami" });
  await assert.rejects(kit.roomService.joinRoom({ roomCode: created.roomCode, playerId: "dani" }), rejectsWith("ROOM_FULL"));

  const started = await kit.createIdentifiedRoom("dani", "conn-dani");
  await kit.joinAndIdentify(started.roomCode, "eli");
  await kit.gameplay.startGame({ connectionId: "conn-dani" });
  await assert.rejects(kit.roomService.joinRoom({ roomCode: started.roomCode, playerId: "beto" }), rejectsWith("ROOM_ALREADY_STARTED"));

  kit.clock.now += 121 * 60_000;
  await assert.rejects(kit.roomService.joinRoom({ roomCode: created.roomCode, playerId: "eli" }), rejectsWith("ROOM_EXPIRED"));
});

test("a lost join race reports the authoritative reason, never a duplicate membership", async () => {
  const kit = createMultiplayerKit();
  const created = await kit.createIdentifiedRoom();
  const results = await Promise.allSettled([
    kit.roomService.joinRoom({ roomCode: created.roomCode, playerId: "beto" }),
    kit.roomService.joinRoom({ roomCode: created.roomCode, playerId: "beto" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(rejectsWith("PLAYER_ALREADY_JOINED")(rejected.reason));
  assert.equal((await kit.repository.listMembers(created.roomId)).length, 2);
});

test("question snapshot uses one difficulty in persisted order and room codes avoid ambiguous characters", async () => {
  const kit = createMultiplayerKit();
  const game = (await kit.games.findById("animals"))!;
  assert.deepEqual(selectRoomQuestionIds(game, "hard", 3), game.questions.filter((question) => question.difficulty === "hard").slice(0, 3).map((question) => question.id));
  assert.equal(selectRoomQuestionIds(game, undefined, 10).every((id) => id.includes("-easy-")), true);
  for (let index = 0; index < 200; index += 1) assert.match(randomRoomCodes.generate(), /^[A-HJKMNP-Z2-9]{6}$/);
});
