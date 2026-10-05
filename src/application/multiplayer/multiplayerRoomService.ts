import { randomUUID } from "node:crypto";

import type { Difficulty, Game } from "../../domain/game/types.ts";
import { emptyMultiplayerScore, isRoomExpired, type MultiplayerMember, type MultiplayerRoom } from "../../domain/multiplayer/types.ts";
import type { GameRepository } from "../../repositories/game/GameRepository.ts";
import { ApplicationError } from "../errors.ts";
import type { PlayerRepository } from "../player/PlayerRepository.ts";
import type {
  CreateMultiplayerRoomCommand,
  CreateMultiplayerRoomResponse,
  JoinMultiplayerRoomCommand,
  JoinMultiplayerRoomResponse,
  MultiplayerLogEvent,
  MultiplayerSettings,
} from "./contracts.ts";
import type { MultiplayerRoomNotifier } from "./multiplayerRoomNotifier.ts";
import { logHash, roomCodePattern } from "./participantTokens.ts";
import type { MultiplayerRepository, ParticipantTokenService, RoomCodeGenerator } from "./ports.ts";

const difficulties: readonly Difficulty[] = ["easy", "normal", "hard"];
const identifierPattern = /^[A-Za-z0-9._~-]{1,128}$/;
const maxRoomCodeAttempts = 5;

export interface MultiplayerRoomServiceDependencies {
  repository: MultiplayerRepository;
  games: GameRepository;
  players: PlayerRepository;
  tokens: ParticipantTokenService;
  roomCodes: RoomCodeGenerator;
  notifier: MultiplayerRoomNotifier;
  settings: MultiplayerSettings;
  now?: () => number;
  createId?: () => string;
  logEvent?: (event: MultiplayerLogEvent) => void;
}

/**
 * HTTP bootstrap for multiplayer rooms (ADR-018/020): creates rooms and
 * memberships and hands out the one-time participant token. Gameplay itself
 * happens over the WebSocket API.
 */
export class MultiplayerRoomService {
  private readonly deps: MultiplayerRoomServiceDependencies;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly logEvent: (event: MultiplayerLogEvent) => void;

  constructor(deps: MultiplayerRoomServiceDependencies) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? randomUUID;
    this.logEvent = deps.logEvent ?? (() => {});
  }

  async createRoom(command: CreateMultiplayerRoomCommand): Promise<CreateMultiplayerRoomResponse> {
    const { settings } = this.deps;
    const gameId = readIdentifier(command.gameId, "gameId");
    const playerId = readIdentifier(command.playerId, "playerId");
    const questionTimeLimitSeconds = command.questionTimeLimitSeconds ?? settings.defaultQuestionSeconds;
    if (
      !Number.isInteger(questionTimeLimitSeconds)
      || questionTimeLimitSeconds < settings.minQuestionSeconds
      || questionTimeLimitSeconds > settings.maxQuestionSeconds
    ) {
      throw new ApplicationError(
        "INVALID_REQUEST",
        `questionTimeLimitSeconds must be an integer between ${settings.minQuestionSeconds} and ${settings.maxQuestionSeconds}.`,
      );
    }
    if (command.difficulty !== undefined && !difficulties.includes(command.difficulty)) {
      throw new ApplicationError("INVALID_REQUEST", "difficulty is invalid.");
    }

    const [game, player] = await Promise.all([this.deps.games.findById(gameId), this.deps.players.getById(playerId)]);
    if (!game) throw new ApplicationError("RESOURCE_NOT_FOUND", "Game was not found.");
    if (!player) throw new ApplicationError("PLAYER_NOT_FOUND", "Player was not found.");
    const questionIds = selectRoomQuestionIds(game, command.difficulty, settings.questionsPerRoom);
    if (questionIds.length === 0) {
      throw new ApplicationError("INVALID_REQUEST", "This game has no playable questions for the selected difficulty.");
    }

    const now = this.now();
    const roomId = this.createId();
    const participantToken = this.deps.tokens.generate();
    const expiresAt = Math.ceil((now + settings.roomTtlMinutes * 60_000) / 1_000);
    const host: MultiplayerMember = {
      roomId,
      playerId,
      displayName: player.name,
      role: "HOST",
      participantTokenHash: this.deps.tokens.hash(participantToken),
      joinedAt: now,
      score: emptyMultiplayerScore(),
      expiresAt,
    };
    for (let attempt = 0; attempt < maxRoomCodeAttempts; attempt += 1) {
      const room: MultiplayerRoom = {
        roomId,
        roomCode: this.deps.roomCodes.generate(),
        gameId,
        hostPlayerId: playerId,
        status: "WAITING",
        questionIds,
        currentQuestionIndex: -1,
        questionState: "NOT_STARTED",
        questionTimeLimitSeconds,
        eligiblePlayerIds: [],
        answeredCount: 0,
        memberCount: 1,
        version: 1,
        createdAt: now,
        expiresAt,
      };
      if (await this.deps.repository.createRoom(room, host, now)) {
        this.logEvent({ event: "MULTIPLAYER_ROOM_CREATED", level: "info", correlationId: command.correlationId, roomId, roomCodeHash: logHash(room.roomCode), roomStatus: room.status, roomVersion: room.version, result: "created" });
        return { roomId, roomCode: room.roomCode, playerId, role: "HOST", participantToken, questionTimeLimitSeconds };
      }
    }
    throw new Error("Could not reserve a unique room code.");
  }

  async joinRoom(command: JoinMultiplayerRoomCommand): Promise<JoinMultiplayerRoomResponse> {
    const { repository, settings } = this.deps;
    const roomCode = normalizeRoomCode(command.roomCode);
    const playerId = readIdentifier(command.playerId, "playerId");
    const roomId = roomCode ? await repository.findRoomIdByCode(roomCode) : null;
    const room = roomId ? await repository.getRoom(roomId) : null;
    if (!room) throw new ApplicationError("ROOM_NOT_FOUND", "Room was not found.");
    const [player, existing] = await Promise.all([this.deps.players.getById(playerId), repository.getMember(room.roomId, playerId)]);
    assertJoinable(room, existing !== null, settings.maxPlayers, this.now());
    if (!player) throw new ApplicationError("PLAYER_NOT_FOUND", "Player was not found.");

    const now = this.now();
    const participantToken = this.deps.tokens.generate();
    const member: MultiplayerMember = {
      roomId: room.roomId,
      playerId,
      displayName: player.name,
      role: "PLAYER",
      participantTokenHash: this.deps.tokens.hash(participantToken),
      joinedAt: now,
      score: emptyMultiplayerScore(),
      expiresAt: room.expiresAt,
    };
    if (!await repository.addMember(member, { maxPlayers: settings.maxPlayers, nowMs: now })) {
      // Lost a race (duplicate join, start, expiry or capacity): report the authoritative reason.
      const [current, raced] = await Promise.all([repository.getRoom(room.roomId), repository.getMember(room.roomId, playerId)]);
      if (current) assertJoinable(current, raced !== null, settings.maxPlayers, this.now());
      throw new ApplicationError("INVALID_ROOM_STATE", "The room cannot accept new players.");
    }

    const updated = await repository.getRoom(room.roomId) ?? room;
    const view = await this.deps.notifier.view(updated);
    await this.deps.notifier.broadcast(updated.roomId, view.members, {
      type: "PLAYER_JOINED",
      roomId: updated.roomId,
      serverTime: this.now(),
      version: view.room.version,
      room: view.room,
      playerId,
    }, playerId);
    this.logEvent({ event: "MULTIPLAYER_PLAYER_JOINED", level: "info", correlationId: command.correlationId, roomId: room.roomId, roomCodeHash: logHash(room.roomCode), roomStatus: updated.status, roomVersion: updated.version, result: "joined" });
    return { roomId: room.roomId, roomCode: room.roomCode, playerId, role: "PLAYER", participantToken };
  }
}

function assertJoinable(room: MultiplayerRoom, alreadyMember: boolean, maxPlayers: number, nowMs: number): void {
  if (isRoomExpired(room, nowMs)) throw new ApplicationError("ROOM_EXPIRED", "Room has expired.");
  if (room.status !== "WAITING") throw new ApplicationError("ROOM_ALREADY_STARTED", "The game in this room has already started.");
  if (alreadyMember) throw new ApplicationError("PLAYER_ALREADY_JOINED", "This player already joined the room.");
  if (room.memberCount >= maxPlayers) throw new ApplicationError("ROOM_FULL", "The room is full.");
}

/**
 * Snapshots up to `count` question IDs in persisted order for one difficulty:
 * the requested one, or the first difficulty the game offers. Only questions
 * with exactly one correct answer are playable.
 */
export function selectRoomQuestionIds(game: Game, difficulty: Difficulty | undefined, count: number): string[] {
  const selected = difficulty ?? difficulties.find((candidate) => game.questions.some((question) => question.difficulty === candidate));
  return game.questions
    .filter((question) => question.difficulty === selected && question.answers.filter((answer) => answer.isCorrect).length === 1)
    .slice(0, count)
    .map((question) => question.id);
}

export function normalizeRoomCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return roomCodePattern.test(code) ? code : null;
}

function readIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) throw new ApplicationError("INVALID_REQUEST", `${name} is required.`);
  return value;
}
