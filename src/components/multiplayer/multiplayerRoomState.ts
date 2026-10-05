import type {
  MultiplayerServerEvent,
  PublicMultiplayerRoom,
  ScoreboardEntry,
} from "../../application/multiplayer/contracts.ts";
import type { MultiplayerRole } from "../../domain/multiplayer/types.ts";
import { GameApiError } from "../../infrastructure/http/GameApiClient.ts";

/**
 * v0.9 client-side multiplayer view state. Pure and framework-free so it can
 * be unit tested. The backend is authoritative: this only *replaces* local
 * state with server snapshots (ignoring stale versions) and never decides
 * correctness, scoring, rank or timing.
 */
export interface MultiplayerViewState {
  room: PublicMultiplayerRoom | null;
  version: number;
  self: { playerId: string; role: MultiplayerRole } | null;
  /** The answer this device submitted for `answeredQuestionId`. */
  myAnswerId: string | null;
  answeredQuestionId: string | null;
  podium: ScoreboardEntry[] | null;
  /** serverTime − local time, from the latest event: countdowns render from server time. */
  clockOffsetMs: number;
  error: { code: string; message: string } | null;
}

export const initialMultiplayerViewState: MultiplayerViewState = {
  room: null,
  version: 0,
  self: null,
  myAnswerId: null,
  answeredQuestionId: null,
  podium: null,
  clockOffsetMs: 0,
  error: null,
};

export function applyServerEvent(state: MultiplayerViewState, event: MultiplayerServerEvent, localNowMs: number): MultiplayerViewState {
  const next: MultiplayerViewState = { ...state, clockOffsetMs: event.serverTime - localNowMs };
  if (event.type === "ERROR") return { ...next, error: event.error };

  if (event.type === "ANSWER_ACCEPTED") {
    const room = next.room;
    if (!room || room.currentQuestion?.id !== event.questionId || room.questionState !== "OPEN") return next;
    const answeredPlayerIds = room.answeredPlayerIds.includes(event.playerId) ? room.answeredPlayerIds : [...room.answeredPlayerIds, event.playerId].sort();
    return {
      ...next,
      room: { ...room, answeredPlayerIds },
      ...(event.answerId ? { myAnswerId: event.answerId, answeredQuestionId: event.questionId } : {}),
    };
  }

  if (event.type === "SCOREBOARD_UPDATED") {
    if (!next.room || event.version < next.version) return next;
    return { ...next, room: { ...next.room, scoreboard: event.scoreboard } };
  }

  // Every remaining event carries a full authoritative snapshot.
  if (event.version < next.version) return next;
  const withRoom: MultiplayerViewState = { ...next, room: event.room, version: event.version, error: null };
  if (event.type === "ROOM_STATE" && event.self) {
    withRoom.self = { playerId: event.self.playerId, role: event.self.role };
    withRoom.myAnswerId = event.self.currentAnswerId ?? null;
    withRoom.answeredQuestionId = event.self.currentAnswerId ? event.room.currentQuestion?.id ?? null : null;
  }
  if (withRoom.answeredQuestionId !== null && withRoom.answeredQuestionId !== event.room.currentQuestion?.id) {
    withRoom.myAnswerId = null;
    withRoom.answeredQuestionId = null;
  }
  if (event.type === "GAME_FINISHED") withRoom.podium = event.podium;
  else if (event.room.status === "FINISHED") withRoom.podium = event.room.scoreboard;
  return withRoom;
}

/** Whole seconds left on the server deadline (presentation only). */
export function remainingSeconds(room: PublicMultiplayerRoom | null, clockOffsetMs: number, localNowMs: number): number | null {
  if (!room || room.questionState !== "OPEN" || room.questionDeadlineAt === undefined) return null;
  return Math.max(0, Math.ceil((room.questionDeadlineAt - (localNowMs + clockOffsetMs)) / 1_000));
}

export const QUESTION_TIMEOUT_RETRY_MS = 3_000;

/**
 * Decides, without any user action, whether this connection should send
 * `QUESTION_TIMEOUT` now: the question is OPEN and the server-estimated time
 * reached its deadline. Sent once per question, re-sent only every
 * `QUESTION_TIMEOUT_RETRY_MS` while the question stays OPEN (e.g. the server
 * rejected it because of clock skew, or the reply was lost). The command is
 * only a trigger; the backend re-checks its own deadline.
 */
export function questionTimeoutToSend(
  room: PublicMultiplayerRoom | null,
  clockOffsetMs: number,
  localNowMs: number,
  lastSent: { questionId: string; at: number } | null,
): string | null {
  const questionId = room?.status === "IN_PROGRESS" ? room.currentQuestion?.id : undefined;
  if (!questionId || remainingSeconds(room, clockOffsetMs, localNowMs) !== 0) return null;
  if (lastSent && lastSent.questionId === questionId && localNowMs - lastSent.at < QUESTION_TIMEOUT_RETRY_MS) return null;
  return questionId;
}

/** Membership errors after which reconnecting cannot succeed. */
export function isTerminalMultiplayerError(code: string): boolean {
  return code === "INVALID_PARTICIPANT_TOKEN" || code === "ROOM_EXPIRED" || code === "ROOM_NOT_FOUND";
}

// ---- Active membership in sessionStorage (ADR-020): per tab, never localStorage.

export interface StoredMultiplayerSession {
  roomId: string;
  roomCode: string;
  playerId: string;
  participantToken: string;
}

const sessionKey = "joam-multiplayer-session";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function sessionStorageOrNull(): StorageLike | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function saveMultiplayerSession(session: StoredMultiplayerSession, storage: StorageLike | null = sessionStorageOrNull()): void {
  try {
    storage?.setItem(sessionKey, JSON.stringify(session));
  } catch {
    // Storage may be unavailable (private mode): the room still works until refresh.
  }
}

export function loadMultiplayerSession(storage: StorageLike | null = sessionStorageOrNull()): StoredMultiplayerSession | null {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(sessionKey) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Record<string, unknown>;
    return typeof value.roomId === "string" && typeof value.roomCode === "string" && typeof value.playerId === "string" && typeof value.participantToken === "string"
      ? { roomId: value.roomId, roomCode: value.roomCode, playerId: value.playerId, participantToken: value.participantToken }
      : null;
  } catch {
    return null;
  }
}

export function clearMultiplayerSession(storage: StorageLike | null = sessionStorageOrNull()): void {
  try {
    storage?.removeItem(sessionKey);
  } catch {
    // Nothing to clear.
  }
}

export function multiplayerErrorMessage(error: unknown, fallback: string): string {
  const code = error instanceof GameApiError ? error.code : (error as { code?: string } | null)?.code;
  switch (code) {
    case "ROOM_NOT_FOUND": return "No encontramos esa sala. Revisa el código.";
    case "ROOM_EXPIRED": return "La sala expiró. Crea una sala nueva.";
    case "ROOM_ALREADY_STARTED": return "La partida de esa sala ya comenzó.";
    case "ROOM_FULL": return "La sala está llena.";
    case "PLAYER_ALREADY_JOINED": return "Ese jugador ya está en la sala. Elige otro perfil.";
    case "PLAYER_NOT_FOUND": return "No encontramos ese jugador. Elige otro perfil de la lista.";
    case "NOT_ENOUGH_PLAYERS": return "Se necesitan al menos 2 jugadores para empezar.";
    case "INVALID_PARTICIPANT_TOKEN": return "No pudimos confirmar tu lugar en la sala. Vuelve a unirte.";
    case "ANSWER_DEADLINE_EXPIRED": return "Se acabó el tiempo para esta pregunta.";
    case "MULTIPLAYER_DISABLED": return "El modo multijugador no está disponible en este momento.";
    case "NETWORK_ERROR": return "No pudimos conectar con el servicio. Revisa tu conexión e inténtalo otra vez.";
    default: return fallback;
  }
}
