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
  /**
   * v0.9.2: an answer this device sent that the server has not confirmed yet.
   * It locks the options while pending, but is never shown as accepted.
   */
  pendingAnswer: PendingAnswer | null;
  /** v0.9.2: client-side informational message (not a server error). */
  notice: MultiplayerNotice | null;
  /** Bumped when one SYNC_ROOM should be sent; the component sends it. */
  resyncRequests: number;
  lastResyncAtMs: number | null;
}

/**
 * `questionId` binds an answer notice to the question it is about; it is
 * `null` for connection notices. Answer notices are cleared as soon as that
 * question's answer is confirmed, another question is current, or the game is
 * no longer in progress (never shown on the podium).
 */
export interface MultiplayerNotice {
  message: string;
  questionId: string | null;
}

export interface PendingAnswer {
  questionId: string;
  answerId: string;
  requestId: string;
  sentAtMs: number;
  /** When a SYNC_ROOM was requested to confirm this answer: at most once per answer. */
  resyncRequestedAtMs: number | null;
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
  pendingAnswer: null,
  notice: null,
  resyncRequests: 0,
  lastResyncAtMs: null,
};

/** v0.9.2: wait this long for ANSWER_ACCEPTED before asking for one SYNC_ROOM, and as long again before giving up. */
export const ANSWER_CONFIRMATION_TIMEOUT_MS = 5_000;
/** v0.9.2: never request SYNC_ROOM more often than this (it must not amplify traffic under throttling). */
export const RESYNC_MIN_INTERVAL_MS = 5_000;

export const multiplayerNotices = {
  checkingAnswer: "Comprobando tu respuesta con el servidor…",
  answerUnconfirmed: "No pudimos confirmar tu respuesta. Puedes elegirla de nuevo.",
  answerNotRecorded: "Tu respuesta no se registró antes de que cerrara la pregunta.",
  serverBusy: "El servidor está ocupado. Sincronizando la partida…",
} as const;

export type MultiplayerViewAction =
  | { kind: "server-event"; event: MultiplayerServerEvent; now: number }
  | { kind: "answer-sent"; questionId: string; answerId: string; requestId: string; now: number }
  | { kind: "transport-error"; now: number }
  | { kind: "tick"; now: number };

/**
 * v0.9.2 reducer around `applyServerEvent`: tracks the unconfirmed answer and
 * decides when to request a single SYNC_ROOM. It never resends SUBMIT_ANSWER:
 * the player chooses again only after the server state shows no answer.
 */
export function reduceMultiplayerView(state: MultiplayerViewState, action: MultiplayerViewAction): MultiplayerViewState {
  switch (action.kind) {
    case "server-event":
      return clearStaleAnswerNotice(resolvePendingAnswer(state, applyServerEvent(state, action.event, action.now), action.event, action.now));
    case "answer-sent":
      return {
        ...state,
        // A new answer supersedes earlier answer notices; connection notices stay.
        notice: state.notice?.questionId === null ? state.notice : null,
        pendingAnswer: { questionId: action.questionId, answerId: action.answerId, requestId: action.requestId, sentAtMs: action.now, resyncRequestedAtMs: null },
      };
    case "transport-error": {
      const pending = state.pendingAnswer;
      if (pending && pending.resyncRequestedAtMs === null) {
        return requestResync({ ...state, notice: answerNotice("checkingAnswer", pending.questionId), pendingAnswer: { ...pending, resyncRequestedAtMs: action.now } }, action.now);
      }
      return requestResync({ ...state, notice: pending ? state.notice : { message: multiplayerNotices.serverBusy, questionId: null } }, action.now);
    }
    case "tick": {
      const pending = state.pendingAnswer;
      if (!pending) return state;
      if (pending.resyncRequestedAtMs === null) {
        if (action.now - pending.sentAtMs < ANSWER_CONFIRMATION_TIMEOUT_MS) return state;
        return requestResync({ ...state, notice: answerNotice("checkingAnswer", pending.questionId), pendingAnswer: { ...pending, resyncRequestedAtMs: action.now } }, action.now);
      }
      if (action.now - pending.resyncRequestedAtMs < ANSWER_CONFIRMATION_TIMEOUT_MS) return state;
      // The SYNC_ROOM reply never came either: unlock instead of waiting forever.
      return { ...state, pendingAnswer: null, notice: answerNotice("answerUnconfirmed", pending.questionId) };
    }
  }
}

function answerNotice(kind: "checkingAnswer" | "answerUnconfirmed" | "answerNotRecorded", questionId: string): MultiplayerNotice {
  return { message: multiplayerNotices[kind], questionId };
}

function requestResync(state: MultiplayerViewState, now: number): MultiplayerViewState {
  if (state.lastResyncAtMs !== null && now - state.lastResyncAtMs < RESYNC_MIN_INTERVAL_MS) return state;
  return { ...state, resyncRequests: state.resyncRequests + 1, lastResyncAtMs: now };
}

function resolvePendingAnswer(previous: MultiplayerViewState, next: MultiplayerViewState, event: MultiplayerServerEvent, now: number): MultiplayerViewState {
  // Only an own snapshot that was actually applied is authoritative: an older,
  // out-of-order ROOM_STATE (ignored by applyServerEvent) must not unlock anything.
  const ownSnapshot = event.type === "ROOM_STATE" && event.self !== undefined && event.version >= previous.version;
  const settled = ownSnapshot && next.notice?.message === multiplayerNotices.serverBusy ? { ...next, notice: null } : next;
  const pending = settled.pendingAnswer;
  if (!pending) return settled;
  const clearChecking = settled.notice?.message === multiplayerNotices.checkingAnswer ? null : settled.notice;

  // Confirmed by the server (ANSWER_ACCEPTED for this device, or own ROOM_STATE.self.currentAnswerId).
  if (settled.answeredQuestionId === pending.questionId && settled.myAnswerId) {
    return { ...settled, pendingAnswer: null, notice: clearChecking };
  }
  if (event.type === "ERROR" && event.requestId === pending.requestId) {
    const cleared = { ...settled, pendingAnswer: null, notice: clearChecking };
    // The server already holds an answer from this player: fetch which one.
    return event.error.code === "ANSWER_ALREADY_SUBMITTED" ? requestResync(cleared, now) : cleared;
  }
  const room = settled.room;
  if (room && (room.currentQuestion?.id !== pending.questionId || room.questionState !== "OPEN")) {
    const result = room.reveal?.questionId === pending.questionId
      ? room.reveal.results.find((candidate) => candidate.playerId === settled.self?.playerId)
      : undefined;
    return { ...settled, pendingAnswer: null, notice: result && !result.answered ? answerNotice("answerNotRecorded", pending.questionId) : clearChecking };
  }
  if (ownSnapshot && pending.resyncRequestedAtMs !== null) {
    // The authoritative snapshot we asked for shows no answer from this player.
    return { ...settled, pendingAnswer: null, notice: answerNotice("answerUnconfirmed", pending.questionId) };
  }
  return settled;
}

/**
 * Runs after every server event, with or without a pending answer (the
 * v0.9.2 pre-production defect: answer notices outlived their question).
 * Connection notices (`questionId: null`) and server errors are untouched.
 */
function clearStaleAnswerNotice(state: MultiplayerViewState): MultiplayerViewState {
  const notice = state.notice;
  if (!notice || notice.questionId === null || !state.room) return state;
  const confirmed = state.answeredQuestionId === notice.questionId && state.myAnswerId !== null;
  const otherQuestion = state.room.currentQuestion?.id !== notice.questionId;
  const notPlaying = state.room.status !== "IN_PROGRESS";
  return confirmed || otherQuestion || notPlaying ? { ...state, notice: null } : state;
}

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
    case "RATE_LIMITED":
    case "REQUEST_THROTTLED": return "Hay muchas solicitudes en este momento. Espera unos segundos e inténtalo otra vez.";
    default: return fallback;
  }
}
