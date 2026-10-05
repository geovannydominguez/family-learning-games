import assert from "node:assert/strict";
import test from "node:test";

import { GameSessionService } from "../../application/game/gameSessionService.ts";
import { createMultiplayerKit } from "../../application/multiplayer/multiplayerTestKit.ts";
import { PlayerService } from "../../application/player/playerService.ts";
import { InMemoryGameSessionRepository } from "../../infrastructure/repositories/InMemoryGameSessionRepository.ts";
import type { RequestLog } from "./contracts.ts";
import { createHttpRouter } from "./router.ts";

function setup(options: { enabled?: boolean; maxPlayers?: number } = {}) {
  const kit = createMultiplayerKit(options.maxPlayers ? { maxPlayers: options.maxPlayers } : {});
  const logs: RequestLog[] = [];
  const router = createHttpRouter({
    games: kit.games,
    sessionService: new GameSessionService(kit.games, new InMemoryGameSessionRepository(), kit.players),
    playerService: new PlayerService(kit.players),
    ...(options.enabled === false ? {} : { multiplayerRoomService: kit.roomService }),
    log: (record) => logs.push(record),
  });
  const post = (path: string, body: unknown) => router({ requestId: "r", method: "POST", path, body: JSON.stringify(body) });
  return { kit, logs, post };
}

test("POST /multiplayer/rooms creates a room for the host (201)", async () => {
  const { post } = setup();
  const response = await post("/multiplayer/rooms", { gameId: "animals", playerId: "ana", questionTimeLimitSeconds: 30 });
  assert.equal(response.statusCode, 201);
  const body = JSON.parse(response.body);
  assert.deepEqual(Object.keys(body).sort(), ["participantToken", "playerId", "questionTimeLimitSeconds", "role", "roomCode", "roomId"]);
  assert.equal(body.role, "HOST");
  assert.match(body.roomCode, /^[A-Z2-9]{6}$/);
  assert.equal(response.body.includes("isCorrect"), false);
});

test("POST /multiplayer/rooms rejects invalid input with the standard error envelope", async () => {
  const { post } = setup();
  const cases: Array<[unknown, number, string]> = [
    [{ gameId: "animals" }, 400, "INVALID_REQUEST"],
    [{ gameId: "animals", playerId: "ana", questionTimeLimitSeconds: 5 }, 400, "INVALID_REQUEST"],
    [{ gameId: "animals", playerId: "ana", questionTimeLimitSeconds: "30" }, 400, "INVALID_REQUEST"],
    [{ gameId: "nope", playerId: "ana" }, 404, "RESOURCE_NOT_FOUND"],
    [{ gameId: "animals", playerId: "ghost" }, 404, "PLAYER_NOT_FOUND"],
  ];
  for (const [body, status, code] of cases) {
    const response = await post("/multiplayer/rooms", body);
    assert.equal(response.statusCode, status, JSON.stringify(body));
    assert.equal(JSON.parse(response.body).error.code, code);
  }
});

test("POST /multiplayer/rooms/{roomCode}/join covers join, invalid, expired, started, duplicate and full rooms", async () => {
  const { kit, post, logs } = setup({ maxPlayers: 3 });
  const created = JSON.parse((await post("/multiplayer/rooms", { gameId: "animals", playerId: "ana" })).body);

  const joined = await post(`/multiplayer/rooms/${created.roomCode}/join`, { playerId: "beto" });
  assert.equal(joined.statusCode, 201);
  assert.deepEqual({ ...JSON.parse(joined.body), participantToken: "t" }, { roomId: created.roomId, roomCode: created.roomCode, playerId: "beto", role: "PLAYER", participantToken: "t" });

  const expectError = async (path: string, body: unknown, status: number, code: string) => {
    const response = await post(path, body);
    assert.equal(response.statusCode, status, `${path} ${code}`);
    assert.deepEqual(Object.keys(JSON.parse(response.body)), ["error"]);
    assert.equal(JSON.parse(response.body).error.code, code);
  };
  await expectError("/multiplayer/rooms/ZZZZZZ/join", { playerId: "cami" }, 404, "ROOM_NOT_FOUND");
  await expectError(`/multiplayer/rooms/${created.roomCode}/join`, { playerId: "beto" }, 409, "PLAYER_ALREADY_JOINED");
  await expectError(`/multiplayer/rooms/${created.roomCode}/join`, {}, 400, "INVALID_REQUEST");
  await post(`/multiplayer/rooms/${created.roomCode}/join`, { playerId: "cami" });
  await expectError(`/multiplayer/rooms/${created.roomCode}/join`, { playerId: "dani" }, 409, "ROOM_FULL");

  const other = JSON.parse((await post("/multiplayer/rooms", { gameId: "animals", playerId: "dani" })).body);
  const otherJoin = JSON.parse((await post(`/multiplayer/rooms/${other.roomCode}/join`, { playerId: "eli" })).body);
  await kit.gameplay.identify({ connectionId: "c-dani", roomCode: other.roomCode, playerId: "dani", participantToken: other.participantToken });
  await kit.gameplay.identify({ connectionId: "c-eli", roomCode: other.roomCode, playerId: "eli", participantToken: otherJoin.participantToken });
  await kit.gameplay.startGame({ connectionId: "c-dani" });
  await expectError(`/multiplayer/rooms/${other.roomCode}/join`, { playerId: "beto" }, 409, "ROOM_ALREADY_STARTED");

  kit.clock.now += 3 * 60 * 60_000;
  await expectError(`/multiplayer/rooms/${created.roomCode}/join`, { playerId: "eli" }, 410, "ROOM_EXPIRED");

  // Request logs keep the route shape only.
  assert.equal(JSON.stringify(logs).includes(created.roomCode), false);
  assert.ok(logs.some((log) => log.path === "/multiplayer/rooms/{roomCode}/join"));
});

test("multiplayer routes answer 503 MULTIPLAYER_DISABLED when no multiplayer table is configured", async () => {
  const { post } = setup({ enabled: false });
  for (const path of ["/multiplayer/rooms", "/multiplayer/rooms/AB7K2M/join"]) {
    const response = await post(path, { gameId: "animals", playerId: "ana" });
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.body).error.code, "MULTIPLAYER_DISABLED");
  }
});
