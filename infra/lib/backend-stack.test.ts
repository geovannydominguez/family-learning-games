import assert from "node:assert/strict";
import test from "node:test";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { FamilyLearningGamesBackendStack } from "./backend-stack.ts";

test("defines the default-disabled Lambda, seven-route HTTP API, durable tables and least-privilege access", () => {
  const app = new App({ context: { frontendOrigin: "https://family.example.com" } });
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(app, "TestStack"));
  template.resourceCountIs("AWS::Lambda::Function", 1);
  template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
  template.resourceCountIs("AWS::ApiGatewayV2::Route", 7);
  template.resourceCountIs("AWS::DynamoDB::Table", 2);
  template.resourceCountIs("AWS::Logs::LogGroup", 1);
  template.hasResourceProperties("AWS::Lambda::Function", { Runtime: "nodejs22.x", Timeout: 10 });
  template.hasResourceProperties("AWS::Lambda::Function", { Environment: { Variables: Match.objectLike({
    GAMES_TABLE_NAME: Match.anyValue(),
    GAME_SESSIONS_TABLE_NAME: Match.anyValue(),
    AI_GAME_GENERATION_ENABLED: "false",
  }) } });
  template.hasResourceProperties("AWS::ApiGatewayV2::Api", { CorsConfiguration: Match.objectLike({ AllowOrigins: ["https://family.example.com"] }) });
  template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 7 });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /game-setup" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /games" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /games/{gameId}" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /games/generate" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /game-sessions" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /game-sessions/{sessionId}/answers" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /game-sessions/{sessionId}" });
  template.hasResourceProperties("AWS::DynamoDB::Table", { BillingMode: "PAY_PER_REQUEST", KeySchema: [{ AttributeName: Match.anyValue(), KeyType: "HASH" }] });
  template.allResourcesProperties("AWS::DynamoDB::Table", Match.objectLike({ BillingMode: "PAY_PER_REQUEST" }));
  template.hasResourceProperties("AWS::DynamoDB::Table", { TableName: "dev-family-learning-games-games" });
  template.hasResourceProperties("AWS::DynamoDB::Table", { TableName: "dev-family-learning-games-game-sessions" });
  template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Delete", UpdateReplacePolicy: "Delete" });
  template.hasResourceProperties("AWS::IAM::Policy", { PolicyDocument: { Statement: Match.arrayWith([
    Match.objectLike({ Action: ["dynamodb:GetItem", "dynamodb:Scan"], Effect: "Allow" }),
    Match.objectLike({ Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], Effect: "Allow" }),
  ]) } });
  template.resourceCountIs("AWS::Bedrock::Guardrail", 0);
  template.resourceCountIs("AWS::Bedrock::GuardrailVersion", 0);
  assert.equal(JSON.stringify(template.toJSON()).includes("bedrock:InvokeModel"), false);
  assert.equal(JSON.stringify(template.toJSON()).includes("bedrock:ApplyGuardrail"), false);
  template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
    StageName: "$default",
    DefaultRouteSettings: Match.absent(),
    RouteSettings: {
      "POST /games/generate": {
        ThrottlingRateLimit: 1,
        ThrottlingBurstLimit: 2,
      },
    },
  });
  const generationRouteLogicalId = Object.entries(template.findResources("AWS::ApiGatewayV2::Route"))
    .find(([, resource]) => resource.Properties.RouteKey === "POST /games/generate")?.[0];
  assert.ok(generationRouteLogicalId);
  template.hasResource("AWS::ApiGatewayV2::Stage", {
    DependsOn: Match.arrayWith([generationRouteLogicalId]),
  });
  for (const forbidden of ["AWS::Cognito::UserPool", "AWS::SQS::Queue", "AWS::EC2::VPC"]) template.resourceCountIs(forbidden, 0);
});

test("provisions one guarded Bedrock integration with scoped IAM when enabled by string context", () => {
  const app = new App({ context: { aiGameGenerationEnabled: "true" } });
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(app, "EnabledStack"));

  template.resourceCountIs("AWS::Lambda::Function", 1);
  template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
  template.resourceCountIs("AWS::ApiGatewayV2::Route", 7);
  template.resourceCountIs("AWS::DynamoDB::Table", 2);
  template.resourceCountIs("AWS::Bedrock::Guardrail", 1);
  template.resourceCountIs("AWS::Bedrock::GuardrailVersion", 1);
  template.hasResourceProperties("AWS::Lambda::Function", {
    Timeout: 28,
    Environment: { Variables: Match.objectLike({
      AI_GAME_GENERATION_ENABLED: "true",
      BEDROCK_MODEL_ID: "amazon.nova-micro-v1:0",
      BEDROCK_REGION: "us-east-1",
      BEDROCK_GUARDRAIL_ID: Match.anyValue(),
      BEDROCK_GUARDRAIL_VERSION: Match.anyValue(),
    }) },
  });
  template.hasResourceProperties("AWS::Bedrock::Guardrail", {
    BlockedInputMessaging: "This request cannot be processed.",
    BlockedOutputsMessaging: "This generated content cannot be provided.",
    ContentPolicyConfig: { FiltersConfig: [
      "SEXUAL", "VIOLENCE", "HATE", "INSULTS", "MISCONDUCT", "PROMPT_ATTACK",
    ].map((type) => Match.objectLike({ Type: type, InputStrength: "HIGH", OutputStrength: "HIGH" })) },
    SensitiveInformationPolicyConfig: { PiiEntitiesConfig: Match.arrayWith([
      Match.objectLike({ Type: "EMAIL", Action: "BLOCK" }),
      Match.objectLike({ Type: "PHONE", Action: "BLOCK" }),
      Match.objectLike({ Type: "ADDRESS", Action: "BLOCK" }),
    ]) },
  });
  const guardrail = Object.values(template.findResources("AWS::Bedrock::Guardrail"))[0];
  const pii = guardrail.Properties.SensitiveInformationPolicyConfig.PiiEntitiesConfig as Array<{ Type: string }>;
  assert.equal(pii.some(({ Type }) => Type === "NAME"), false);
  template.hasResourceProperties("AWS::Bedrock::GuardrailVersion", {
    Description: Match.stringLikeRegexp("^policy-sha256:[a-f0-9]{64}$"),
    GuardrailIdentifier: Match.anyValue(),
  });

  const synthesized = JSON.stringify(template.toJSON());
  assert.match(synthesized, /bedrock:InvokeModel/);
  assert.match(synthesized, /foundation-model\/amazon\.nova-micro-v1:0/);
  assert.match(synthesized, /bedrock:ApplyGuardrail/);
  assert.match(synthesized, /dynamodb:PutItem/);
  assert.doesNotMatch(synthesized, /"Action":"bedrock:\*"/);
  assert.doesNotMatch(synthesized, /"Resource":"\*"/);
  const gamesTableLogicalId = Object.entries(template.findResources("AWS::DynamoDB::Table"))
    .find(([, resource]) => resource.Properties.TableName === "dev-family-learning-games-games")?.[0];
  assert.ok(gamesTableLogicalId);
  const statements = Object.values(template.findResources("AWS::IAM::Policy"))
    .flatMap((resource) => resource.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>);
  assert.equal(statements.some((statement) => statement.Action === "dynamodb:PutItem"
    && JSON.stringify(statement.Resource).includes(gamesTableLogicalId)), true);
});

test("uses the deployment region for the Guardrail, Runtime client and model ARN", () => {
  const defaultStack = new FamilyLearningGamesBackendStack(
    new App({ context: { aiGameGenerationEnabled: true } }),
    "DefaultRegionStack",
  );
  assert.equal(defaultStack.region, "us-east-1");
  const defaultTemplate = Template.fromStack(defaultStack);
  defaultTemplate.hasResourceProperties("AWS::Lambda::Function", {
    Environment: { Variables: Match.objectLike({ BEDROCK_REGION: "us-east-1" }) },
  });
  assert.match(JSON.stringify(defaultTemplate.toJSON()), /:bedrock:us-east-1::foundation-model/);

  const customStack = new FamilyLearningGamesBackendStack(
    new App({ context: { aiGameGenerationEnabled: true } }),
    "CustomRegionStack",
    { env: { region: "eu-west-1" } },
  );
  assert.equal(customStack.region, "eu-west-1");
  const customTemplate = Template.fromStack(customStack);
  customTemplate.hasResourceProperties("AWS::Lambda::Function", {
    Environment: { Variables: Match.objectLike({ BEDROCK_REGION: "eu-west-1" }) },
  });
  assert.match(JSON.stringify(customTemplate.toJSON()), /:bedrock:eu-west-1::foundation-model/);
});

test("accepts configurable route throttling and rejects unsafe context values", () => {
  const app = new App({ context: {
    generationThrottleRateLimit: "3.5",
    generationThrottleBurstLimit: "4",
    aiGameGenerationEnabled: "false",
  } });
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(app, "ThrottleStack"));
  template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
    DefaultRouteSettings: Match.absent(),
    RouteSettings: {
      "POST /games/generate": {
        ThrottlingRateLimit: 3.5,
        ThrottlingBurstLimit: 4,
      },
    },
  });

  for (const context of [
    { aiGameGenerationEnabled: "yes" },
    { generationThrottleRateLimit: "0" },
    { generationThrottleRateLimit: "not-a-number" },
    { generationThrottleBurstLimit: "1.5" },
  ]) {
    assert.throws(
      () => new FamilyLearningGamesBackendStack(new App({ context }), `Invalid${Object.keys(context)[0]}Stack`),
      /invalid CDK context/i,
    );
  }
});

test("lets explicit stack props override route throttle context", () => {
  const app = new App({ context: {
    generationThrottleRateLimit: "9",
    generationThrottleBurstLimit: "9",
  } });
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(app, "ThrottlePropsStack", {
    generationThrottleRateLimit: 2.25,
    generationThrottleBurstLimit: 3,
  }));

  template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
    RouteSettings: {
      "POST /games/generate": {
        ThrottlingRateLimit: 2.25,
        ThrottlingBurstLimit: 3,
      },
    },
  });
});

test("prefixes DynamoDB table names with the configured environment", () => {
  const app = new App({ context: { environment: "test" } });
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(app, "TestEnvironmentStack"));

  template.hasResourceProperties("AWS::DynamoDB::Table", { TableName: "test-family-learning-games-games" });
  template.hasResourceProperties("AWS::DynamoDB::Table", { TableName: "test-family-learning-games-game-sessions" });
});

test("defaults CORS to localhost when no origin context is supplied", () => {
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(new App(), "DefaultOriginStack"));
  template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
    CorsConfiguration: Match.objectLike({ AllowOrigins: ["http://localhost:3000"] }),
  });
});

test("accepts a comma-separated allowedOrigins context alongside localhost", () => {
  const app = new App({ context: {
    allowedOrigins: "http://localhost:3000, https://main.d123456789.amplifyapp.com",
  } });
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(app, "AllowedOriginsStack"));
  template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
    CorsConfiguration: Match.objectLike({
      AllowOrigins: ["http://localhost:3000", "https://main.d123456789.amplifyapp.com"],
    }),
  });
});

test("lets explicit allowedOrigins props override context and rejects malformed origins", () => {
  const app = new App({ context: { allowedOrigins: "http://localhost:3000" } });
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(app, "AllowedOriginsPropsStack", {
    allowedOrigins: ["https://family.example.com"],
  }));
  template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
    CorsConfiguration: Match.objectLike({ AllowOrigins: ["https://family.example.com"] }),
  });

  const invalidOriginContexts = [
    { allowedOrigins: "" },
    { allowedOrigins: "not-an-origin" },
    { allowedOrigins: "https://family.example.com/" },
    { frontendOrigin: "ftp://family.example.com" },
  ];
  invalidOriginContexts.forEach((context, index) => {
    assert.throws(
      () => new FamilyLearningGamesBackendStack(new App({ context }), `InvalidOriginStack${index}`),
      /invalid CDK context/i,
    );
  });
});
