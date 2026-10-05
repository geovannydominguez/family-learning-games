import { calculateQuestionResults, scoreDelta } from "../../domain/multiplayer/scoring.ts";
import { isQuestionClosable, isRoomExpired, type MultiplayerMember, type MultiplayerRoom } from "../../domain/multiplayer/types.ts";
import type { GameRepository } from "../../repositories/game/GameRepository.ts";
import { ApplicationError } from "../errors.ts";
import type { MultiplayerClientAction, MultiplayerLogEvent, MultiplayerSettings } from "./contracts.ts";
import { findQuestion, scoreboard, type MultiplayerRoomNotifier } from "./multiplayerRoomNotifier.ts";
import { normalizeRoomCode } from "./multiplayerRoomService.ts";
import { logHash } from "./participantTokens.ts";
import type { MultiplayerRepository, ParticipantTokenService, QuestionOpening } from "./ports.ts";

export interface MultiplayerGameplayDependencies {
  repository: MultiplayerRepository;
  games: GameRepository;
  tokens: ParticipantTokenService;
  notifier: MultiplayerRoomNotifier;
  settings: MultiplayerSettings;
  /** Frontend origins allowed to open the WebSocket (configuration, never hardcoded). */
  allowedOrigins: readonly string[];
  now?: () => number;
  logEvent?: (event: MultiplayerLogEvent) => void;
}

export interface CommandContext {
  connectionId: string;
  requestId?: string;
  correlationId?: string;
}

export interface IdentifyCommand extends CommandContext {
  roomCode: unknown;
  playerId: unknown;
  participantToken: unknown;
}

interface Caller {
  room: MultiplayerRoom;
  member: MultiplayerMember;
}

const maxTransitionAttempts = 4;
const identifierPattern = /^[A-Za-z0-9._~-]{1,128}$/;

/**
 * Server-authoritative multiplayer gameplay (ADR-019). Clients only send
 * intents; this service decides state, timing, correctness, scoring and rank,
 * and every transition is a conditional write so duplicate or concurrent
 * commands (retries, several QUESTION_TIMEOUTs, last answer vs. timeout)
 * apply exactly once.
 */
export class MultiplayerGameplayService {
  private readonly deps: MultiplayerGameplayDependencies;
  private readonly now: () => number;
  private readonly logEvent: (event: MultiplayerLogEvent) => void;

  constructor(deps: MultiplayerGameplayDependencies) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.logEvent = deps.logEvent ?? (() => {});
  }

  /** `$connect`: transport policy only. The connection stays unidentified until IDENTIFY. */
  connect(connectionId: string, origin: string | undefined): boolean {
    const allowed = origin !== undefined && this.deps.allowedOrigins.includes(origin);
    if (!allowed) {
      this.logEvent({ event: "MULTIPLAYER_PROTOCOL_REJECTED", level: "warn", connectionIdHash: logHash(connectionId), action: "$connect", result: "origin-not-allowed" });
    }
    return allowed;
  }

  /** `$disconnect` is best-effort; stale mappings are also cleaned on broadcast and by TTL. */
  async disconnect(context: CommandContext): Promise<void> {
    const released = await this.deps.repository.releaseConnection(context.connectionId);
    if (!released?.wasActive) return;
    this.logEvent({ event: "MULTIPLAYER_DISCONNECTED", level: "info", correlationId: context.correlationId, roomId: released.roomId, connectionIdHash: logHash(context.connectionId), action: "$disconnect" });
    const room = await this.deps.repository.getRoom(released.roomId);
    if (!room || isRoomExpired(room, this.now())) return;
    const view = await this.deps.notifier.view(room);
    await this.deps.notifier.broadcast(room.roomId, view.members, {
      type: "PLAYER_DISCONNECTED", roomId: room.roomId, serverTime: this.now(), version: view.room.version, room: view.room, playerId: released.playerId,
    });
  }

  async identify(command: IdentifyCommand): Promise<void> {
    const { repository, tokens } = this.deps;
    const roomCode = normalizeRoomCode(command.roomCode);
    const roomId = roomCode ? await repository.findRoomIdByCode(roomCode) : null;
    const found = roomId ? await repository.getRoom(roomId) : null;
    if (!found) throw new ApplicationError("ROOM_NOT_FOUND", "Room was not found.");
    if (isRoomExpired(found, this.now())) throw new ApplicationError("ROOM_EXPIRED", "Room has expired.");
    const playerId = typeof command.playerId === "string" && identifierPattern.test(command.playerId) ? command.playerId : null;
    const member = playerId ? await repository.getMember(found.roomId, playerId) : null;
    // Same error for an unknown member and a wrong token: never reveals which part failed.
    if (!member || typeof command.participantToken !== "string" || command.participantToken.length > 256
      || !tokens.matches(command.participantToken, member.participantTokenHash)) {
      throw new ApplicationError("INVALID_PARTICIPANT_TOKEN", "The room membership could not be verified.");
    }

    const reconnect = member.connectionId !== undefined || found.status !== "WAITING";
    // A socket acts for one membership at a time: drop any other binding it had.
    const previous = await repository.getConnection(command.connectionId);
    if (previous && (previous.roomId !== found.roomId || previous.playerId !== member.playerId)) {
      await repository.releaseConnection(command.connectionId);
    }
    await repository.bindConnection({
      roomId: found.roomId,
      playerId: member.playerId,
      connectionId: command.connectionId,
      ...(member.connectionId && member.connectionId !== command.connectionId ? { previousConnectionId: member.connectionId } : {}),
      expiresAt: found.expiresAt,
      nowMs: this.now(),
    });
    this.logEvent({
      event: reconnect ? "MULTIPLAYER_RECONNECTED" : "MULTIPLAYER_CONNECTED",
      level: "info",
      correlationId: command.correlationId,
      roomId: found.roomId,
      roomCodeHash: logHash(found.roomCode),
      connectionIdHash: logHash(command.connectionId),
      action: "IDENTIFY",
      roomStatus: found.status,
      questionState: found.questionState,
    });

    await this.revealIfClosable(found.roomId, command.correlationId);
    const room = await repository.getRoom(found.roomId) ?? found;
    const view = await this.deps.notifier.view(room);
    await this.deps.notifier.sendRoomState(command.connectionId, view, member.playerId, command.requestId);
    await this.deps.notifier.broadcast(room.roomId, view.members, {
      type: "ROOM_STATE", roomId: room.roomId, serverTime: this.now(), version: view.room.version, room: view.room,
    }, member.playerId);
  }

  async syncRoom(context: CommandContext): Promise<void> {
    const caller = await this.resolveCaller(context.connectionId);
    await this.revealIfClosable(caller.room.roomId, context.correlationId);
    const room = await this.deps.repository.getRoom(caller.room.roomId) ?? caller.room;
    await this.deps.notifier.sendRoomState(context.connectionId, await this.deps.notifier.view(room), caller.member.playerId, context.requestId);
  }

  async startGame(context: CommandContext): Promise<void> {
    const { repository, settings } = this.deps;
    let { room } = await this.resolveHost(context.connectionId, "START_GAME");
    for (let attempt = 0; attempt < maxTransitionAttempts; attempt += 1) {
      if (room.status !== "WAITING") {
        // Duplicate START_GAME: already applied, answer with the authoritative state.
        await this.sendState(context, room);
        return;
      }
      const members = await repository.listMembers(room.roomId);
      if (members.length < settings.minPlayers) {
        throw new ApplicationError("NOT_ENOUGH_PLAYERS", `At least ${settings.minPlayers} players are needed to start.`);
      }
      const game = await this.deps.games.findById(room.gameId);
      if (!game || !findQuestion(game, room.questionIds[0])) {
        throw new ApplicationError("INVALID_ROOM_STATE", "This room's game is no longer available.");
      }
      if (await repository.startRoom(room.roomId, room.version, this.opening(room, 0, members))) {
        const started = await repository.getRoom(room.roomId) ?? room;
        const view = await this.deps.notifier.view(started, members);
        const base = { roomId: started.roomId, version: view.room.version, room: view.room };
        await this.deps.notifier.broadcast(started.roomId, members, { type: "GAME_STARTED", serverTime: this.now(), ...base });
        await this.deps.notifier.broadcast(started.roomId, members, { type: "QUESTION_OPENED", serverTime: this.now(), ...base });
        this.logEvent({ event: "MULTIPLAYER_GAME_STARTED", level: "info", correlationId: context.correlationId, roomId: started.roomId, action: "START_GAME", questionId: started.questionIds[0], roomStatus: started.status, questionState: started.questionState, roomVersion: started.version });
        return;
      }
      // A concurrent join or start changed the room: re-read and re-validate.
      room = await this.requireRoom(room.roomId);
    }
    throw new ApplicationError("INVALID_ROOM_STATE", "The room changed while starting. Try again.");
  }

  async submitAnswer(context: CommandContext, payload: { questionId: unknown; answerId: unknown }): Promise<void> {
    const startedAt = this.now();
    const { room, member } = await this.resolveCaller(context.connectionId);
    if (room.status !== "IN_PROGRESS") throw new ApplicationError("INVALID_ROOM_STATE", "The game is not in progress.");
    const questionId = room.questionIds[room.currentQuestionIndex];
    if (payload.questionId !== questionId) throw new ApplicationError("INVALID_QUESTION", "Answers are only accepted for the current question.");
    if (room.questionState !== "OPEN") throw new ApplicationError("INVALID_QUESTION_STATE", "The current question is not open.");
    if (!room.eligiblePlayerIds.includes(member.playerId)) throw new ApplicationError("INVALID_ROOM_STATE", "This player cannot answer the current question.");
    const now = this.now();
    if (room.questionDeadlineAt === undefined || now >= room.questionDeadlineAt) {
      await this.revealIfClosable(room.roomId, context.correlationId);
      throw new ApplicationError("ANSWER_DEADLINE_EXPIRED", "The time to answer this question is over.");
    }
    const question = findQuestion(await this.deps.games.findById(room.gameId), questionId);
    const option = question?.answers.find((candidate) => candidate.id === payload.answerId);
    if (!option) throw new ApplicationError("INVALID_ANSWER", "The answer does not belong to the current question.");

    const outcome = await this.deps.repository.recordAnswer({
      roomId: room.roomId,
      questionId,
      playerId: member.playerId,
      answerId: option.id,
      serverReceivedAtMs: now,
      responseDurationMs: Math.max(0, now - (room.questionStartedAt ?? now)),
      isCorrect: option.isCorrect,
      expiresAt: room.expiresAt,
    }, room.currentQuestionIndex, now);
    if (outcome === "duplicate") throw new ApplicationError("ANSWER_ALREADY_SUBMITTED", "An answer was already submitted for this question.");
    if (outcome === "closed") {
      await this.revealIfClosable(room.roomId, context.correlationId);
      throw new ApplicationError("ANSWER_DEADLINE_EXPIRED", "The question closed before the answer was received.");
    }

    const updated = await this.requireRoom(room.roomId);
    const members = await this.deps.repository.listMembers(room.roomId);
    // The ACK never reveals correctness; only the sender learns its own answerId.
    const ack = { type: "ANSWER_ACCEPTED" as const, roomId: room.roomId, serverTime: this.now(), version: updated.version, questionId, playerId: member.playerId, answeredCount: updated.answeredCount };
    await this.deps.notifier.send(context.connectionId, { ...ack, answerId: option.id, ...(context.requestId ? { requestId: context.requestId } : {}) });
    await this.deps.notifier.broadcast(room.roomId, members, ack, member.playerId);
    this.logEvent({ event: "MULTIPLAYER_ANSWER_ACCEPTED", level: "info", correlationId: context.correlationId, roomId: room.roomId, action: "SUBMIT_ANSWER", questionId, roomVersion: updated.version, durationMs: Math.max(0, this.now() - startedAt) });

    await this.revealIfClosable(room.roomId, context.correlationId);
  }

  /** Client countdown hit zero. Only a trigger: the server re-checks its own deadline. */
  async questionTimeout(context: CommandContext, payload: { questionId?: unknown }): Promise<void> {
    const { room } = await this.resolveCaller(context.connectionId);
    const questionId = room.questionIds[room.currentQuestionIndex];
    // Stale timers and duplicates after the reveal are harmless no-ops.
    if (room.status !== "IN_PROGRESS" || room.questionState !== "OPEN") return;
    if (payload.questionId !== undefined && payload.questionId !== questionId) return;
    if (room.questionDeadlineAt !== undefined && this.now() < room.questionDeadlineAt && room.answeredCount < room.eligiblePlayerIds.length) {
      throw new ApplicationError("INVALID_QUESTION_STATE", "The question deadline has not been reached yet.");
    }
    await this.revealIfClosable(room.roomId, context.correlationId);
  }

  async nextQuestion(context: CommandContext): Promise<void> {
    const { room } = await this.resolveHost(context.connectionId, "NEXT_QUESTION");
    if (room.status !== "IN_PROGRESS") throw new ApplicationError("INVALID_ROOM_STATE", "The game is not in progress.");
    if (room.questionState !== "REVEALED") {
      await this.revealIfClosable(room.roomId, context.correlationId);
      throw new ApplicationError("INVALID_QUESTION_STATE", "The current question has not been revealed yet.");
    }
    const nextIndex = room.currentQuestionIndex + 1;
    if (nextIndex >= room.questionIds.length) throw new ApplicationError("INVALID_ROOM_STATE", "There are no more questions.");
    const members = await this.deps.repository.listMembers(room.roomId);
    if (!await this.deps.repository.openNextQuestion(room.roomId, room.currentQuestionIndex, this.opening(room, nextIndex, members))) {
      const current = await this.requireRoom(room.roomId);
      if (current.currentQuestionIndex >= nextIndex) return this.sendState(context, current); // duplicate NEXT_QUESTION
      throw new ApplicationError("INVALID_QUESTION_STATE", "The next question could not be opened.");
    }
    const opened = await this.requireRoom(room.roomId);
    const view = await this.deps.notifier.view(opened, members);
    await this.deps.notifier.broadcast(opened.roomId, members, { type: "QUESTION_OPENED", roomId: opened.roomId, serverTime: this.now(), version: view.room.version, room: view.room });
  }

  /** Safe ERROR event to one connection: public code and message only, never internal details. */
  async sendError(context: CommandContext, error: { code: string; message: string }, action: string, roomId?: string): Promise<void> {
    this.logEvent({ event: "MULTIPLAYER_PROTOCOL_REJECTED", level: "warn", correlationId: context.correlationId, connectionIdHash: logHash(context.connectionId), action, result: error.code, ...(roomId ? { roomId } : {}) });
    await this.deps.notifier.send(context.connectionId, {
      type: "ERROR",
      serverTime: this.now(),
      ...(roomId ? { roomId } : {}),
      ...(context.requestId ? { requestId: context.requestId } : {}),
      error: { code: error.code, message: error.message },
    }, roomId ?? "");
  }

  /**
   * Closes the current question if every eligible player answered or the
   * server deadline passed. The conditional OPEN → REVEALED write (which also
   * applies the score deltas) succeeds for exactly one invocation; it fails
   * and is retried if an answer landed after the answers were read.
   */
  private async revealIfClosable(roomId: string, correlationId?: string): Promise<boolean> {
    const { repository, settings } = this.deps;
    for (let attempt = 0; attempt < maxTransitionAttempts; attempt += 1) {
      const room = await repository.getRoom(roomId);
      if (!room || isRoomExpired(room, this.now()) || !isQuestionClosable(room, this.now())) return false;
      const questionId = room.questionIds[room.currentQuestionIndex];
      const answers = await repository.listAnswers(roomId, questionId);
      const correctAnswerId = findQuestion(await this.deps.games.findById(room.gameId), questionId)?.answers.find((answer) => answer.isCorrect)?.id;
      if (!correctAnswerId) throw new ApplicationError("INVALID_ROOM_STATE", "The current question cannot be scored.");
      const results = calculateQuestionResults(answers, room.eligiblePlayerIds, settings.placementTieWindowMs);
      const finish = room.currentQuestionIndex >= room.questionIds.length - 1;
      const applied = await repository.revealQuestion({
        roomId,
        questionIndex: room.currentQuestionIndex,
        expectedAnsweredCount: answers.length,
        reveal: { questionId, correctAnswerId, results },
        scoreDeltas: results.filter((result) => result.isCorrect).map((result) => ({ playerId: result.playerId, delta: scoreDelta(result) })),
        finish,
      });
      if (!applied) continue;

      const revealed = await this.requireRoom(roomId);
      const members = await repository.listMembers(roomId);
      const view = await this.deps.notifier.view(revealed, members);
      const board = scoreboard(members);
      const base = { roomId, version: view.room.version };
      await this.deps.notifier.broadcast(roomId, members, { type: "QUESTION_REVEALED", serverTime: this.now(), ...base, room: view.room, questionId, correctAnswerId, results, scoreboard: board });
      await this.deps.notifier.broadcast(roomId, members, { type: "SCOREBOARD_UPDATED", serverTime: this.now(), ...base, scoreboard: board });
      this.logEvent({ event: "MULTIPLAYER_QUESTION_REVEALED", level: "info", correlationId, roomId, questionId, roomStatus: revealed.status, questionState: revealed.questionState, roomVersion: revealed.version, result: room.answeredCount >= room.eligiblePlayerIds.length ? "all-answered" : "deadline" });
      if (finish) {
        await this.deps.notifier.broadcast(roomId, members, { type: "GAME_FINISHED", serverTime: this.now(), ...base, room: view.room, podium: board });
        this.logEvent({ event: "MULTIPLAYER_GAME_FINISHED", level: "info", correlationId, roomId, roomStatus: revealed.status, roomVersion: revealed.version });
      }
      return true;
    }
    return false;
  }

  private opening(room: MultiplayerRoom, questionIndex: number, members: readonly MultiplayerMember[]): QuestionOpening {
    const now = this.now();
    return {
      questionIndex,
      questionStartedAt: now,
      questionDeadlineAt: now + room.questionTimeLimitSeconds * 1_000,
      eligiblePlayerIds: members.map((member) => member.playerId).sort(),
    };
  }

  private async sendState(context: CommandContext, room: MultiplayerRoom): Promise<void> {
    const binding = await this.deps.repository.getConnection(context.connectionId);
    await this.deps.notifier.sendRoomState(context.connectionId, await this.deps.notifier.view(room), binding?.playerId ?? "", context.requestId);
  }

  private async resolveHost(connectionId: string, action: MultiplayerClientAction): Promise<Caller> {
    const caller = await this.resolveCaller(connectionId);
    if (caller.member.role !== "HOST") throw new ApplicationError("HOST_ONLY_ACTION", `Only the host can send ${action}.`);
    return caller;
  }

  /** Only the latest identified connection of a member may act for it. */
  private async resolveCaller(connectionId: string): Promise<Caller> {
    const binding = await this.deps.repository.getConnection(connectionId);
    const member = binding ? await this.deps.repository.getMember(binding.roomId, binding.playerId) : null;
    if (!binding || !member || member.connectionId !== connectionId) {
      throw new ApplicationError("NOT_IDENTIFIED", "Identify this connection before sending room commands.");
    }
    const room = await this.requireRoom(binding.roomId);
    if (isRoomExpired(room, this.now())) throw new ApplicationError("ROOM_EXPIRED", "Room has expired.");
    return { room, member };
  }

  private async requireRoom(roomId: string): Promise<MultiplayerRoom> {
    const room = await this.deps.repository.getRoom(roomId);
    if (!room) throw new ApplicationError("ROOM_NOT_FOUND", "Room was not found.");
    return room;
  }
}
