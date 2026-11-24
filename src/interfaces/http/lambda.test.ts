import assert from "node:assert/strict";
import test from "node:test";

import { createRuntime, createRuntimeRouter, toWebSocketRequest } from "./lambda.ts";

const baseEnvironment = {
  GAMES_TABLE_NAME: "Games",
  GAME_SESSIONS_TABLE_NAME: "Sessions",
  PLAYERS_TABLE_NAME: "Players",
};

const documentClient = { send: async () => ({ Items: [] }) };

test("AI generation defaults to disabled without requiring or instantiating Bedrock configuration", () => {
  let bedrockClients = 0;

  createRuntimeRouter({
    environment: baseEnvironment,
    documentClient,
    createBedrockClient: () => {
      bedrockClients += 1;
      throw new Error("must not instantiate");
    },
  });

  assert.equal(bedrockClients, 0);
});

test("enabled generation requires every Bedrock configuration value", () => {
  const required = [
    "BEDROCK_GENERATOR_MODEL_ID",
    "BEDROCK_VALIDATOR_MODEL_ID",
    "BEDROCK_REGION",
    "BEDROCK_GUARDRAIL_ID",
    "BEDROCK_GUARDRAIL_VERSION",
  ] as const;
  const complete = {
    ...baseEnvironment,
    AI_GAME_GENERATION_ENABLED: "true",
    BEDROCK_GENERATOR_MODEL_ID: "amazon.nova-lite-v1:0",
    BEDROCK_VALIDATOR_MODEL_ID: "amazon.nova-pro-v1:0",
    BEDROCK_REGION: "us-east-1",
    BEDROCK_GUARDRAIL_ID: "guardrail",
    BEDROCK_GUARDRAIL_VERSION: "1",
  };

  for (const missing of required) {
    const environment = { ...complete };
    delete environment[missing];
    let bedrockClients = 0;
    assert.throws(
      () => createRuntimeRouter({
        environment,
        documentClient,
        createBedrockClient: () => {
          bedrockClients += 1;
          return { send: async () => ({}) };
        },
      }),
      new RegExp(`Missing required backend configuration: ${missing}`),
    );
    assert.equal(bedrockClients, 0);
  }
});

test("enabled generation constructs one regional Bedrock client", () => {
  const regions: string[] = [];
  createRuntimeRouter({
    environment: {
      ...baseEnvironment,
      AI_GAME_GENERATION_ENABLED: "true",
      BEDROCK_GENERATOR_MODEL_ID: "amazon.nova-lite-v1:0",
      BEDROCK_VALIDATOR_MODEL_ID: "amazon.nova-pro-v1:0",
      BEDROCK_REGION: "us-west-2",
      BEDROCK_GUARDRAIL_ID: "guardrail",
      BEDROCK_GUARDRAIL_VERSION: "DRAFT",
      AI_GENERATION_QUOTA_TABLE_NAME: "Multiplayer",
    },
    documentClient,
    createBedrockClient: (region) => {
      regions.push(region);
      return { send: async () => ({}) };
    },
    createId: () => "123e4567-e89b-12d3-a456-426614174000",
  });

  assert.deepEqual(regions, ["us-west-2"]);
});

const generationEnvironment = {
  ...baseEnvironment,
  AI_GAME_GENERATION_ENABLED: "true",
  BEDROCK_GENERATOR_MODEL_ID: "global.anthropic.claude-sonnet-4-6",
  BEDROCK_VALIDATOR_MODEL_ID: "global.anthropic.claude-sonnet-4-6",
  BEDROCK_REGION: "us-east-1",
  BEDROCK_GUARDRAIL_ID: "guardrail",
  BEDROCK_GUARDRAIL_VERSION: "1",
  AI_GENERATION_QUOTA_TABLE_NAME: "Multiplayer",
  AI_GENERATION_DAILY_LIMIT: "20",
  AI_GENERATION_QUOTA_TIMEZONE: "America/Guayaquil",
};

test("v0.9.3 enabled generation requires the quota table and never builds Bedrock without it", () => {
  const environment: Record<string, string> = { ...generationEnvironment };
  delete environment.AI_GENERATION_QUOTA_TABLE_NAME;
  let bedrockClients = 0;
  assert.throws(
    () => createRuntimeRouter({ environment, documentClient, createBedrockClient: () => { bedrockClients += 1; return { send: async () => ({}) }; } }),
    /Missing required backend configuration: AI_GENERATION_QUOTA_TABLE_NAME/,
  );
  assert.equal(bedrockClients, 0);
});

test("v0.9.3 rejects an invalid daily limit or time zone at startup", () => {
  for (const override of [
    { AI_GENERATION_DAILY_LIMIT: "-1" },
    { AI_GENERATION_DAILY_LIMIT: "1.5" },
    { AI_GENERATION_DAILY_LIMIT: "1001" },
    { AI_GENERATION_DAILY_LIMIT: "veinte" },
    { AI_GENERATION_QUOTA_TIMEZONE: "Mars/Olympus" },
  ]) {
    assert.throws(
      () => createRuntimeRouter({ environment: { ...generationEnvironment, ...override }, documentClient, createBedrockClient: () => ({ send: async () => ({}) }) }),
      /Invalid backend configuration/,
    );
  }
});

test("v0.9.3 quota defaults to 20 per day in America/Guayaquil when only the table is configured", async () => {
  const environment: Record<string, string> = { ...generationEnvironment };
  delete environment.AI_GENERATION_DAILY_LIMIT;
  delete environment.AI_GENERATION_QUOTA_TIMEZONE;
  const updates: Array<Record<string, unknown>> = [];
  const router = createRuntimeRouter({
    environment,
    documentClient: {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.constructor.name === "GetCommand") return { Item: { playerId: "amelia", name: "Amelia", age: 6, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } };
        if (command.constructor.name === "UpdateCommand") {
          updates.push(command.input);
          throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException", Item: { used: { N: "20" } } });
        }
        return {};
      },
    } as never,
    createBedrockClient: () => ({ send: async () => { throw new Error("must not call Bedrock"); } }),
  });
  await router({ requestId: "r", method: "POST", path: "/games/generate", body: JSON.stringify({ topic: "planetas", difficulty: "easy", questionCount: 10, playerId: "amelia" }) });
  assert.equal(updates.length, 1);
  assert.equal((updates[0].ExpressionAttributeValues as Record<string, unknown>)[":limit"], 20);
  assert.match(String((updates[0].Key as Record<string, unknown>).SK), /^DAY#\d{4}-\d{2}-\d{2}$/);
});

test("v0.9.3 an exhausted quota answers 429 with Retry-After and never invokes Bedrock", async () => {
  let bedrockCalls = 0;
  const router = createRuntimeRouter({
    environment: { ...generationEnvironment, AI_GENERATION_DAILY_LIMIT: "1" },
    documentClient: {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === "GetCommand") return { Item: { playerId: "amelia", name: "Amelia", age: 6, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } };
        if (command.constructor.name === "UpdateCommand") {
          throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException", Item: { used: { N: "1" }, reservations: { SS: ["someone-else"] } } });
        }
        return {};
      },
    } as never,
    createBedrockClient: () => ({ send: async () => { bedrockCalls += 1; return {}; } }),
  });
  const response = await router({ requestId: "r", method: "POST", path: "/games/generate", body: JSON.stringify({ topic: "planetas", difficulty: "easy", questionCount: 10, playerId: "amelia" }) });
  assert.equal(response.statusCode, 429);
  assert.deepEqual(JSON.parse(response.body), { error: { code: "AI_GENERATION_QUOTA_EXCEEDED", message: "The daily AI game generation quota has been reached." } });
  const retryAfter = Number(response.headers["retry-after"]);
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 25 * 60 * 60);
  assert.equal(bedrockCalls, 0);
});

test("v0.9.3 a DynamoDB failure while reserving fails closed without invoking Bedrock", async () => {
  let bedrockCalls = 0;
  const router = createRuntimeRouter({
    environment: generationEnvironment,
    documentClient: {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === "GetCommand") return { Item: { playerId: "amelia", name: "Amelia", age: 6, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } };
        if (command.constructor.name === "UpdateCommand") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
        return {};
      },
    } as never,
    createBedrockClient: () => ({ send: async () => { bedrockCalls += 1; return {}; } }),
  });
  const response = await router({ requestId: "r", method: "POST", path: "/games/generate", body: JSON.stringify({ topic: "planetas", difficulty: "easy", questionCount: 10, playerId: "amelia" }) });
  assert.equal(response.statusCode, 500);
  assert.equal(JSON.parse(response.body).error.code, "UNEXPECTED_ERROR");
  assert.equal(bedrockCalls, 0);
});

const mediaEnvironment = {
  ...baseEnvironment,
  MEDIA_BUCKET_NAME: "media-bucket",
  POLLY_VOICE_ID: "Lupe",
  POLLY_ENGINE: "neural",
  POLLY_LANGUAGE_CODE: "es-US",
};

test("v0.8 media stays disabled without a media bucket and never instantiates Polly or S3", async () => {
  let clients = 0;
  const router = createRuntimeRouter({
    environment: baseEnvironment,
    documentClient,
    createPollyClient: () => { clients += 1; throw new Error("must not instantiate"); },
    createS3Client: () => { clients += 1; throw new Error("must not instantiate"); },
  });
  const response = await router({ requestId: "r", method: "POST", path: "/games/animals/questions/q1/audio", body: "{}" });
  assert.equal(response.statusCode, 503);
  assert.equal(clients, 0);
});

test("v0.8 media requires Polly voice configuration when a media bucket is configured", () => {
  for (const missing of ["POLLY_VOICE_ID", "POLLY_ENGINE", "POLLY_LANGUAGE_CODE"] as const) {
    const environment: Record<string, string> = { ...mediaEnvironment };
    delete environment[missing];
    assert.throws(
      () => createRuntimeRouter({
        environment,
        documentClient,
        createPollyClient: () => ({ send: async () => ({}) }),
        createS3Client: () => ({ client: { send: async () => ({}) }, signReadUrl: async () => "https://signed" }),
      }),
      new RegExp(missing),
    );
  }
  assert.throws(() => createRuntimeRouter({
    environment: { ...mediaEnvironment, AUDIO_URL_TTL_SECONDS: "86400" },
    documentClient,
    createPollyClient: () => ({ send: async () => ({}) }),
    createS3Client: () => ({ client: { send: async () => ({}) }, signReadUrl: async () => "https://signed" }),
  }), /AUDIO_URL_TTL_SECONDS/);
  // v0.8 single speech profile: another language or voice cannot be configured.
  for (const override of [{ POLLY_LANGUAGE_CODE: "es-MX" }, { POLLY_LANGUAGE_CODE: "es-ES" }, { POLLY_VOICE_ID: "Mia" }]) {
    assert.throws(() => createRuntimeRouter({
      environment: { ...mediaEnvironment, ...override },
      documentClient,
      createPollyClient: () => ({ send: async () => ({}) }),
      createS3Client: () => ({ client: { send: async () => ({}) }, signReadUrl: async () => "https://signed" }),
    }), /single v0\.8 speech profile|only the Polly voice Lupe/);
  }
});

test("v0.8 media wiring: audio endpoint uses the configured bucket, Polly voice and AI stays disabled", async () => {
  const pollyInputs: unknown[] = [];
  const s3Commands: Array<{ constructor: { name: string }; input: { Bucket?: string; Key?: string } }> = [];
  const game = {
    gameId: "animals",
    title: "Animales",
    category: { id: "animals", name: "Animales", description: "d", icon: "🐼" },
    players: [],
    questions: [{ id: "q1", categoryId: "animals", difficulty: "easy", text: "¿Qué animal dice miau?", answers: [{ id: "a1", text: "Gato", isCorrect: true }, { id: "a2", text: "Perro", isCorrect: false }] }],
    version: 1,
    sortOrder: 0,
  };
  const router = createRuntimeRouter({
    environment: mediaEnvironment,
    documentClient: { send: async () => ({ Item: game }) },
    createBedrockClient: () => { throw new Error("AI must stay disabled"); },
    createPollyClient: () => ({
      send: async (command) => {
        pollyInputs.push(command.input);
        return { AudioStream: { transformToByteArray: async () => new Uint8Array([1]) } };
      },
    }),
    createS3Client: () => ({
      client: {
        send: async (command) => {
          s3Commands.push(command as never);
          if (command.constructor.name === "HeadObjectCommand") throw Object.assign(new Error("nf"), { name: "NotFound" });
          return {};
        },
      },
      signReadUrl: async (bucket, key) => `https://${bucket}.s3.amazonaws.com/${key}?X-Amz-Signature=x`,
    }),
  });
  const response = await router({ requestId: "r", method: "POST", path: "/games/animals/questions/q1/audio", body: "{}" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(pollyInputs, [{
    Text: "¿Qué animal dice miau?\nOpción 1: Gato.\nOpción 2: Perro.",
    TextType: "text",
    LanguageCode: "es-US",
    VoiceId: "Lupe",
    Engine: "neural",
    OutputFormat: "mp3",
  }]);
  assert.deepEqual(s3Commands.map((command) => command.constructor.name), ["HeadObjectCommand", "PutObjectCommand"]);
  assert.equal(s3Commands.every((command) => command.input.Bucket === "media-bucket" && /^audio-cache\/v1\/[a-f0-9]{64}\.mp3$/.test(command.input.Key ?? "")), true);
});

const multiplayerEnvironment = {
  ...baseEnvironment,
  MULTIPLAYER_TABLE_NAME: "Multiplayer",
  WEBSOCKET_CALLBACK_ENDPOINT: "https://ws.example.com/production",
  MULTIPLAYER_ALLOWED_ORIGINS: "http://localhost:3000,https://play.example.com",
};

test("v0.9 multiplayer is disabled without a multiplayer table and never builds a Management API client", () => {
  let clients = 0;
  const runtime = createRuntime({ environment: baseEnvironment, documentClient, createManagementApiClient: () => { clients += 1; return { send: async () => ({}) }; } });
  assert.equal(runtime.websocket, undefined);
  assert.equal(clients, 0);
});

test("v0.9 multiplayer requires its callback endpoint and allowed origins, and validates capacity", () => {
  for (const missing of ["WEBSOCKET_CALLBACK_ENDPOINT", "MULTIPLAYER_ALLOWED_ORIGINS"] as const) {
    const environment: Record<string, string> = { ...multiplayerEnvironment };
    delete environment[missing];
    assert.throws(() => createRuntime({ environment, documentClient, createManagementApiClient: () => ({ send: async () => ({}) }) }), new RegExp(missing));
  }
  assert.throws(
    () => createRuntime({ environment: { ...multiplayerEnvironment, MULTIPLAYER_MAX_PLAYERS: "20" }, documentClient, createManagementApiClient: () => ({ send: async () => ({}) }) }),
    /MULTIPLAYER_MAX_PLAYERS/,
  );
  const endpoints: string[] = [];
  const runtime = createRuntime({ environment: multiplayerEnvironment, documentClient, createManagementApiClient: (endpoint) => { endpoints.push(endpoint); return { send: async () => ({}) }; } });
  assert.ok(runtime.websocket);
  assert.deepEqual(endpoints, ["https://ws.example.com/production"]);
});

test("the same handler entry point routes WebSocket $connect by Origin (case-insensitive header)", async () => {
  const runtime = createRuntime({ environment: multiplayerEnvironment, documentClient, createManagementApiClient: () => ({ send: async () => ({}) }) });
  const event = (origin: string) => ({
    headers: { Origin: origin },
    isBase64Encoded: false,
    requestContext: { connectionId: "c-1", eventType: "CONNECT", requestId: "r-1", routeKey: "$connect" },
  }) as unknown as Parameters<typeof toWebSocketRequest>[0];
  assert.deepEqual(toWebSocketRequest(event("https://play.example.com")), { eventType: "CONNECT", connectionId: "c-1", requestId: "r-1", origin: "https://play.example.com", body: undefined });
  assert.equal((await runtime.websocket!(toWebSocketRequest(event("https://play.example.com")))).statusCode, 200);
  assert.equal((await runtime.websocket!(toWebSocketRequest(event("https://evil.example.com")))).statusCode, 403);
});
