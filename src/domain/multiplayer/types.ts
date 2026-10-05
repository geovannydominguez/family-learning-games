/**
 * Multiplayer room concepts (v0.9, ADR-019). Ephemeral coordination state for
 * one family quiz played from several devices. AWS-independent: no SDK,
 * API Gateway, Lambda or DynamoDB types appear here.
 *
 * The room references the existing `Game` by `gameId` and snapshots only the
 * ordered question identifiers; the `Game` remains the content source.
 */

/** `EXPIRED` is derived from `expiresAt` and never persisted as a transition. */
export type MultiplayerRoomStatus = "WAITING" | "IN_PROGRESS" | "FINISHED" | "EXPIRED";

export type MultiplayerQuestionState = "NOT_STARTED" | "OPEN" | "REVEALED";

export type MultiplayerRole = "HOST" | "PLAYER";

/** Per-member aggregates that feed the scoreboard and podium comparator. */
export interface MultiplayerScore {
  correctAnswers: number;
  totalPoints: number;
  firstPlaceCorrectAnswers: number;
  secondPlaceCorrectAnswers: number;
  thirdPlaceCorrectAnswers: number;
  cumulativeCorrectResponseTimeMs: number;
}

/** Server-decided outcome of one player for one revealed question. */
export interface MultiplayerQuestionResult {
  playerId: string;
  answered: boolean;
  isCorrect: boolean;
  /** Placement among correct answers only (competition ranking); `null` when not correct. */
  placement: number | null;
  pointsAwarded: number;
  /** Server-measured duration, present only for correct answers (feeds the final tie-breaker). */
  responseDurationMs?: number;
}

export interface MultiplayerReveal {
  questionId: string;
  correctAnswerId: string;
  results: MultiplayerQuestionResult[];
}

export interface MultiplayerRoom {
  roomId: string;
  roomCode: string;
  gameId: string;
  hostPlayerId: string;
  status: Exclude<MultiplayerRoomStatus, "EXPIRED">;
  /** Ordered question snapshot taken at room creation. */
  questionIds: string[];
  /** -1 before the game starts. */
  currentQuestionIndex: number;
  questionState: MultiplayerQuestionState;
  /** Server epoch milliseconds. */
  questionStartedAt?: number;
  /** Server epoch milliseconds. */
  questionDeadlineAt?: number;
  questionTimeLimitSeconds: number;
  /** Players that must answer before an early reveal, fixed when the question opens. */
  eligiblePlayerIds: string[];
  answeredCount: number;
  memberCount: number;
  /** Outcome of the latest revealed question; present only while it is the current one. */
  lastReveal?: MultiplayerReveal;
  /** Monotonic room-state version, incremented by every authoritative transition. */
  version: number;
  /** Server epoch milliseconds. */
  createdAt: number;
  /** Epoch seconds (also the DynamoDB TTL attribute). */
  expiresAt: number;
}

export interface MultiplayerMember {
  roomId: string;
  playerId: string;
  /** Safe snapshot of the family profile name for room broadcasts. */
  displayName: string;
  role: MultiplayerRole;
  /** SHA-256 of the participant token. The raw token is never stored. */
  participantTokenHash: string;
  /** Latest validated WebSocket connection; absent while disconnected. */
  connectionId?: string;
  joinedAt: number;
  score: MultiplayerScore;
  expiresAt: number;
}

export interface MultiplayerAnswer {
  roomId: string;
  questionId: string;
  playerId: string;
  answerId: string;
  serverReceivedAtMs: number;
  responseDurationMs: number;
  /** Internal until the question is revealed. */
  isCorrect: boolean;
  expiresAt: number;
}

export function emptyMultiplayerScore(): MultiplayerScore {
  return {
    correctAnswers: 0,
    totalPoints: 0,
    firstPlaceCorrectAnswers: 0,
    secondPlaceCorrectAnswers: 0,
    thirdPlaceCorrectAnswers: 0,
    cumulativeCorrectResponseTimeMs: 0,
  };
}

/** Application must check expiry itself: DynamoDB TTL is eventual cleanup only. */
export function isRoomExpired(room: Pick<MultiplayerRoom, "expiresAt">, nowMs: number): boolean {
  return nowMs >= room.expiresAt * 1_000;
}

export function effectiveRoomStatus(room: MultiplayerRoom, nowMs: number): MultiplayerRoomStatus {
  return isRoomExpired(room, nowMs) ? "EXPIRED" : room.status;
}

/** A question closes when every eligible player answered or the server deadline passed. */
export function isQuestionClosable(room: MultiplayerRoom, nowMs: number): boolean {
  if (room.status !== "IN_PROGRESS" || room.questionState !== "OPEN") return false;
  const allAnswered = room.answeredCount >= room.eligiblePlayerIds.length;
  return allAnswered || (room.questionDeadlineAt !== undefined && nowMs >= room.questionDeadlineAt);
}
