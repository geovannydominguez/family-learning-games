import { randomUUID } from "node:crypto";

import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { PollyClient } from "@aws-sdk/client-polly";
import { S3Client } from "@aws-sdk/client-s3";

import type { GameGenerator } from "../../application/game/GameGenerator.ts";
import type { GameValidator } from "../../application/game/GameValidator.ts";
import { GenerateGameService } from "../../application/game/generateGameService.ts";
import { GameSessionService } from "../../application/game/gameSessionService.ts";
import { CatalogQuestionImageResolver, type MediaCatalogEntry } from "../../application/media/questionImages.ts";
import { QuestionSpeechService } from "../../application/media/questionSpeech.ts";
import { PlayerService } from "../../application/player/playerService.ts";
import mediaCatalog from "../../data/mediaCatalog.json" with { type: "json" };
import { BedrockGameGenerator } from "../../infrastructure/ai/BedrockGameGenerator.ts";
import { BedrockGameValidator } from "../../infrastructure/ai/BedrockGameValidator.ts";
import { DynamoDbGameRepository } from "../../infrastructure/repositories/DynamoDbGameRepository.ts";
import { DynamoDbGameSessionRepository } from "../../infrastructure/repositories/DynamoDbGameSessionRepository.ts";
import { PollySpeechSynthesizer, type PollySendClient } from "../../infrastructure/media/PollySpeechSynthesizer.ts";
import { createS3ReadUrlSigner, S3MediaObjectStore, type ReadUrlSigner, type S3SendClient } from "../../infrastructure/media/S3MediaObjectStore.ts";
import { DynamoDbPlayerRepository } from "../../infrastructure/repositories/DynamoDbPlayerRepository.ts";
import { createHttpRouter } from "./router.ts";

interface RuntimeRouterOptions {
  environment?: Record<string, string | undefined>;
  documentClient?: ConstructorParameters<typeof DynamoDbGameRepository>[0];
  createBedrockClient?: (region: string) => ConstructorParameters<typeof BedrockGameGenerator>[0];
  createId?: () => string;
  createPollyClient?: () => PollySendClient;
  createS3Client?: () => { client: S3SendClient; signReadUrl: ReadUrlSigner };
  mediaCatalogEntries?: readonly MediaCatalogEntry[];
}

/**
 * v0.8 media clients use bounded retries/timeouts (NFR-0812) so a slow provider
 * fails fast with a safe error well inside the Lambda timeout.
 */
function defaultPollyClient(): PollyClient {
  return new PollyClient({ maxAttempts: 2, requestHandler: { connectionTimeout: 1_000, requestTimeout: 2_500 } });
}

function defaultS3Client(): { client: S3Client; signReadUrl: ReadUrlSigner } {
  const client = new S3Client({ maxAttempts: 2, requestHandler: { connectionTimeout: 1_000, requestTimeout: 1_000 } });
  return { client, signReadUrl: createS3ReadUrlSigner(client) };
}

export function createRuntimeRouter({
  environment = process.env,
  documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  }),
  createBedrockClient = (region) => new BedrockRuntimeClient({ region }),
  createId = randomUUID,
  createPollyClient = defaultPollyClient,
  createS3Client = defaultS3Client,
  mediaCatalogEntries = mediaCatalog.images,
}: RuntimeRouterOptions = {}) {
  const gamesTableName = requireConfiguration("GAMES_TABLE_NAME", environment);
  const gameSessionsTableName = requireConfiguration("GAME_SESSIONS_TABLE_NAME", environment);
  const playersTableName = requireConfiguration("PLAYERS_TABLE_NAME", environment);
  const enabled = environment.AI_GAME_GENERATION_ENABLED === "true";
  const games = new DynamoDbGameRepository(documentClient, gamesTableName);
  const sessions = new DynamoDbGameSessionRepository(documentClient, gameSessionsTableName);
  const players = new DynamoDbPlayerRepository(documentClient, playersTableName);
  const playerService = new PlayerService(players);
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

  // v0.8 (ADR-016/017): media is enabled only when a media bucket is configured.
  // Independent of AI generation: it never touches the Generator/Validator path.
  let speechService: QuestionSpeechService | undefined;
  let imageResolver: CatalogQuestionImageResolver | undefined;
  const mediaBucketName = environment.MEDIA_BUCKET_NAME;
  if (mediaBucketName) {
    const logMediaEvent = (event: object) => console.log(JSON.stringify(event));
    const s3 = createS3Client();
    const store = new S3MediaObjectStore(s3.client, mediaBucketName, s3.signReadUrl);
    speechService = new QuestionSpeechService(
      games,
      new PollySpeechSynthesizer(createPollyClient(), {
        voiceId: requireConfiguration("POLLY_VOICE_ID", environment),
        engine: requireConfiguration("POLLY_ENGINE", environment),
        outputFormat: environment.POLLY_OUTPUT_FORMAT || "mp3",
      }),
      store,
      {
        languageCode: requireConfiguration("POLLY_LANGUAGE_CODE", environment),
        cacheVersion: environment.AUDIO_CACHE_VERSION || "v1",
        urlTtlSeconds: readSeconds("AUDIO_URL_TTL_SECONDS", environment),
        logEvent: logMediaEvent,
      },
    );
    imageResolver = new CatalogQuestionImageResolver(mediaCatalogEntries, store, {
      urlTtlSeconds: readSeconds("IMAGE_URL_TTL_SECONDS", environment),
      logEvent: logMediaEvent,
    });
  }

  return createHttpRouter({
    games,
    sessionService: new GameSessionService(games, sessions, players, undefined, undefined, imageResolver),
    speechService,
    imageResolver,
    playerService,
    generationService: new GenerateGameService(generator, validator, games, players, {
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

function readSeconds(name: string, environment: Record<string, string | undefined>): number {
  const value = environment[name];
  if (!value) return 900;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3_600) {
    throw new Error(`Invalid backend configuration: ${name} must be an integer between 60 and 3600.`);
  }
  return seconds;
}

let router: ReturnType<typeof createRuntimeRouter> | undefined;

export const handler: APIGatewayProxyHandlerV2 = async (event, context) =>
  (router ??= createRuntimeRouter())({
    requestId: event.requestContext.requestId,
    method: event.requestContext.http.method,
    path: event.rawPath,
    body: event.body,
    // ADR-015: lets AI generation avoid starting a call it cannot finish.
    remainingTimeMs: () => context.getRemainingTimeInMillis(),
  });
