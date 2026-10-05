import { ApplicationError } from "../../application/errors.ts";
import { safeErrorName } from "../../application/media/mediaEvents.ts";
import { multiplayerClientActions, type MultiplayerClientAction } from "../../application/multiplayer/contracts.ts";
import type { CommandContext, MultiplayerGameplayService } from "../../application/multiplayer/multiplayerGameplayService.ts";
import { logHash } from "../../application/multiplayer/participantTokens.ts";

/** Transport-neutral view of an API Gateway WebSocket event. */
export interface WebSocketRequest {
  eventType: "CONNECT" | "MESSAGE" | "DISCONNECT";
  connectionId: string;
  requestId: string;
  origin?: string;
  body?: string | null;
}

export interface WebSocketResponse {
  statusCode: number;
}

export interface WebSocketRequestLog {
  level: "info" | "error";
  timestamp: string;
  requestId: string;
  eventType: WebSocketRequest["eventType"];
  connectionIdHash: string;
  action?: string;
  result: string;
  durationMs: number;
  errorName?: string;
}

interface WebSocketRouterDependencies {
  gameplay: MultiplayerGameplayService;
  log?: (record: WebSocketRequestLog) => void;
  now?: () => number;
}

const maxMessageBytes = 8_192;

/**
 * Routes `$connect`, `$disconnect` and `$request.body.action` messages to the
 * multiplayer gameplay service. Replies travel back through the broadcaster
 * (`postToConnection`), so message routes always return 200; failures become
 * safe `ERROR` events. Message bodies are never logged (they may carry the
 * participant token).
 */
export function createWebSocketRouter({ gameplay, log = (record) => console.log(JSON.stringify(record)), now = Date.now }: WebSocketRouterDependencies) {
  return async (request: WebSocketRequest): Promise<WebSocketResponse> => {
    const startedAt = now();
    let action: string | undefined;
    let result = "ok";
    let statusCode = 200;
    let errorName: string | undefined;
    const context: CommandContext = { connectionId: request.connectionId, correlationId: request.requestId };
    try {
      if (request.eventType === "CONNECT") {
        if (!gameplay.connect(request.connectionId, request.origin)) {
          statusCode = 403;
          result = "origin-not-allowed";
        }
      } else if (request.eventType === "DISCONNECT") {
        await gameplay.disconnect(context);
      } else {
        const message = parseMessage(request.body);
        action = message?.action;
        if (message?.requestId) context.requestId = message.requestId;
        result = await dispatch(gameplay, context, message);
      }
    } catch (error) {
      if (error instanceof ApplicationError) {
        result = error.code;
        await gameplay.sendError(context, error, action ?? "unknown");
      } else {
        result = "UNEXPECTED_ERROR";
        errorName = safeErrorName(error);
        if (request.eventType === "MESSAGE") {
          await gameplay.sendError(context, { code: "UNEXPECTED_ERROR", message: "An unexpected error occurred." }, action ?? "unknown");
        } else if (request.eventType === "CONNECT") {
          statusCode = 500;
        }
      }
    }
    log({
      level: errorName ? "error" : "info",
      timestamp: new Date().toISOString(),
      requestId: request.requestId,
      eventType: request.eventType,
      connectionIdHash: logHash(request.connectionId),
      ...(action ? { action } : {}),
      result,
      durationMs: Math.max(0, now() - startedAt),
      ...(errorName ? { errorName } : {}),
    });
    return { statusCode };
  };
}

interface ClientMessage {
  action: MultiplayerClientAction;
  requestId?: string;
  payload: Record<string, unknown>;
  body: Record<string, unknown>;
}

function parseMessage(body: string | null | undefined): ClientMessage {
  if (!body || body.length > maxMessageBytes) throw new ApplicationError("INVALID_REQUEST", "Message must be a JSON object.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ApplicationError("INVALID_REQUEST", "Message must be a JSON object.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApplicationError("INVALID_REQUEST", "Message must be a JSON object.");
  const record = parsed as Record<string, unknown>;
  if (typeof record.action !== "string" || !multiplayerClientActions.includes(record.action as MultiplayerClientAction)) {
    throw new ApplicationError("INVALID_REQUEST", "Unknown action.");
  }
  const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown>
    : {};
  const requestId = typeof record.requestId === "string" && /^[A-Za-z0-9._~-]{1,128}$/.test(record.requestId) ? record.requestId : undefined;
  return { action: record.action as MultiplayerClientAction, payload, body: record, ...(requestId ? { requestId } : {}) };
}

async function dispatch(gameplay: MultiplayerGameplayService, context: CommandContext, message: ClientMessage): Promise<string> {
  const { payload, body } = message;
  switch (message.action) {
    case "IDENTIFY":
      // ARCHITECTURE-v0.9 §15 puts the identity fields at the top level; `payload` is accepted too.
      await gameplay.identify({
        ...context,
        roomCode: body.roomCode ?? payload.roomCode,
        playerId: body.playerId ?? payload.playerId,
        participantToken: body.participantToken ?? payload.participantToken,
      });
      break;
    case "START_GAME":
      await gameplay.startGame(context);
      break;
    case "SUBMIT_ANSWER":
      await gameplay.submitAnswer(context, { questionId: payload.questionId, answerId: payload.answerId });
      break;
    case "QUESTION_TIMEOUT":
      await gameplay.questionTimeout(context, { questionId: payload.questionId });
      break;
    case "NEXT_QUESTION":
      await gameplay.nextQuestion(context);
      break;
    case "SYNC_ROOM":
      await gameplay.syncRoom(context);
      break;
  }
  return "ok";
}
