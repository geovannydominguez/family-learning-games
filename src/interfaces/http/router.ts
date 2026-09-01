import { ApplicationError } from "../../application/errors.ts";
import type { GameSessionService } from "../../application/game/gameSessionService.ts";
import type { Difficulty } from "../../domain/game/types.ts";
import type { GameRepository } from "../../repositories/game/GameRepository.ts";
import type { HttpRequest, HttpResponse, RequestLog } from "./contracts.ts";

interface RouterDependencies {
  games: GameRepository;
  sessionService: GameSessionService;
  log?: (record: RequestLog) => void;
  now?: () => number;
}

const difficulties: Difficulty[] = ["easy", "normal", "hard"];
const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

export function createHttpRouter({
  games,
  sessionService,
  log = (record) => console.log(JSON.stringify(record)),
  now = Date.now,
}: RouterDependencies) {
  return async (request: HttpRequest): Promise<HttpResponse> => {
    const startedAt = now();
    let response: HttpResponse;
    try {
      response = await route(request, games, sessionService);
    } catch (error) {
      response = mapError(error);
    }
    log({
      level: response.statusCode >= 500 ? "error" : "info",
      timestamp: new Date().toISOString(),
      requestId: request.requestId,
      method: request.method,
      path: request.path,
      statusCode: response.statusCode,
      durationMs: Math.max(0, now() - startedAt),
    });
    return response;
  };
}

async function route(request: HttpRequest, games: GameRepository, sessionService: GameSessionService): Promise<HttpResponse> {
  if (request.method === "GET" && request.path === "/game-setup") {
    const [players, categories] = await Promise.all([games.getPlayers(), games.getCategories()]);
    return json(200, { players, categories, difficulties });
  }
  if (request.method === "POST" && request.path === "/game-sessions") {
    const body = parseObject(request.body);
    const session = await sessionService.start({
      playerId: readString(body, "playerId"),
      categoryId: readString(body, "categoryId"),
      difficulty: readDifficulty(body.difficulty),
    });
    return json(201, session);
  }
  const answerRoute = request.path.match(/^\/game-sessions\/([^/]+)\/answers$/);
  if (request.method === "POST" && answerRoute) {
    const body = parseObject(request.body);
    return json(200, await sessionService.answer(decodeURIComponent(answerRoute[1]), readString(body, "answerId")));
  }
  return json(404, { error: { code: "RESOURCE_NOT_FOUND", message: "Route was not found." } });
}

function parseObject(body: string | null | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApplicationError("INVALID_REQUEST", "Request body must be valid JSON.");
  }
}

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") throw new ApplicationError("INVALID_REQUEST", `${key} is required.`);
  return value;
}

function readDifficulty(value: unknown): Difficulty {
  if (typeof value !== "string" || !difficulties.includes(value as Difficulty)) throw new ApplicationError("INVALID_REQUEST", "difficulty is invalid.");
  return value as Difficulty;
}

function mapError(error: unknown): HttpResponse {
  if (error instanceof ApplicationError) {
    const status = error.code === "INVALID_REQUEST" ? 400 : error.code === "INVALID_SESSION_STATE" ? 409 : 404;
    return json(status, { error: { code: error.code, message: error.message } });
  }
  return json(500, { error: { code: "UNEXPECTED_ERROR", message: "An unexpected error occurred." } });
}

function json(statusCode: number, body: unknown): HttpResponse {
  return { statusCode, headers: jsonHeaders, body: JSON.stringify(body) };
}
