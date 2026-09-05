import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeRouter } from "./lambda.ts";

const baseEnvironment = {
  GAMES_TABLE_NAME: "Games",
  GAME_SESSIONS_TABLE_NAME: "Sessions",
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
    "BEDROCK_MODEL_ID",
    "BEDROCK_REGION",
    "BEDROCK_GUARDRAIL_ID",
    "BEDROCK_GUARDRAIL_VERSION",
  ] as const;
  const complete = {
    ...baseEnvironment,
    AI_GAME_GENERATION_ENABLED: "true",
    BEDROCK_MODEL_ID: "model",
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
      BEDROCK_MODEL_ID: "model",
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
