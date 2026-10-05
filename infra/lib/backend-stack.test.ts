import assert from "node:assert/strict";
import test from "node:test";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { FamilyLearningGamesBackendStack } from "./backend-stack.ts";

const autoDeleteHandlerPrefix = "CustomS3AutoDeleteObjectsCustomResourceProviderHandler";

/**
 * Exactly one application Lambda (the backend). The only other function allowed
 * is CDK's deploy-time S3 auto-delete handler, present only in non-production
 * environments (v0.8 media bucket cleanup on `cdk destroy`), never on the request path.
 */
function assertSingleApplicationLambda(template: Template, expectAutoDeleteHandler = true): void {
  const functions = Object.entries(template.findResources("AWS::Lambda::Function"));
  const application = functions.filter(([logicalId]) => !logicalId.startsWith(autoDeleteHandlerPrefix));
  const helpers = functions.filter(([logicalId]) => logicalId.startsWith(autoDeleteHandlerPrefix));
  assert.equal(application.length, 1);
  assert.equal(application[0][1].Properties.FunctionName, "family-learning-games-backend");
  assert.equal(helpers.length, expectAutoDeleteHandler ? 1 : 0);
}

test("defines the default-disabled Lambda, fourteen-route HTTP API, durable tables and least-privilege access", () => {
  const app = new App({ context: { frontendOrigin: "https://family.example.com" } });
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(app, "TestStack"));
  assertSingleApplicationLambda(template);
  // v0.9: the existing HTTP API (14 routes) plus the multiplayer WebSocket API (9 routes).
  template.resourceCountIs("AWS::ApiGatewayV2::Api", 2);
  template.resourceCountIs("AWS::ApiGatewayV2::Route", 23);
  template.resourceCountIs("AWS::DynamoDB::Table", 4);
  template.resourceCountIs("AWS::Logs::LogGroup", 1);
  template.hasResourceProperties("AWS::Lambda::Function", { Runtime: "nodejs22.x", Timeout: 10 });
  template.hasResourceProperties("AWS::Lambda::Function", {
    Environment: {
      Variables: Match.objectLike({
        GAMES_TABLE_NAME: Match.anyValue(),
        GAME_SESSIONS_TABLE_NAME: Match.anyValue(),
        PLAYERS_TABLE_NAME: Match.anyValue(),
        AI_GAME_GENERATION_ENABLED: "false",
      })
    }
  });
  template.hasResourceProperties("AWS::ApiGatewayV2::Api", { CorsConfiguration: Match.objectLike({ AllowOrigins: ["https://family.example.com"] }) });
  template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 7 });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /game-setup" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /games" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /games/{gameId}" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /games/generate" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /game-sessions" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /game-sessions/{sessionId}/answers" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /game-sessions/{sessionId}" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /players" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /players" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "PUT /players/{playerId}" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "DELETE /players/{playerId}" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /games/{gameId}/questions/{questionId}/audio" });
  template.hasResourceProperties("AWS::DynamoDB::Table", { BillingMode: "PAY_PER_REQUEST", KeySchema: [{ AttributeName: Match.anyValue(), KeyType: "HASH" }] });
  template.allResourcesProperties("AWS::DynamoDB::Table", Match.objectLike({ BillingMode: "PAY_PER_REQUEST" }));
  template.hasResourceProperties("AWS::DynamoDB::Table", { TableName: "dev-family-learning-games-games" });
  template.hasResourceProperties("AWS::DynamoDB::Table", { TableName: "dev-family-learning-games-game-sessions" });
  template.hasResourceProperties("AWS::DynamoDB::Table", { TableName: "dev-family-learning-games-players", KeySchema: [{ AttributeName: "playerId", KeyType: "HASH" }] });
  template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Delete", UpdateReplacePolicy: "Delete" });
  template.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({ Action: ["dynamodb:GetItem", "dynamodb:Scan"], Effect: "Allow" }),
        Match.objectLike({ Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], Effect: "Allow" }),
        Match.objectLike({ Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Scan"], Effect: "Allow" }),
      ])
    }
  });
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
  const playersTableLogicalId = Object.entries(template.findResources("AWS::DynamoDB::Table"))
    .find(([, resource]) => resource.Properties.TableName === "dev-family-learning-games-players")?.[0];
  assert.ok(playersTableLogicalId);
  const playersStatement = Object.values(template.findResources("AWS::IAM::Policy"))
    .flatMap((resource) => resource.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>)
    .find((statement) => Array.isArray(statement.Action) && (statement.Action as string[]).includes("dynamodb:DeleteItem"));
  assert.ok(playersStatement);
  assert.deepEqual((playersStatement!.Action as string[]).sort(), ["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Scan", "dynamodb:UpdateItem"]);
  assert.equal(JSON.stringify(playersStatement!.Resource).includes(playersTableLogicalId!), true);
  for (const forbidden of ["AWS::Cognito::UserPool", "AWS::SQS::Queue", "AWS::EC2::VPC"]) template.resourceCountIs(forbidden, 0);
});

test("provisions one guarded Bedrock integration with scoped IAM when enabled by string context", () => {
  const app = new App({ context: { aiGameGenerationEnabled: "true" } });
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(app, "EnabledStack"));

  assertSingleApplicationLambda(template);
  template.resourceCountIs("AWS::ApiGatewayV2::Api", 2);
  template.resourceCountIs("AWS::ApiGatewayV2::Route", 23);
  template.resourceCountIs("AWS::DynamoDB::Table", 4);
  template.resourceCountIs("AWS::Bedrock::Guardrail", 1);
  template.resourceCountIs("AWS::Bedrock::GuardrailVersion", 1);
  template.hasResourceProperties("AWS::Lambda::Function", {
    Timeout: 28,
    Environment: {
      Variables: Match.objectLike({
        AI_GAME_GENERATION_ENABLED: "true",
        BEDROCK_GENERATOR_MODEL_ID: "global.anthropic.claude-sonnet-4-6",
        BEDROCK_VALIDATOR_MODEL_ID: "global.anthropic.claude-sonnet-4-6",
        BEDROCK_REGION: "us-east-1",
        BEDROCK_GUARDRAIL_ID: Match.anyValue(),
        BEDROCK_GUARDRAIL_VERSION: Match.anyValue(),
      })
    },
  });
  template.hasResourceProperties("AWS::Bedrock::Guardrail", {
    BlockedInputMessaging: "This request cannot be processed.",
    BlockedOutputsMessaging: "This generated content cannot be provided.",

    ContentPolicyConfig: {
      FiltersConfig: [
        "SEXUAL",
        "VIOLENCE",
        "HATE",
        "INSULTS",
        "MISCONDUCT",
      ].map((type) =>
        Match.objectLike({
          Type: type,
          InputStrength: "HIGH",
          OutputStrength: "HIGH",
          InputEnabled: true,
          OutputEnabled: true,
        }),
      ).concat([
        Match.objectLike({
          Type: "PROMPT_ATTACK",
          InputStrength: "HIGH",
          OutputStrength: "NONE",
          InputEnabled: true,
          OutputEnabled: false,
        }),
      ]),
    },

    SensitiveInformationPolicyConfig: {
      PiiEntitiesConfig: Match.arrayWith([
        Match.objectLike({ Type: "EMAIL", Action: "BLOCK" }),
        Match.objectLike({ Type: "PHONE", Action: "BLOCK" }),
        // ADDRESS is detect-only (no action): educational topics legitimately name
        // countries, cities, and stadiums, so blocking on it produced false positives.
        Match.objectLike({ Type: "ADDRESS", Action: "NONE" }),
      ])
    },
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
  // v0.7.1 (ADR-015): the reproducible default is Claude Sonnet 4.6 for both roles.
  assert.match(synthesized, /inference-profile\/global\.anthropic\.claude-sonnet-4-6/);
  assert.match(synthesized, /foundation-model\/anthropic\.claude-sonnet-4-6/);
  assert.doesNotMatch(synthesized, /amazon\.nova-/);
  assert.match(synthesized, /bedrock:ApplyGuardrail/);
  assert.match(synthesized, /dynamodb:PutItem/);
  assert.doesNotMatch(synthesized, /"Action":"bedrock:\*"/);
  // v0.8: the only wildcard resource allowed is polly:SynthesizeSpeech, which
  // supports resource-level scoping for lexicons only (none are used).
  assert.doesNotMatch(synthesized.replace('{"Action":"polly:SynthesizeSpeech","Effect":"Allow","Resource":"*"}', ""), /"Resource":"\*"/);
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
  assert.match(JSON.stringify(defaultTemplate.toJSON()), /:bedrock:us-east-1:",\{"Ref":"AWS::AccountId"\},":inference-profile\//);

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
  assert.match(JSON.stringify(customTemplate.toJSON()), /:bedrock:eu-west-1:",\{"Ref":"AWS::AccountId"\},":inference-profile\//);
});

test("model IDs remain external configuration: in-region foundation models can still be selected by context", () => {
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(
    new App({
      context: {
        aiGameGenerationEnabled: true,
        bedrockGeneratorModelId: "amazon.nova-lite-v1:0",
        bedrockValidatorModelId: "amazon.nova-pro-v1:0",
      },
    }),
    "FoundationModelOverrideStack",
  ));
  template.hasResourceProperties("AWS::Lambda::Function", {
    Environment: {
      Variables: Match.objectLike({
        BEDROCK_GENERATOR_MODEL_ID: "amazon.nova-lite-v1:0",
        BEDROCK_VALIDATOR_MODEL_ID: "amazon.nova-pro-v1:0",
      }),
    },
  });
  const statement = Object.values(template.findResources("AWS::IAM::Policy"))
    .flatMap((resource) => resource.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>)
    .find((candidate) => candidate.Action === "bedrock:InvokeModel");
  assert.ok(statement);
  const resources = JSON.stringify(statement.Resource);
  assert.match(resources, /:bedrock:us-east-1::foundation-model\/amazon\.nova-lite-v1:0/);
  assert.match(resources, /:bedrock:us-east-1::foundation-model\/amazon\.nova-pro-v1:0/);
  assert.doesNotMatch(resources, /inference-profile|claude/);
  assert.equal((statement.Resource as unknown[]).length, 2);
});

test("grants inference-profile and routed foundation-model ARNs for cross-region model IDs", () => {
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(
    new App({
      context: {
        aiGameGenerationEnabled: true,
        bedrockGeneratorModelId: "global.anthropic.claude-sonnet-4-6",
        bedrockValidatorModelId: "global.anthropic.claude-sonnet-4-6",
      },
    }),
    "InferenceProfileStack",
  ));
  template.hasResourceProperties("AWS::Lambda::Function", {
    Environment: {
      Variables: Match.objectLike({
        BEDROCK_GENERATOR_MODEL_ID: "global.anthropic.claude-sonnet-4-6",
        BEDROCK_VALIDATOR_MODEL_ID: "global.anthropic.claude-sonnet-4-6",
      }),
    },
  });
  const statement = Object.values(template.findResources("AWS::IAM::Policy"))
    .flatMap((resource) => resource.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>)
    .find((candidate) => candidate.Action === "bedrock:InvokeModel");
  assert.ok(statement);
  const resources = JSON.stringify(statement.Resource);
  assert.match(resources, /:bedrock:us-east-1:",\{"Ref":"AWS::AccountId"\},":inference-profile\/global\.anthropic\.claude-sonnet-4-6/);
  assert.match(resources, /:bedrock:\*::foundation-model\/anthropic\.claude-sonnet-4-6/);
  assert.match(resources, /:bedrock:::foundation-model\/anthropic\.claude-sonnet-4-6/);
  assert.doesNotMatch(resources, /foundation-model\/global\./);
  assert.equal((statement.Resource as unknown[]).length, 3);
});

test("accepts configurable route throttling and rejects unsafe context values", () => {
  const app = new App({
    context: {
      generationThrottleRateLimit: "3.5",
      generationThrottleBurstLimit: "4",
      aiGameGenerationEnabled: "false",
    }
  });
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
  const app = new App({
    context: {
      generationThrottleRateLimit: "9",
      generationThrottleBurstLimit: "9",
    }
  });
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
  template.hasResourceProperties("AWS::DynamoDB::Table", { TableName: "test-family-learning-games-players" });
});

test("defaults CORS to localhost when no origin context is supplied", () => {
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(new App(), "DefaultOriginStack"));
  template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
    CorsConfiguration: Match.objectLike({ AllowOrigins: ["http://localhost:3000"] }),
  });
});

test("accepts a comma-separated allowedOrigins context alongside localhost", () => {
  const app = new App({
    context: {
      allowedOrigins: "http://localhost:3000, https://main.d123456789.amplifyapp.com",
    }
  });
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

test("v0.8 adds exactly one private, encrypted, TLS-only media bucket with audio-only lifecycle", () => {
  const app = new App({ context: { allowedOrigins: "http://localhost:3000,https://play.example.com" } });
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(app, "MediaStack"));

  template.resourceCountIs("AWS::S3::Bucket", 1);
  assertSingleApplicationLambda(template);
  template.resourceCountIs("AWS::ApiGatewayV2::Api", 2);
  template.resourceCountIs("AWS::DynamoDB::Table", 4);
  for (const forbidden of ["AWS::CloudFront::Distribution", "AWS::SQS::Queue", "AWS::SNS::Topic", "AWS::StepFunctions::StateMachine", "AWS::Events::Rule", "AWS::Cognito::UserPool"]) {
    template.resourceCountIs(forbidden, 0);
  }
  template.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
    OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
    },
    WebsiteConfiguration: Match.absent(),
    LifecycleConfiguration: {
      Rules: [Match.objectLike({ Prefix: "audio-cache/", ExpirationInDays: 30, Status: "Enabled" })],
    },
    CorsConfiguration: {
      CorsRules: [Match.objectLike({
        AllowedMethods: ["GET", "HEAD"],
        AllowedOrigins: ["http://localhost:3000", "https://play.example.com"],
      })],
    },
  });
  // Default `environment=dev`: destroyed with the stack, objects emptied first.
  template.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Delete", UpdateReplacePolicy: "Delete" });
  template.resourceCountIs("Custom::S3AutoDeleteObjects", 1);
  const bucket = Object.values(template.findResources("AWS::S3::Bucket"))[0];
  const lifecycleRules = bucket.Properties.LifecycleConfiguration.Rules as Array<{ Prefix?: string }>;
  assert.deepEqual(lifecycleRules.map((rule) => rule.Prefix), ["audio-cache/"]);
  const serialized = JSON.stringify(template.toJSON());
  assert.equal(serialized.includes("PublicRead"), false);

  // TLS-only bucket policy, and no statement opening the bucket to anonymous principals.
  template.hasResourceProperties("AWS::S3::BucketPolicy", {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({ Effect: "Deny", Action: "s3:*", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
      ]),
    },
  });
  // The only Allow in the bucket policy is CDK's auto-delete role (dev only); never a public/anonymous principal.
  const bucketPolicyStatements = Object.values(template.findResources("AWS::S3::BucketPolicy"))
    .flatMap((resource) => resource.Properties.PolicyDocument.Statement as Array<{ Effect: string; Principal?: unknown }>);
  const allows = bucketPolicyStatements.filter((statement) => statement.Effect === "Allow");
  assert.equal(allows.length, 1);
  assert.match(JSON.stringify(allows[0].Principal), /CustomS3AutoDeleteObjectsCustomResourceProviderRole/);
  assert.equal(JSON.stringify(allows[0].Principal).includes('"*"'), false);

  template.hasResourceProperties("AWS::Lambda::Function", {
    Environment: {
      Variables: Match.objectLike({
        MEDIA_BUCKET_NAME: Match.anyValue(),
        POLLY_VOICE_ID: "Lupe",
        POLLY_ENGINE: "neural",
        POLLY_LANGUAGE_CODE: "es-US",
        POLLY_OUTPUT_FORMAT: "mp3",
        AUDIO_URL_TTL_SECONDS: "900",
        IMAGE_URL_TTL_SECONDS: "900",
        AUDIO_CACHE_VERSION: "v1",
      }),
    },
  });
});

test("v0.8 media IAM is least privilege: scoped S3 prefixes and only polly:SynthesizeSpeech", () => {
  const app = new App();
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(app, "MediaIamStack"));
  const bucketLogicalId = Object.keys(template.findResources("AWS::S3::Bucket"))[0];
  const statements = Object.values(template.findResources("AWS::IAM::Policy"))
    .flatMap((resource) => resource.Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>);
  const actionsOf = (statement: { Action: string | string[] }) => [statement.Action].flat();
  const allActions = statements.flatMap(actionsOf);

  for (const wildcard of ["s3:*", "polly:*", "*"]) assert.equal(allActions.includes(wildcard), false, wildcard);
  assert.equal(allActions.filter((action) => action.startsWith("polly:")).join(","), "polly:SynthesizeSpeech");
  assert.equal(allActions.includes("s3:DeleteObject"), false);
  assert.equal(allActions.includes("s3:PutObjectAcl"), false);

  const s3Statements = statements.filter((statement) => actionsOf(statement).some((action) => action.startsWith("s3:")));
  for (const statement of s3Statements) {
    const resource = JSON.stringify(statement.Resource);
    assert.equal(resource.includes(bucketLogicalId), true, "S3 access is scoped to the media bucket");
    assert.equal(resource === JSON.stringify("*"), false);
  }
  const put = s3Statements.find((statement) => actionsOf(statement).includes("s3:PutObject"));
  assert.ok(put);
  assert.equal(JSON.stringify(put!.Resource).includes("/audio-cache/*"), true);
  assert.equal(JSON.stringify(put!.Resource).includes("/images/*"), false, "curated images are read-only for the Lambda");
  const get = s3Statements.find((statement) => actionsOf(statement).includes("s3:GetObject"));
  assert.ok(get);
  assert.equal(JSON.stringify(get!.Resource).includes("/audio-cache/*"), true);
  assert.equal(JSON.stringify(get!.Resource).includes("/images/*"), true);
});

test("v0.8 uses one fixed Polly profile (Lupe/neural/es-US/mp3) while cache version and expiration stay configurable", () => {
  // Former per-deploy voice/language context keys are not read: the profile cannot be changed to es-MX/es-ES.
  const app = new App({ context: { pollyVoiceId: "Mia", pollyEngine: "standard", pollyLanguageCode: "es-MX", audioCacheVersion: "v2", audioCacheExpirationDays: "7" } });
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(app, "MediaConfigStack"));
  template.hasResourceProperties("AWS::Lambda::Function", {
    Environment: { Variables: Match.objectLike({ POLLY_VOICE_ID: "Lupe", POLLY_ENGINE: "neural", POLLY_LANGUAGE_CODE: "es-US", POLLY_OUTPUT_FORMAT: "mp3", AUDIO_CACHE_VERSION: "v2" }) },
  });
  template.hasResourceProperties("AWS::S3::Bucket", {
    LifecycleConfiguration: { Rules: [Match.objectLike({ Prefix: "audio-cache/", ExpirationInDays: 7 })] },
  });
});

test("v0.8 media bucket removal: dev (default) is destroyed and emptied; prod is retained without the cleanup handler", () => {
  const dev = Template.fromStack(new FamilyLearningGamesBackendStack(new App(), "DevMediaStack"));
  dev.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Delete", UpdateReplacePolicy: "Delete" });
  dev.resourceCountIs("Custom::S3AutoDeleteObjects", 1);
  assertSingleApplicationLambda(dev, true);

  for (const environment of ["prod", "production"]) {
    const prod = Template.fromStack(new FamilyLearningGamesBackendStack(new App({ context: { environment } }), `ProdMediaStack${environment}`));
    prod.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
    prod.resourceCountIs("Custom::S3AutoDeleteObjects", 0);
    assertSingleApplicationLambda(prod, false);
    const statements = Object.values(prod.findResources("AWS::S3::BucketPolicy"))
      .flatMap((resource) => resource.Properties.PolicyDocument.Statement as Array<{ Effect: string }>);
    assert.equal(statements.some((statement) => statement.Effect === "Allow"), false);
  }
});

test("v0.8 IAM wildcards: Resource \"*\" appears only on the single polly:SynthesizeSpeech statement", () => {
  for (const context of [{}, { aiGameGenerationEnabled: "true" }]) {
    const template = Template.fromStack(new FamilyLearningGamesBackendStack(new App({ context }), "WildcardStack"));
    const backendPolicies = Object.entries(template.findResources("AWS::IAM::Policy"))
      .filter(([logicalId]) => logicalId.startsWith("BackendFunctionServiceRole"));
    const statements = backendPolicies.flatMap(([, resource]) => resource.Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown; Effect: string }>);
    const wildcard = statements.filter((statement) => JSON.stringify(statement.Resource) === JSON.stringify("*"));
    assert.deepEqual(wildcard, [{ Action: "polly:SynthesizeSpeech", Effect: "Allow", Resource: "*" }]);
    const actions = statements.flatMap((statement) => [statement.Action].flat());
    for (const forbidden of ["polly:*", "s3:*", "*", "dynamodb:*", "bedrock:*"]) assert.equal(actions.includes(forbidden), false, forbidden);
    assert.deepEqual(actions.filter((action) => action.startsWith("polly:")), ["polly:SynthesizeSpeech"]);
  }
});

test("v0.9 adds one WebSocket API whose routes all integrate the same backend Lambda", () => {
  const app = new App({ context: { allowedOrigins: "http://localhost:3000,https://play.example.com" } });
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(app, "MultiplayerStack"));
  assertSingleApplicationLambda(template);
  const apis = Object.entries(template.findResources("AWS::ApiGatewayV2::Api"));
  const webSocketApis = apis.filter(([, resource]) => resource.Properties.ProtocolType === "WEBSOCKET");
  assert.equal(webSocketApis.length, 1);
  assert.equal(apis.filter(([, resource]) => resource.Properties.ProtocolType === "HTTP").length, 1);
  const [webSocketApiId, webSocketApi] = webSocketApis[0];
  assert.equal(webSocketApi.Properties.RouteSelectionExpression, "$request.body.action");

  const webSocketRoutes = Object.values(template.findResources("AWS::ApiGatewayV2::Route"))
    .filter((route) => JSON.stringify(route.Properties.ApiId) === JSON.stringify({ Ref: webSocketApiId }));
  assert.deepEqual(
    webSocketRoutes.map((route) => route.Properties.RouteKey).sort(),
    ["$connect", "$default", "$disconnect", "IDENTIFY", "NEXT_QUESTION", "QUESTION_TIMEOUT", "START_GAME", "SUBMIT_ANSWER", "SYNC_ROOM"].sort(),
  );
  // Every integration (HTTP and WebSocket) proxies to the single backend function.
  const backendLogicalId = Object.entries(template.findResources("AWS::Lambda::Function"))
    .find(([, resource]) => resource.Properties.FunctionName === "family-learning-games-backend")![0];
  const integrations = Object.values(template.findResources("AWS::ApiGatewayV2::Integration"));
  // One HTTP integration plus one WebSocket integration per route (all on the same Lambda).
  assert.equal(integrations.length, 1 + webSocketRoutes.length);
  for (const integration of integrations) {
    assert.equal(integration.Properties.IntegrationType, "AWS_PROXY");
    assert.match(JSON.stringify(integration.Properties.IntegrationUri), new RegExp(backendLogicalId));
  }
  template.hasResourceProperties("AWS::ApiGatewayV2::Stage", { ApiId: { Ref: webSocketApiId }, StageName: "production", AutoDeploy: true });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /multiplayer/rooms" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /multiplayer/rooms/{roomCode}/join" });
  for (const forbidden of ["AWS::AppSync::GraphQLApi", "AWS::Cognito::UserPool", "AWS::ElastiCache::CacheCluster", "AWS::StepFunctions::StateMachine", "AWS::Scheduler::Schedule", "AWS::Events::Rule", "AWS::ECS::Cluster"]) {
    template.resourceCountIs(forbidden, 0);
  }

  // Frontend configuration (public WSS URL) and backend wiring.
  const outputs = template.toJSON().Outputs as Record<string, { Value: unknown }>;
  assert.ok(outputs.MultiplayerWebSocketUrl);
  assert.match(JSON.stringify(outputs.MultiplayerWebSocketUrl.Value), /wss:\/\//);
  assert.ok(outputs.MultiplayerTableName);
  template.hasResourceProperties("AWS::Lambda::Function", {
    Environment: {
      Variables: Match.objectLike({
        MULTIPLAYER_TABLE_NAME: Match.anyValue(),
        MULTIPLAYER_MAX_PLAYERS: "8",
        MULTIPLAYER_ROOM_TTL_MINUTES: "120",
        MULTIPLAYER_ALLOWED_ORIGINS: "http://localhost:3000,https://play.example.com",
        WEBSOCKET_CALLBACK_ENDPOINT: Match.anyValue(),
      }),
    },
  });
});

test("v0.9 API Gateway may invoke the backend Lambda from every WebSocket route", () => {
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(new App(), "MultiplayerPermissionStack"));
  const [webSocketApiId] = Object.entries(template.findResources("AWS::ApiGatewayV2::Api"))
    .find(([, resource]) => resource.Properties.ProtocolType === "WEBSOCKET")!;
  const backendLogicalId = Object.entries(template.findResources("AWS::Lambda::Function"))
    .find(([, resource]) => resource.Properties.FunctionName === "family-learning-games-backend")![0];

  // A WebSocket invoke permission's SourceArn is Fn::Join([..., { Ref: <ws api> }, "/<suffix>"]).
  const webSocketPermissionSuffixes = Object.values(template.findResources("AWS::Lambda::Permission"))
    .filter((permission) => permission.Properties.Action === "lambda:InvokeFunction"
      && permission.Properties.Principal === "apigateway.amazonaws.com"
      && JSON.stringify(permission.Properties.FunctionName).includes(backendLogicalId))
    .map((permission) => permission.Properties.SourceArn?.["Fn::Join"]?.[1] as unknown[] | undefined)
    .filter((parts): parts is unknown[] => Array.isArray(parts)
      && parts.some((part) => JSON.stringify(part) === JSON.stringify({ Ref: webSocketApiId })))
    .map((parts) => String(parts[parts.length - 1]));

  const routeKeys = ["$connect", "$disconnect", "$default", "IDENTIFY", "START_GAME", "SUBMIT_ANSWER", "QUESTION_TIMEOUT", "NEXT_QUESTION", "SYNC_ROOM"];
  for (const routeKey of routeKeys) {
    assert.ok(
      webSocketPermissionSuffixes.includes(`/*${routeKey}`),
      `missing lambda:InvokeFunction permission for WebSocket route ${routeKey} (found: ${webSocketPermissionSuffixes.join(", ")})`,
    );
  }
  // Permissions stay scoped per route: no blanket grant on the whole WebSocket API.
  assert.deepEqual(webSocketPermissionSuffixes.sort(), routeKeys.map((routeKey) => `/*${routeKey}`).sort());
});

test("v0.9 adds exactly one multiplayer table with PK/SK and TTL, preserving the existing tables", () => {
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(new App({ context: { multiplayerMaxPlayers: "6" } }), "MultiplayerTableStack"));
  template.resourceCountIs("AWS::DynamoDB::Table", 4);
  for (const name of ["games", "game-sessions", "players"]) {
    template.hasResourceProperties("AWS::DynamoDB::Table", { TableName: `dev-family-learning-games-${name}` });
  }
  template.hasResourceProperties("AWS::DynamoDB::Table", {
    TableName: "dev-family-learning-games-multiplayer",
    BillingMode: "PAY_PER_REQUEST",
    KeySchema: [{ AttributeName: "PK", KeyType: "HASH" }, { AttributeName: "SK", KeyType: "RANGE" }],
    TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    // Room codes resolve through a strongly consistent reservation item, not an index.
    GlobalSecondaryIndexes: Match.absent(),
  });
  // Capacity is configuration, bounded to the supported 2..8 range.
  template.hasResourceProperties("AWS::Lambda::Function", { Environment: { Variables: Match.objectLike({ MULTIPLAYER_MAX_PLAYERS: "6" }) } });
  for (const multiplayerMaxPlayers of ["1", "9", "abc"]) {
    assert.throws(() => new FamilyLearningGamesBackendStack(new App({ context: { multiplayerMaxPlayers } }), `InvalidCapacity${multiplayerMaxPlayers}`), /multiplayerMaxPlayers/);
  }
});

test("v0.9 multiplayer IAM is scoped to the multiplayer table and the WebSocket stage's @connections", () => {
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(new App(), "MultiplayerIamStack"));
  const tableLogicalId = Object.entries(template.findResources("AWS::DynamoDB::Table"))
    .find(([, resource]) => resource.Properties.TableName === "dev-family-learning-games-multiplayer")![0];
  const webSocketApiId = Object.entries(template.findResources("AWS::ApiGatewayV2::Api"))
    .find(([, resource]) => resource.Properties.ProtocolType === "WEBSOCKET")![0];
  const statements = Object.values(template.findResources("AWS::IAM::Policy"))
    .flatMap((resource) => resource.Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>);

  const tableStatements = statements.filter((statement) => JSON.stringify(statement.Resource).includes(tableLogicalId));
  assert.equal(tableStatements.length, 1);
  assert.deepEqual([tableStatements[0].Action].flat(), ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"]);
  assert.equal(JSON.stringify(tableStatements[0].Resource).includes("/index/"), false);
  assert.equal(JSON.stringify(tableStatements[0].Resource), JSON.stringify({ "Fn::GetAtt": [tableLogicalId, "Arn"] }));

  const manage = statements.filter((statement) => [statement.Action].flat().some((action) => action.startsWith("execute-api:")));
  assert.equal(manage.length, 1);
  assert.deepEqual([manage[0].Action].flat(), ["execute-api:ManageConnections"]);
  const resource = JSON.stringify(manage[0].Resource);
  assert.match(resource, new RegExp(webSocketApiId));
  assert.match(resource, /\/production\/POST\/@connections\/\*/);
  assert.equal(resource === JSON.stringify("*"), false);
});
