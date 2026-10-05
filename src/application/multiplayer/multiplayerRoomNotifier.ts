import type { Game, Question } from "../../domain/game/types.ts";
import { rankScores } from "../../domain/multiplayer/scoring.ts";
import { effectiveRoomStatus, type MultiplayerAnswer, type MultiplayerMember, type MultiplayerRoom } from "../../domain/multiplayer/types.ts";
import type { GameRepository } from "../../repositories/game/GameRepository.ts";
import type { PublicQuestion } from "../game/gameSessionContracts.ts";
import { safeErrorName } from "../media/mediaEvents.ts";
import type { QuestionImageResolver } from "../media/questionImages.ts";
import type { MultiplayerLogEvent, MultiplayerServerEvent, MultiplayerSelf, PublicMultiplayerRoom, ScoreboardEntry } from "./contracts.ts";
import { logHash } from "./participantTokens.ts";
import type { MultiplayerBroadcaster, MultiplayerRepository } from "./ports.ts";

export interface RoomView {
  room: PublicMultiplayerRoom;
  members: MultiplayerMember[];
  answers: MultiplayerAnswer[];
}

export interface MultiplayerNotifierDependencies {
  repository: MultiplayerRepository;
  games: GameRepository;
  broadcaster: MultiplayerBroadcaster;
  imageResolver?: QuestionImageResolver;
  now: () => number;
  logEvent: (event: MultiplayerLogEvent) => void;
}

/**
 * Builds safe room snapshots and pushes events to room members. Shared by the
 * HTTP bootstrap (join notifications) and the WebSocket gameplay service.
 */
export class MultiplayerRoomNotifier {
  private readonly deps: MultiplayerNotifierDependencies;

  constructor(deps: MultiplayerNotifierDependencies) {
    this.deps = deps;
  }

  async view(room: MultiplayerRoom, members?: MultiplayerMember[]): Promise<RoomView> {
    const [game, roster] = await Promise.all([
      this.deps.games.findById(room.gameId),
      members ? Promise.resolve(members) : this.deps.repository.listMembers(room.roomId),
    ]);
    const questionId = room.questionIds[room.currentQuestionIndex];
    const question = questionId ? findQuestion(game, questionId) : undefined;
    const answers = questionId ? await this.deps.repository.listAnswers(room.roomId, questionId) : [];
    const reveal = room.questionState === "REVEALED" && room.lastReveal?.questionId === questionId ? room.lastReveal : undefined;
    return {
      members: roster,
      answers,
      room: {
        roomId: room.roomId,
        roomCode: room.roomCode,
        gameId: room.gameId,
        gameTitle: game?.title ?? "",
        hostPlayerId: room.hostPlayerId,
        status: effectiveRoomStatus(room, this.deps.now()),
        questionState: room.questionState,
        questionNumber: room.currentQuestionIndex + 1,
        totalQuestions: room.questionIds.length,
        questionTimeLimitSeconds: room.questionTimeLimitSeconds,
        ...(room.questionStartedAt !== undefined ? { questionStartedAt: room.questionStartedAt } : {}),
        ...(room.questionDeadlineAt !== undefined ? { questionDeadlineAt: room.questionDeadlineAt } : {}),
        members: [...roster]
          .sort((left, right) => left.joinedAt - right.joinedAt || left.playerId.localeCompare(right.playerId))
          .map((member) => ({ playerId: member.playerId, displayName: member.displayName, role: member.role, connected: Boolean(member.connectionId) })),
        answeredPlayerIds: answers.map((answer) => answer.playerId).sort(),
        ...(question ? { currentQuestion: await this.toPublicQuestion(question) } : {}),
        ...(reveal ? { reveal } : {}),
        scoreboard: scoreboard(roster),
        version: room.version,
      },
    };
  }

  /** Personal ROOM_STATE for one connection (IDENTIFY / SYNC_ROOM). */
  async sendRoomState(connectionId: string, view: RoomView, playerId: string, requestId?: string): Promise<void> {
    const member = view.members.find((candidate) => candidate.playerId === playerId);
    const answer = view.answers.find((candidate) => candidate.playerId === playerId);
    const self: MultiplayerSelf | undefined = member
      ? { playerId, role: member.role, ...(answer ? { currentAnswerId: answer.answerId } : {}) }
      : undefined;
    await this.send(connectionId, {
      type: "ROOM_STATE",
      roomId: view.room.roomId,
      serverTime: this.deps.now(),
      version: view.room.version,
      room: view.room,
      ...(self ? { self } : {}),
      ...(requestId ? { requestId } : {}),
    });
  }

  /**
   * Sends `event` to every connected member (optionally except one player).
   * A stale or failing connection never stops delivery to the others.
   */
  async broadcast(roomId: string, members: readonly MultiplayerMember[], event: MultiplayerServerEvent, exceptPlayerId?: string): Promise<void> {
    await Promise.all(members
      .filter((member) => member.connectionId && member.playerId !== exceptPlayerId)
      .map((member) => this.send(member.connectionId as string, event, roomId)));
  }

  async send(connectionId: string, event: MultiplayerServerEvent, roomId = event.roomId): Promise<void> {
    try {
      const outcome = await this.deps.broadcaster.send(connectionId, event);
      if (outcome === "gone") {
        await this.deps.repository.releaseConnection(connectionId);
        this.deps.logEvent({ event: "MULTIPLAYER_BROADCAST_STALE_CONNECTION", level: "warn", roomId, connectionIdHash: logHash(connectionId), action: event.type });
      }
    } catch (error) {
      this.deps.logEvent({ event: "MULTIPLAYER_BROADCAST_FAILED", level: "error", roomId, connectionIdHash: logHash(connectionId), action: event.type, errorName: safeErrorName(error) });
    }
  }

  private async toPublicQuestion(question: Question): Promise<PublicQuestion> {
    const image = this.deps.imageResolver ? await this.deps.imageResolver.resolve(question.media?.image) : undefined;
    return {
      id: question.id,
      text: question.text,
      emoji: question.emoji,
      image: question.image,
      ...(image ? { media: { image } } : {}),
      answers: question.answers.map(({ id, text }) => ({ id, text })),
    };
  }
}

export function findQuestion(game: Game | null, questionId: string): Question | undefined {
  return game?.questions.find((question) => question.id === questionId);
}

export function scoreboard(members: readonly MultiplayerMember[]): ScoreboardEntry[] {
  return rankScores(members.map((member) => ({ playerId: member.playerId, displayName: member.displayName, score: member.score })))
    .map(({ playerId, displayName, score, rank }) => ({ playerId, displayName, rank, ...score }));
}
