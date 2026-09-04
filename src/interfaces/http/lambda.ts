import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { GameSessionService } from "../../application/game/gameSessionService.ts";
import { DynamoDbGameRepository } from "../../infrastructure/repositories/DynamoDbGameRepository.ts";
import { DynamoDbGameSessionRepository } from "../../infrastructure/repositories/DynamoDbGameSessionRepository.ts";
import { createHttpRouter } from "./router.ts";

const gamesTableName = requireConfiguration("GAMES_TABLE_NAME");
const gameSessionsTableName = requireConfiguration("GAME_SESSIONS_TABLE_NAME");
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const games = new DynamoDbGameRepository(documentClient, gamesTableName);
const sessions = new DynamoDbGameSessionRepository(documentClient, gameSessionsTableName);
const router = createHttpRouter({ games, sessionService: new GameSessionService(games, sessions) });

function requireConfiguration(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required backend configuration: ${name}`);
  return value;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) =>
  router({
    requestId: event.requestContext.requestId,
    method: event.requestContext.http.method,
    path: event.rawPath,
    body: event.body,
  });
