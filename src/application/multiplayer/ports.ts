import type {
  MultiplayerAnswer,
  MultiplayerMember,
  MultiplayerReveal,
  MultiplayerRoom,
  MultiplayerScore,
} from "../../domain/multiplayer/types.ts";
import type { MultiplayerServerEvent } from "./contracts.ts";

/** Fields written when a question opens (first question on start, or the next one). */
export interface QuestionOpening {
  questionIndex: number;
  questionStartedAt: number;
  questionDeadlineAt: number;
  eligiblePlayerIds: string[];
}

export type RecordAnswerOutcome = "accepted" | "duplicate" | "closed";

export interface ConnectionBinding {
  roomId: string;
  playerId: string;
}

/**
 * Application-owned persistence port for ephemeral multiplayer coordination
 * (ADR-019). Every mutating method is a single conditional write or
 * transaction: it returns whether it was applied instead of overwriting
 * concurrent state, so duplicate commands are safe.
 */
export interface MultiplayerRepository {
  /** Reserves the room code and writes the room and host membership together. `false` on code collision. */
  createRoom(room: MultiplayerRoom, host: MultiplayerMember, nowMs: number): Promise<boolean>;
  /** Resolves a room code without scans. */
  findRoomIdByCode(roomCode: string): Promise<string | null>;
  getRoom(roomId: string): Promise<MultiplayerRoom | null>;
  getMember(roomId: string, playerId: string): Promise<MultiplayerMember | null>;
  listMembers(roomId: string): Promise<MultiplayerMember[]>;
  /** Adds a member while the room is WAITING, unexpired and below capacity. `false` otherwise or if already a member. */
  addMember(member: MultiplayerMember, limits: { maxPlayers: number; nowMs: number }): Promise<boolean>;
  /** WAITING → IN_PROGRESS and opens the first question, only from `expectedVersion`. */
  startRoom(roomId: string, expectedVersion: number, opening: QuestionOpening): Promise<boolean>;
  /** REVEALED → OPEN for `opening.questionIndex`, only from the previous index. */
  openNextQuestion(roomId: string, fromQuestionIndex: number, opening: QuestionOpening): Promise<boolean>;
  /** One answer per room/question/player, only while that question is OPEN and before its deadline. */
  recordAnswer(answer: MultiplayerAnswer, questionIndex: number, nowMs: number): Promise<RecordAnswerOutcome>;
  listAnswers(roomId: string, questionId: string): Promise<MultiplayerAnswer[]>;
  /**
   * OPEN → REVEALED exactly once, applying the score deltas in the same
   * atomic write. Applied only if the question is still OPEN and no answer
   * arrived after `expectedAnsweredCount` was read. `finish` also moves the
   * room to FINISHED (last question).
   */
  revealQuestion(input: {
    roomId: string;
    questionIndex: number;
    expectedAnsweredCount: number;
    reveal: MultiplayerReveal;
    scoreDeltas: Array<{ playerId: string; delta: MultiplayerScore }>;
    finish: boolean;
  }): Promise<boolean>;
  /** Latest validated connection wins: replaces the member's connection and writes the reverse lookup. */
  bindConnection(binding: ConnectionBinding & { connectionId: string; previousConnectionId?: string; expiresAt: number; nowMs: number }): Promise<void>;
  getConnection(connectionId: string): Promise<ConnectionBinding | null>;
  /**
   * Removes the reverse lookup and clears the member's connection only if it
   * is still this one. Idempotent; `null` when the connection was unknown.
   */
  releaseConnection(connectionId: string): Promise<(ConnectionBinding & { wasActive: boolean }) | null>;
}

export type BroadcastOutcome = "delivered" | "gone";

/** Provider-independent push channel (ADR-018). Infrastructure uses API Gateway `postToConnection`. */
export interface MultiplayerBroadcaster {
  send(connectionId: string, event: MultiplayerServerEvent): Promise<BroadcastOutcome>;
}

export interface ParticipantTokenService {
  /** Opaque token with at least 128 bits of cryptographic entropy. */
  generate(): string;
  hash(token: string): string;
  /** Constant-time comparison of a presented token against a stored hash. */
  matches(token: string, storedHash: string): boolean;
}

export interface RoomCodeGenerator {
  generate(): string;
}
