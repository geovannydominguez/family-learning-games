import type {
  GameSetupResponse,
  PublicGame,
  PublicGameSession,
  StartGameSessionCommand,
  SubmitAnswerResponse,
} from "../../application/game/gameSessionContracts.ts";
import type { GenerateGameCommand } from "../../application/game/GameGenerator.ts";

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

export class GameApiError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(
    code: string,
    message: string,
    status?: number,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.code = code;
    this.status = status;
    this.name = "GameApiError";
  }
}

export class GameApiClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(
    baseUrl: string | undefined,
    fetcher: typeof fetch = fetch,
  ) {
    if (!baseUrl?.trim()) {
      throw new GameApiError("MISSING_CONFIGURATION", "NEXT_PUBLIC_GAME_API_BASE_URL is not configured.");
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetcher = fetcher.bind(globalThis);
  }

  getSetup(): Promise<GameSetupResponse> {
    return this.request("/game-setup", { method: "GET" });
  }

  startSession(command: StartGameSessionCommand): Promise<PublicGameSession> {
    const body = {
      playerId: command.playerId,
      categoryId: command.categoryId,
      difficulty: command.difficulty,
      ...(command.gameId !== undefined ? { gameId: command.gameId } : {}),
    };
    return this.request("/game-sessions", { method: "POST", body: JSON.stringify(body) });
  }

  generateGame(request: GenerateGameCommand): Promise<PublicGame> {
    return this.request("/games/generate", { method: "POST", body: JSON.stringify(request) });
  }

  answerSession(sessionId: string, answerId: string): Promise<SubmitAnswerResponse> {
    return this.request(`/game-sessions/${encodeURIComponent(sessionId)}/answers`, {
      method: "POST",
      body: JSON.stringify({ answerId }),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...init.headers },
      });
    } catch (cause) {
      throw new GameApiError("NETWORK_ERROR", "The game service could not be reached.", undefined, cause);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (response.status === 429) {
        throw new GameApiError("RATE_LIMITED", "Too many generation requests. Try again later.", 429);
      }
      throw new GameApiError("INVALID_RESPONSE", "The game service returned an invalid response.", response.status);
    }
    if (!response.ok) {
      const envelope = body as ErrorEnvelope;
      if (response.status === 429) {
        throw new GameApiError(
          envelope.error?.code ?? "RATE_LIMITED",
          envelope.error?.message ?? "Too many generation requests. Try again later.",
          response.status,
        );
      }
      throw new GameApiError(
        envelope.error?.code ?? "API_ERROR",
        envelope.error?.message ?? "The game service rejected the request.",
        response.status,
      );
    }
    return body as T;
  }
}

export function createGameApiClient(): GameApiClient {
  return new GameApiClient(process.env.NEXT_PUBLIC_GAME_API_BASE_URL);
}
