import { randomUUID } from "node:crypto";

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, APIGatewayProxyWebsocketEventV2, Context } from "aws-lambda";
import { ApiGatewayManagementApiClient } from "@aws-sdk/client-apigatewaymanagementapi";
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
import { defaultMultiplayerSettings, type MultiplayerSettings } from "../../application/multiplayer/contracts.ts";
import { MultiplayerGameplayService } from "../../application/multiplayer/multiplayerGameplayService.ts";
import { MultiplayerRoomNotifier } from "../../application/multiplayer/multiplayerRoomNotifier.ts";
import { MultiplayerRoomService } from "../../application/multiplayer/multiplayerRoomService.ts";
import { participantTokens, randomRoomCodes } from "../../application/multiplayer/participantTokens.ts";
import { PlayerService } from "../../application/player/playerService.ts";
import mediaCatalog from "../../data/mediaCatalog.json" with { type: "json" };
import { BedrockGameGenerator } from "../../infrastructure/ai/BedrockGameGenerator.ts";
import { BedrockGameValidator } from "../../infrastructure/ai/BedrockGameValidator.ts";
import { DynamoDbGameRepository } from "../../infrastructure/repositories/DynamoDbGameRepository.ts";
import { DynamoDbGameSessionRepository } from "../../infrastructure/repositories/DynamoDbGameSessionRepository.ts";
import { PollySpeechSynthesizer, type PollySendClient } from "../../infrastructure/media/PollySpeechSynthesizer.ts";
import { createS3ReadUrlSigner, S3MediaObjectStore, type ReadUrlSigner, type S3SendClient } from "../../infrastructure/media/S3MediaObjectStore.ts";
import { DynamoDbPlayerRepository } from "../../infrastructure/repositories/DynamoDbPlayerRepository.ts";
import { ApiGatewayWebSocketBroadcaster, type ManagementApiSendClient } from "../../infrastructure/multiplayer/ApiGatewayWebSocketBroadcaster.ts";
import { DynamoDbMultiplayerRepository } from "../../infrastructure/multiplayer/DynamoDbMultiplayerRepository.ts";
import { createWebSocketRouter, type WebSocketRequest } from "../websocket/websocketRouter.ts";
import { createHttpRouter } from "./router.ts";

interface RuntimeRouterOptions {
  environment?: Record<string, string | undefined>;
  documentClient?: ConstructorParameters<typeof DynamoDbGameRepository>[0];
  createBedrockClient?: (region: string) => ConstructorParameters<typeof BedrockGameGenerator>[0];
  createId?: () => string;
  createPollyClient?: () => PollySendClient;
  createS3Client?: () => { client: S3SendClient; signReadUrl: ReadUrlSigner };
  mediaCatalogEntries?: readonly MediaCatalogEntry[];
  createManagementApiClient?: (endpoint: string) => ManagementApiSendClient;
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

/** v0.9: bounded retries/timeouts so one slow callback cannot stall a broadcast. */
function defaultManagementApiClient(endpoint: string): ApiGatewayManagementApiClient {
  return new ApiGatewayManagementApiClient({ endpoint, maxAttempts: 2, requestHandler: { connectionTimeout: 1_000, requestTimeout: 1_500 } });
}

/** HTTP router only (unchanged public entry point for existing callers/tests). */
export function createRuntimeRouter(options: RuntimeRouterOptions = {}) {
  return createRuntime(options).http;
}

/**
 * Wires the one backend Lambda for both API Gateway APIs (ADR-018): the
 * existing HTTP API and, when a multiplayer table is configured, the v0.9
 * WebSocket API.
 */
export function createRuntime({
  environment = process.env,
  documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  }),
  createBedrockClient = (region) => new BedrockRuntimeClient({ region }),
  createId = randomUUID,
  createPollyClient = defaultPollyClient,
  createS3Client = defaultS3Client,
  mediaCatalogEntries = mediaCatalog.images,
  createManagementApiClient = defaultManagementApiClient,
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

  // v0.9 (ADR-018/019/020): multiplayer is enabled only when its table is configured.
  let multiplayerRoomService: MultiplayerRoomService | undefined;
  let websocket: ReturnType<typeof createWebSocketRouter> | undefined;
  const multiplayerTableName = environment.MULTIPLAYER_TABLE_NAME;
  if (multiplayerTableName) {
    const logMultiplayerEvent = (event: object) => console.log(JSON.stringify(event));
    const settings = readMultiplayerSettings(environment);
    const repository = new DynamoDbMultiplayerRepository(documentClient, multiplayerTableName);
    const notifier = new MultiplayerRoomNotifier({
      repository,
      games,
      broadcaster: new ApiGatewayWebSocketBroadcaster(createManagementApiClient(requireConfiguration("WEBSOCKET_CALLBACK_ENDPOINT", environment))),
      ...(imageResolver ? { imageResolver } : {}),
      now: Date.now,
      logEvent: logMultiplayerEvent,
    });
    multiplayerRoomService = new MultiplayerRoomService({
      repository, games, players, tokens: participantTokens, roomCodes: randomRoomCodes, notifier, settings, createId, logEvent: logMultiplayerEvent,
    });
    const allowedOrigins = requireConfiguration("MULTIPLAYER_ALLOWED_ORIGINS", environment).split(",").map((origin) => origin.trim()).filter(Boolean);
    websocket = createWebSocketRouter({
      gameplay: new MultiplayerGameplayService({ repository, games, tokens: participantTokens, notifier, settings, allowedOrigins, logEvent: logMultiplayerEvent }),
    });
  }

  const http = createHttpRouter({
    games,
    multiplayerRoomService,
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
  return { http, websocket };
}

function readMultiplayerSettings(environment: Record<string, string | undefined>): MultiplayerSettings {
  return {
    ...defaultMultiplayerSettings,
    maxPlayers: readInteger("MULTIPLAYER_MAX_PLAYERS", environment, defaultMultiplayerSettings.maxPlayers, 2, 8),
    roomTtlMinutes: readInteger("MULTIPLAYER_ROOM_TTL_MINUTES", environment, defaultMultiplayerSettings.roomTtlMinutes, 10, 720),
    placementTieWindowMs: readInteger("MULTIPLAYER_PLACEMENT_TIE_WINDOW_MS", environment, defaultMultiplayerSettings.placementTieWindowMs, 0, 1_000),
  };
}

function readInteger(name: string, environment: Record<string, string | undefined>, fallback: number, min: number, max: number): number {
  const value = environment[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid backend configuration: ${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
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

let runtime: ReturnType<typeof createRuntime> | undefined;

/** One handler for both APIs: WebSocket events carry a `connectionId`, HTTP API v2 events do not. */
export async function handler(
  event: APIGatewayProxyEventV2 | APIGatewayProxyWebsocketEventV2,
  context: Context,
): Promise<APIGatewayProxyStructuredResultV2> {
  runtime ??= createRuntime();
  if ("connectionId" in event.requestContext) {
    if (!runtime.websocket) return { statusCode: 503 };
    return runtime.websocket(toWebSocketRequest(event as APIGatewayProxyWebsocketEventV2));
  }
  const httpEvent = event as APIGatewayProxyEventV2;
  return runtime.http({
    requestId: httpEvent.requestContext.requestId,
    method: httpEvent.requestContext.http.method,
    path: httpEvent.rawPath,
    body: httpEvent.body,
    // ADR-015: lets AI generation avoid starting a call it cannot finish.
    remainingTimeMs: () => context.getRemainingTimeInMillis(),
  });
}

export function toWebSocketRequest(event: APIGatewayProxyWebsocketEventV2): WebSocketRequest {
  const headers = (event as { headers?: Record<string, string | undefined> }).headers ?? {};
  const origin = Object.entries(headers).find(([name]) => name.toLowerCase() === "origin")?.[1];
  const eventType = event.requestContext.eventType;
  return {
    eventType: eventType === "CONNECT" || eventType === "DISCONNECT" ? eventType : "MESSAGE",
    connectionId: event.requestContext.connectionId,
    requestId: event.requestContext.requestId,
    ...(origin ? { origin } : {}),
    body: event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : event.body,
  };
}
