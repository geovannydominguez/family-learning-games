/**
 * Test-only wiring for multiplayer services: in-memory repository, a
 * controllable clock, a recording broadcaster and seeded family players.
 * Never imported by runtime code.
 */
import type { Player } from "../../domain/player/types.ts";
import { InMemoryMultiplayerRepository } from "../../infrastructure/multiplayer/InMemoryMultiplayerRepository.ts";
import { InMemoryPlayerRepository } from "../../infrastructure/repositories/InMemoryPlayerRepository.ts";
import { MockGameRepository } from "../../repositories/game/MockGameRepository.ts";
import { defaultMultiplayerSettings, type MultiplayerLogEvent, type MultiplayerServerEvent, type MultiplayerSettings } from "./contracts.ts";
import { MultiplayerGameplayService } from "./multiplayerGameplayService.ts";
import { MultiplayerRoomNotifier } from "./multiplayerRoomNotifier.ts";
import { MultiplayerRoomService } from "./multiplayerRoomService.ts";
import { participantTokens } from "./participantTokens.ts";

export const testOrigin = "https://play.example.com";

export function createMultiplayerKit(overrides: Partial<MultiplayerSettings> = {}) {
  const clock = { now: Date.UTC(2026, 9, 4, 12, 0, 0) };
  const now = () => clock.now;
  const games = new MockGameRepository();
  const players = new InMemoryPlayerRepository();
  for (const [playerId, name] of [["ana", "Ana"], ["beto", "Beto"], ["cami", "Cami"], ["dani", "Dani"], ["eli", "Eli"]]) {
    const player: Player = { playerId, name, age: 8, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    void players.create(player);
  }
  const repository = new InMemoryMultiplayerRepository();
  const sent: Array<{ connectionId: string; event: MultiplayerServerEvent }> = [];
  const gone = new Set<string>();
  const logs: MultiplayerLogEvent[] = [];
  const codes: string[] = [];
  let codeSequence = 0;
  const settings = { ...defaultMultiplayerSettings, ...overrides };
  const broadcaster = {
    send: async (connectionId: string, event: MultiplayerServerEvent) => {
      if (gone.has(connectionId)) return "gone" as const;
      sent.push({ connectionId, event: structuredClone(event) });
      return "delivered" as const;
    },
  };
  const logEvent = (event: MultiplayerLogEvent) => logs.push(event);
  const notifier = new MultiplayerRoomNotifier({ repository, games, broadcaster, now, logEvent });
  let roomSequence = 0;
  const roomService = new MultiplayerRoomService({
    repository,
    games,
    players,
    tokens: participantTokens,
    roomCodes: { generate: () => codes.shift() ?? `RMXA${"ABCDEFGHJK"[Math.floor(codeSequence / 10) % 10]}${"ABCDEFGHJK"[codeSequence++ % 10]}` },
    notifier,
    settings,
    now,
    createId: () => `room-${++roomSequence}`,
    logEvent,
  });
  const gameplay = new MultiplayerGameplayService({ repository, games, tokens: participantTokens, notifier, settings, allowedOrigins: [testOrigin], now, logEvent });

  async function correctAnswerId(questionId: string): Promise<string> {
    const game = await games.findById("animals");
    return game!.questions.find((question) => question.id === questionId)!.answers.find((answer) => answer.isCorrect)!.id;
  }

  async function wrongAnswerId(questionId: string): Promise<string> {
    const game = await games.findById("animals");
    return game!.questions.find((question) => question.id === questionId)!.answers.find((answer) => !answer.isCorrect)!.id;
  }

  /** Host creates a room on the seeded "animals" game and identifies `connectionId`. */
  async function createIdentifiedRoom(hostId = "ana", connectionId = `conn-${hostId}`, timeLimit = 30) {
    const created = await roomService.createRoom({ gameId: "animals", playerId: hostId, questionTimeLimitSeconds: timeLimit, difficulty: "easy" });
    await gameplay.identify({ connectionId, roomCode: created.roomCode, playerId: hostId, participantToken: created.participantToken });
    return created;
  }

  async function joinAndIdentify(roomCode: string, playerId: string, connectionId = `conn-${playerId}`) {
    const joined = await roomService.joinRoom({ roomCode, playerId });
    await gameplay.identify({ connectionId, roomCode, playerId, participantToken: joined.participantToken });
    return joined;
  }

  /** Host + the given players, all identified, game started on question 1. */
  async function startedRoom(playerIds: string[] = ["beto"], timeLimit = 30) {
    const created = await createIdentifiedRoom("ana", "conn-ana", timeLimit);
    for (const playerId of playerIds) await joinAndIdentify(created.roomCode, playerId);
    await gameplay.startGame({ connectionId: "conn-ana" });
    const room = (await repository.getRoom(created.roomId))!;
    return { created, room, questionId: room.questionIds[0] };
  }

  function eventsFor(connectionId: string, type?: MultiplayerServerEvent["type"]): MultiplayerServerEvent[] {
    return sent.filter((entry) => entry.connectionId === connectionId && (!type || entry.event.type === type)).map((entry) => entry.event);
  }

  function lastEvent<T extends MultiplayerServerEvent["type"]>(connectionId: string, type: T): Extract<MultiplayerServerEvent, { type: T }> {
    const events = eventsFor(connectionId, type);
    if (events.length === 0) throw new Error(`No ${type} event for ${connectionId}`);
    return events[events.length - 1] as Extract<MultiplayerServerEvent, { type: T }>;
  }

  return {
    clock, games, players, repository, sent, gone, logs, codes, settings, notifier, roomService, gameplay,
    correctAnswerId, wrongAnswerId, createIdentifiedRoom, joinAndIdentify, startedRoom, eventsFor, lastEvent,
  };
}
