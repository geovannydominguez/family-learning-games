import type { APIGatewayProxyHandlerV2 } from "aws-lambda";

import { GameSessionService } from "../../application/game/gameSessionService.ts";
import { InMemoryGameSessionRepository } from "../../infrastructure/repositories/InMemoryGameSessionRepository.ts";
import { MockGameRepository } from "../../repositories/game/MockGameRepository.ts";
import { createHttpRouter } from "./router.ts";

const games = new MockGameRepository();
// Deliberately ephemeral: there is no durability or Lambda instance affinity in v0.2.
const sessions = new InMemoryGameSessionRepository();
const router = createHttpRouter({ games, sessionService: new GameSessionService(games, sessions) });

export const handler: APIGatewayProxyHandlerV2 = async (event) =>
  router({
    requestId: event.requestContext.requestId,
    method: event.requestContext.http.method,
    path: event.rawPath,
    body: event.body,
  });
