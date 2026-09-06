import { randomUUID } from "node:crypto";

import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import type { GameGenerator } from "../../application/game/GameGenerator.ts";
import type { GameValidator } from "../../application/game/GameValidator.ts";
import { GenerateGameService } from "../../application/game/generateGameService.ts";
import { GameSessionService } from "../../application/game/gameSessionService.ts";
import { BedrockGameGenerator } from "../../infrastructure/ai/BedrockGameGenerator.ts";
import { BedrockGameValidator } from "../../infrastructure/ai/BedrockGameValidator.ts";
import { DynamoDbGameRepository } from "../../infrastructure/repositories/DynamoDbGameRepository.ts";
import { DynamoDbGameSessionRepository } from "../../infrastructure/repositories/DynamoDbGameSessionRepository.ts";
import { createHttpRouter } from "./router.ts";

interface RuntimeRouterOptions {
  environment?: Record<string, string | undefined>;
  documentClient?: ConstructorParameters<typeof DynamoDbGameRepository>[0];
  createBedrockClient?: (region: string) => ConstructorParameters<typeof BedrockGameGenerator>[0];
  createId?: () => string;
}

export function createRuntimeRouter({
  environment = process.env,
  documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  }),
  createBedrockClient = (region) => new BedrockRuntimeClient({ region }),
  createId = randomUUID,
}: RuntimeRouterOptions = {}) {
  const gamesTableName = requireConfiguration("GAMES_TABLE_NAME", environment);
  const gameSessionsTableName = requireConfiguration("GAME_SESSIONS_TABLE_NAME", environment);
  const enabled = environment.AI_GAME_GENERATION_ENABLED === "true";
  const games = new DynamoDbGameRepository(documentClient, gamesTableName);
  const sessions = new DynamoDbGameSessionRepository(documentClient, gameSessionsTableName);
  let generator: GameGenerator = {
    generate: async () => { throw new Error("AI generator is disabled."); },
  };
  let validator: GameValidator = {
    validate: async () => { throw new Error("AI validator is disabled."); },
  };
  let generatorModelId: string | undefined;
  let validatorModelId: string | undefined;

  if (enabled) {
    const region = requireConfiguration("BEDROCK_REGION", environment);
    generatorModelId = requireConfiguration("BEDROCK_GENERATOR_MODEL_ID", environment);
    validatorModelId = requireConfiguration("BEDROCK_VALIDATOR_MODEL_ID", environment);
    const guardrailIdentifier = requireConfiguration("BEDROCK_GUARDRAIL_ID", environment);
    const guardrailVersion = requireConfiguration("BEDROCK_GUARDRAIL_VERSION", environment);
    const bedrockClient = createBedrockClient(region);
    generator = new BedrockGameGenerator(bedrockClient, {
      modelId: generatorModelId,
      guardrailIdentifier,
      guardrailVersion,
    });
    validator = new BedrockGameValidator(bedrockClient, {
      modelId: validatorModelId,
      guardrailIdentifier,
      guardrailVersion,
    });
  }

  return createHttpRouter({
    games,
    sessionService: new GameSessionService(games, sessions),
    generationService: new GenerateGameService(generator, validator, games, {
      enabled,
      createId,
      logDiagnostic: (diagnostic) => console.log(JSON.stringify(diagnostic)),
      logEvent: (event) => console.log(JSON.stringify(event)),
      ...(generatorModelId && validatorModelId
        ? { models: { generator: generatorModelId, validator: validatorModelId } }
        : {}),
    }),
  });
}

function requireConfiguration(name: string, environment: Record<string, string | undefined>): string {
  const value = environment[name];
  if (!value) throw new Error(`Missing required backend configuration: ${name}`);
  return value;
}

let router: ReturnType<typeof createRuntimeRouter> | undefined;

export const handler: APIGatewayProxyHandlerV2 = async (event) =>
  (router ??= createRuntimeRouter())({
    requestId: event.requestContext.requestId,
    method: event.requestContext.http.method,
    path: event.rawPath,
    body: event.body,
  });
