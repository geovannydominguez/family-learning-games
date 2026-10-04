import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeRouter } from "./lambda.ts";

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
