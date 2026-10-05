import type { Difficulty } from "../../domain/game/types.ts";
import type {
  MultiplayerQuestionResult,
  MultiplayerQuestionState,
  MultiplayerRole,
  MultiplayerRoomStatus,
  MultiplayerScore,
} from "../../domain/multiplayer/types.ts";
import type { PublicQuestion } from "../game/gameSessionContracts.ts";

// ---- HTTP bootstrap (POST /multiplayer/rooms, POST /multiplayer/rooms/{roomCode}/join)

export interface CreateMultiplayerRoomCommand {
  gameId: string;
  playerId: string;
  questionTimeLimitSeconds?: number;
  /** Optional: selects which of the game's difficulties is played (seeded games carry several). */
  difficulty?: Difficulty;
  correlationId?: string;
}

export interface CreateMultiplayerRoomResponse {
  roomId: string;
  roomCode: string;
  playerId: string;
  role: "HOST";
  /** Returned once; only its hash is persisted. */
  participantToken: string;
  questionTimeLimitSeconds: number;
}

export interface JoinMultiplayerRoomCommand {
  roomCode: string;
  playerId: string;
  correlationId?: string;
}

export interface JoinMultiplayerRoomResponse {
  roomId: string;
  roomCode: string;
  playerId: string;
  role: "PLAYER";
  participantToken: string;
}

// ---- WebSocket client commands

export type MultiplayerClientAction =
  | "IDENTIFY"
  | "START_GAME"
  | "SUBMIT_ANSWER"
  | "QUESTION_TIMEOUT"
  | "NEXT_QUESTION"
  | "SYNC_ROOM";

export const multiplayerClientActions: readonly MultiplayerClientAction[] = [
  "IDENTIFY",
  "START_GAME",
  "SUBMIT_ANSWER",
  "QUESTION_TIMEOUT",
  "NEXT_QUESTION",
  "SYNC_ROOM",
];

// ---- Public (safe) room state

export interface PublicMultiplayerMember {
  playerId: string;
  displayName: string;
  role: MultiplayerRole;
  connected: boolean;
}

export interface ScoreboardEntry extends MultiplayerScore {
  playerId: string;
  displayName: string;
  rank: number;
}

export interface PublicMultiplayerReveal {
  questionId: string;
  correctAnswerId: string;
  results: MultiplayerQuestionResult[];
}

/**
 * Safe room snapshot. While a question is OPEN it never carries correctness:
 * `currentQuestion` uses the public question shape (answers are `{ id, text }`)
 * and `reveal` is present only once the question is REVEALED.
 */
export interface PublicMultiplayerRoom {
  roomId: string;
  roomCode: string;
  gameId: string;
  gameTitle: string;
  hostPlayerId: string;
  status: MultiplayerRoomStatus;
  questionState: MultiplayerQuestionState;
  /** 1-based; 0 before the game starts. */
  questionNumber: number;
  totalQuestions: number;
  questionTimeLimitSeconds: number;
  questionStartedAt?: number;
  questionDeadlineAt?: number;
  members: PublicMultiplayerMember[];
  answeredPlayerIds: string[];
  currentQuestion?: PublicQuestion;
  reveal?: PublicMultiplayerReveal;
  scoreboard: ScoreboardEntry[];
  version: number;
}

/** Requester-only context added to IDENTIFY / SYNC_ROOM responses. */
export interface MultiplayerSelf {
  playerId: string;
  role: MultiplayerRole;
  /** The answer this player already submitted for the current question, if any. */
  currentAnswerId?: string;
}

interface EventBase {
  roomId: string;
  /** Server epoch milliseconds; lets clients render countdowns from server time. */
  serverTime: number;
}

interface StateEvent extends EventBase {
  version: number;
  room: PublicMultiplayerRoom;
}

export type MultiplayerServerEvent =
  | (StateEvent & { type: "ROOM_STATE"; self?: MultiplayerSelf; requestId?: string })
  | (StateEvent & { type: "PLAYER_JOINED"; playerId: string })
  | (StateEvent & { type: "PLAYER_DISCONNECTED"; playerId: string })
  | (StateEvent & { type: "GAME_STARTED" })
  | (StateEvent & { type: "QUESTION_OPENED" })
  | (EventBase & { type: "ANSWER_ACCEPTED"; version: number; questionId: string; playerId: string; answeredCount: number; answerId?: string; requestId?: string })
  | (StateEvent & { type: "QUESTION_REVEALED"; questionId: string; correctAnswerId: string; results: MultiplayerQuestionResult[]; scoreboard: ScoreboardEntry[] })
  | (EventBase & { type: "SCOREBOARD_UPDATED"; version: number; scoreboard: ScoreboardEntry[] })
  | (StateEvent & { type: "GAME_FINISHED"; podium: ScoreboardEntry[] })
  | (Partial<EventBase> & { type: "ERROR"; serverTime: number; requestId?: string; error: { code: string; message: string } });

// ---- Configuration and observability

export interface MultiplayerSettings {
  minPlayers: number;
  maxPlayers: number;
  roomTtlMinutes: number;
  defaultQuestionSeconds: number;
  minQuestionSeconds: number;
  maxQuestionSeconds: number;
  placementTieWindowMs: number;
  questionsPerRoom: number;
}

export const defaultMultiplayerSettings: MultiplayerSettings = {
  minPlayers: 2,
  maxPlayers: 8,
  roomTtlMinutes: 120,
  defaultQuestionSeconds: 30,
  minQuestionSeconds: 10,
  maxQuestionSeconds: 120,
  placementTieWindowMs: 100,
  questionsPerRoom: 10,
};

/**
 * Structured multiplayer observability. Opaque IDs, hashes, states and
 * durations only — never participant tokens or their hashes, player names,
 * answer text or correct-answer content.
 */
export interface MultiplayerLogEvent {
  event:
    | "MULTIPLAYER_ROOM_CREATED"
    | "MULTIPLAYER_PLAYER_JOINED"
    | "MULTIPLAYER_CONNECTED"
    | "MULTIPLAYER_RECONNECTED"
    | "MULTIPLAYER_DISCONNECTED"
    | "MULTIPLAYER_GAME_STARTED"
    | "MULTIPLAYER_ANSWER_ACCEPTED"
    | "MULTIPLAYER_QUESTION_REVEALED"
    | "MULTIPLAYER_GAME_FINISHED"
    | "MULTIPLAYER_PROTOCOL_REJECTED"
    | "MULTIPLAYER_BROADCAST_STALE_CONNECTION"
    | "MULTIPLAYER_BROADCAST_FAILED";
  level: "info" | "warn" | "error";
  correlationId?: string;
  roomId?: string;
  roomCodeHash?: string;
  connectionIdHash?: string;
  action?: string;
  questionId?: string;
  roomStatus?: string;
  questionState?: string;
  roomVersion?: number;
  durationMs?: number;
  result?: string;
  errorName?: string;
}
