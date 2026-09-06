import { ApplicationError, PersistenceError } from "../../application/errors.ts";
import type { GenerateGameService } from "../../application/game/generateGameService.ts";
import type { GameSessionService } from "../../application/game/gameSessionService.ts";
import type { PublicGame } from "../../application/game/gameSessionContracts.ts";
import type { Difficulty, Game } from "../../domain/game/types.ts";
import type { GameRepository } from "../../repositories/game/GameRepository.ts";
import type { HttpRequest, HttpResponse, RequestLog } from "./contracts.ts";

interface RouterDependencies {
  games: GameRepository;
  sessionService: GameSessionService;
  generationService?: GenerateGameService;
  log?: (record: RequestLog) => void;
  now?: () => number;
}

const difficulties: Difficulty[] = ["easy", "normal", "hard"];
const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

export function createHttpRouter({
  games,
  sessionService,
  generationService,
  log = (record) => console.log(JSON.stringify(record)),
  now = Date.now,
}: RouterDependencies) {
  return async (request: HttpRequest): Promise<HttpResponse> => {
    const startedAt = now();
    let response: HttpResponse;
    let caughtError: unknown;
    try {
      response = await route(request, games, sessionService, generationService);
    } catch (error) {
      caughtError = error;
      response = mapError(error);
    }
    const errorDiagnostic = response.statusCode >= 500 && caughtError
      ? buildSafeErrorDiagnostic(caughtError, request)
      : undefined;
    log({
      level: response.statusCode >= 500 ? "error" : "info",
      timestamp: new Date().toISOString(),
      requestId: request.requestId,
      method: request.method,
      path: request.path,
      statusCode: response.statusCode,
      durationMs: Math.max(0, now() - startedAt),
      ...(errorDiagnostic ? { error: errorDiagnostic } : {}),
    });
    return response;
  };
}

function buildSafeErrorDiagnostic(error: unknown, request: HttpRequest): NonNullable<RequestLog["error"]> {
  if (error instanceof PersistenceError) {
    return {
      category: "persistence",
      name: error.originalErrorName,
      operation: error.operation,
      ...(error.resourceId ? { resourceId: error.resourceId } : {}),
    };
  }
  const name = readSafeErrorName(error);
  const routeContext = readRouteContext(request);
  return {
    category: "unexpected",
    name,
    operation: routeContext.operation,
    ...(routeContext.resourceId ? { resourceId: routeContext.resourceId } : {}),
  };
}

function readSafeErrorName(error: unknown): string {
  if (!error || typeof error !== "object" || !("name" in error) || typeof error.name !== "string") return "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(error.name) ? error.name : "UnknownError";
}

function readRouteContext(request: HttpRequest): { operation: string; resourceId?: string } {
  if (request.method === "GET" && request.path === "/games") return { operation: "list-games" };
  if (request.method === "GET" && request.path === "/game-setup") return { operation: "get-game-setup" };
  if (request.method === "POST" && request.path === "/game-sessions") return { operation: "start-game-session" };
  if (request.method === "POST" && request.path === "/games/generate") return { operation: "generate-game" };
  const game = request.path.match(/^\/games\/([^/]+)$/);
  if (request.method === "GET" && game) return withResource("get-game", game[1]);
  const answer = request.path.match(/^\/game-sessions\/([^/]+)\/answers$/);
  if (request.method === "POST" && answer) return withResource("submit-answer", answer[1]);
  const session = request.path.match(/^\/game-sessions\/([^/]+)$/);
  if (request.method === "GET" && session) return withResource("get-game-session", session[1]);
  return { operation: "unknown-route" };
}

function withResource(operation: string, encodedId: string): { operation: string; resourceId?: string } {
  try {
    const resourceId = decodeURIComponent(encodedId);
    return /^[A-Za-z0-9._~-]{1,128}$/.test(resourceId) ? { operation, resourceId } : { operation };
  } catch {
    return { operation };
  }
}

async function route(
  request: HttpRequest,
  games: GameRepository,
  sessionService: GameSessionService,
  generationService: GenerateGameService | undefined,
): Promise<HttpResponse> {
  if (request.method === "GET" && request.path === "/games") {
    const catalog = await games.findAll();
    return json(200, catalog.map(toPublicGame));
  }
  if (request.method === "POST" && request.path === "/games/generate") {
    if (!generationService) {
      throw new ApplicationError("AI_GENERATION_DISABLED", "AI game generation is disabled.");
    }
    const body = parseGenerationObject(request.body);
    const game = await generationService.generate({
      topic: body.topic as string,
      difficulty: body.difficulty as Difficulty,
      questionCount: body.questionCount as number,
      playerId: body.playerId as string,
      correlationId: request.requestId,
    });
    return json(201, toPublicGame(game));
  }
  const gameRoute = request.path.match(/^\/games\/([^/]+)$/);
  if (request.method === "GET" && gameRoute) {
    const game = await games.findById(decodeURIComponent(gameRoute[1]));
    if (!game) throw new ApplicationError("RESOURCE_NOT_FOUND", "Game was not found.");
    return json(200, toPublicGame(game));
  }
  if (request.method === "GET" && request.path === "/game-setup") {
    const [players, categories] = await Promise.all([games.getPlayers(), games.getCategories()]);
    return json(200, { players, categories, difficulties });
  }
  if (request.method === "POST" && request.path === "/game-sessions") {
    const body = parseObject(request.body);
    const session = await sessionService.start({
      playerId: readString(body, "playerId"),
      categoryId: readString(body, "categoryId"),
      gameId: readOptionalString(body, "gameId"),
      difficulty: readDifficulty(body.difficulty),
    });
    return json(201, session);
  }
  const answerRoute = request.path.match(/^\/game-sessions\/([^/]+)\/answers$/);
  if (request.method === "POST" && answerRoute) {
    const body = parseObject(request.body);
    return json(200, await sessionService.answer(decodeURIComponent(answerRoute[1]), readString(body, "answerId")));
  }
  const sessionRoute = request.path.match(/^\/game-sessions\/([^/]+)$/);
  if (request.method === "GET" && sessionRoute) {
    return json(200, await sessionService.get(decodeURIComponent(sessionRoute[1])));
  }
  return json(404, { error: { code: "RESOURCE_NOT_FOUND", message: "Route was not found." } });
}

function toPublicGame(game: Game): PublicGame {
  return {
    id: game.id,
    title: game.title,
    category: game.category,
    difficulties: difficulties.filter((difficulty) => game.questions.some((question) => question.difficulty === difficulty)),
    questions: game.questions.map((question) => ({
      id: question.id,
      categoryId: question.categoryId,
      difficulty: question.difficulty,
      text: question.text,
      emoji: question.emoji,
      image: question.image,
      answers: question.answers.map(({ id, text }) => ({ id, text })),
    })),
  };
}

function parseGenerationObject(body: string | null | undefined): Record<string, unknown> {
  try {
    return parseObject(body);
  } catch {
    throw new ApplicationError("INVALID_GENERATION_REQUEST", "Generation request is invalid.");
  }
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

function readOptionalString(body: Record<string, unknown>, key: string): string | undefined {
  if (!(key in body)) return undefined;
  return readString(body, key);
}

function readDifficulty(value: unknown): Difficulty {
  if (typeof value !== "string" || !difficulties.includes(value as Difficulty)) throw new ApplicationError("INVALID_REQUEST", "difficulty is invalid.");
  return value as Difficulty;
}

function mapError(error: unknown): HttpResponse {
  if (error instanceof ApplicationError) {
    const status = applicationErrorStatus(error.code);
    return json(status, { error: { code: error.code, message: error.message } });
  }
  return json(500, { error: { code: "UNEXPECTED_ERROR", message: "An unexpected error occurred." } });
}

function applicationErrorStatus(code: ApplicationError["code"]): number {
  switch (code) {
    case "INVALID_REQUEST":
    case "INVALID_GENERATION_REQUEST":
      return 400;
    case "AI_GENERATED_CONTENT_INVALID":
      return 422;
    case "INVALID_SESSION_STATE":
    case "SESSION_CONFLICT":
    case "GAME_ID_CONFLICT":
      return 409;
    case "AI_GENERATION_FAILED":
      return 502;
    case "AI_GENERATION_DISABLED":
      return 503;
    default:
      return 404;
  }
}

function json(statusCode: number, body: unknown): HttpResponse {
  return { statusCode, headers: jsonHeaders, body: JSON.stringify(body) };
}
