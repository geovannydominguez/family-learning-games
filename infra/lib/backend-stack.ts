import { createHash } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { CfnRoute, CfnStage, HttpMethod, CorsHttpMethod, HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { CfnGuardrail, CfnGuardrailVersion } from "aws-cdk-lib/aws-bedrock";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export interface FamilyLearningGamesBackendStackProps extends StackProps {
  aiGameGenerationEnabled?: boolean;
  bedrockModelId?: string;
  generationThrottleRateLimit?: number;
  generationThrottleBurstLimit?: number;
  allowedOrigins?: string[];
}

export class FamilyLearningGamesBackendStack extends Stack {
  constructor(scope: Construct, id: string, props?: FamilyLearningGamesBackendStackProps) {
    super(scope, id, {
      ...props,
      env: {
        ...props?.env,
        region: props?.env?.region ?? "us-east-1",
      },
    });

    const allowedOrigins = readAllowedOrigins(this.node, props?.allowedOrigins);
    const environment = this.node.tryGetContext("environment") ?? "dev";
    const aiGameGenerationEnabled = props?.aiGameGenerationEnabled
      ?? readBooleanContext(this.node.tryGetContext("aiGameGenerationEnabled"), "aiGameGenerationEnabled", false);
    const bedrockModelId = props?.bedrockModelId
      ?? readStringContext(this.node.tryGetContext("bedrockModelId"), "amazon.nova-micro-v1:0");
    const generationThrottleRateLimit = readPositiveNumber(
      props?.generationThrottleRateLimit ?? this.node.tryGetContext("generationThrottleRateLimit") ?? 1,
      "generationThrottleRateLimit",
    );
    const generationThrottleBurstLimit = readPositiveNumber(
      props?.generationThrottleBurstLimit ?? this.node.tryGetContext("generationThrottleBurstLimit") ?? 2,
      "generationThrottleBurstLimit",
      true,
    );
    const resourcePrefix = `${environment}-family-learning-games`;
    const gamesTable = new Table(this, "GamesTable", {
      tableName: `${resourcePrefix}-games`,
      partitionKey: { name: "gameId", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const gameSessionsTable = new Table(this, "GameSessionsTable", {
      tableName: `${resourcePrefix}-game-sessions`,
      partitionKey: { name: "sessionId", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const logGroup = new LogGroup(this, "BackendLogs", {
      logGroupName: "/aws/lambda/family-learning-games-backend",
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const backendEnvironment: Record<string, string> = {
      GAMES_TABLE_NAME: gamesTable.tableName,
      GAME_SESSIONS_TABLE_NAME: gameSessionsTable.tableName,
      AI_GAME_GENERATION_ENABLED: String(aiGameGenerationEnabled),
    };
    let guardrail: CfnGuardrail | undefined;

    if (aiGameGenerationEnabled) {
      const policy = createGuardrailPolicy();
      const policyFingerprint = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
      guardrail = new CfnGuardrail(this, "GameGenerationGuardrail", {
        name: `${resourcePrefix}-game-generation`,
        description: "Family-safe controls for generated learning games.",
        blockedInputMessaging: policy.blockedInputMessaging,
        blockedOutputsMessaging: policy.blockedOutputsMessaging,
        contentPolicyConfig: policy.contentPolicyConfig,
        sensitiveInformationPolicyConfig: policy.sensitiveInformationPolicyConfig,
      });
      const guardrailVersion = new CfnGuardrailVersion(
        this,
        `GameGenerationGuardrailVersion${policyFingerprint.slice(0, 12)}`,
        {
          guardrailIdentifier: guardrail.attrGuardrailId,
          description: `policy-sha256:${policyFingerprint}`,
        },
      );
      backendEnvironment.BEDROCK_MODEL_ID = bedrockModelId;
      backendEnvironment.BEDROCK_REGION = this.region;
      backendEnvironment.BEDROCK_GUARDRAIL_ID = guardrail.attrGuardrailId;
      backendEnvironment.BEDROCK_GUARDRAIL_VERSION = guardrailVersion.attrVersion;
    }

    const backend = new NodejsFunction(this, "BackendFunction", {
      functionName: "family-learning-games-backend",
      entry: path.resolve(currentDirectory, "../../src/interfaces/http/lambda.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      timeout: Duration.seconds(aiGameGenerationEnabled ? 28 : 10),
      memorySize: 256,
      logGroup,
      environment: backendEnvironment,
      bundling: {
        target: "node22",
        format: OutputFormat.ESM,
        mainFields: ["module", "main"],
        sourceMap: true,
      },
    });
    backend.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:GetItem", "dynamodb:Scan"],
      resources: [gamesTable.tableArn],
    }));
    backend.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
      resources: [gameSessionsTable.tableArn],
    }));
    if (guardrail) {
      backend.addToRolePolicy(new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:PutItem"],
        resources: [gamesTable.tableArn],
      }));
      backend.addToRolePolicy(new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["bedrock:InvokeModel"],
        resources: [this.formatArn({
          service: "bedrock",
          region: this.region,
          account: "",
          resource: "foundation-model",
          resourceName: bedrockModelId,
        })],
      }));
      backend.addToRolePolicy(new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["bedrock:ApplyGuardrail"],
        resources: [guardrail.attrGuardrailArn],
      }));
    }
    const integration = new HttpLambdaIntegration("BackendIntegration", backend);
    const api = new HttpApi(this, "BackendApi", {
      apiName: "family-learning-games-api",
      corsPreflight: {
        allowOrigins: allowedOrigins,
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.OPTIONS],
        allowHeaders: ["content-type"],
      },
    });
    api.addRoutes({ path: "/game-setup", methods: [HttpMethod.GET], integration });
    api.addRoutes({ path: "/games", methods: [HttpMethod.GET], integration });
    api.addRoutes({ path: "/games/{gameId}", methods: [HttpMethod.GET], integration });
    const [generationRoute] = api.addRoutes({ path: "/games/generate", methods: [HttpMethod.POST], integration });
    api.addRoutes({ path: "/game-sessions", methods: [HttpMethod.POST], integration });
    api.addRoutes({ path: "/game-sessions/{sessionId}/answers", methods: [HttpMethod.POST], integration });
    api.addRoutes({ path: "/game-sessions/{sessionId}", methods: [HttpMethod.GET], integration });
    const defaultStage = api.defaultStage?.node.defaultChild;
    if (!(defaultStage instanceof CfnStage)) throw new Error("HTTP API default stage is unavailable.");
    const generationRouteResource = generationRoute.node.defaultChild;
    if (!(generationRouteResource instanceof CfnRoute)) throw new Error("Generation route is unavailable.");
    defaultStage.addResourceDependency(generationRouteResource);
    defaultStage.routeSettings = {
      "POST /games/generate": {
        ThrottlingRateLimit: generationThrottleRateLimit,
        ThrottlingBurstLimit: generationThrottleBurstLimit,
      },
    };

    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "FunctionName", { value: backend.functionName });
    new CfnOutput(this, "GamesTableName", { value: gamesTable.tableName });
    new CfnOutput(this, "GameSessionsTableName", { value: gameSessionsTable.tableName });
  }
}

function readBooleanContext(value: unknown, key: string, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new Error(`Invalid CDK context ${key}: expected true or false.`);
}

function readPositiveNumber(value: unknown, key: string, integer = false): number {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`Invalid CDK context ${key}: expected a positive${integer ? " integer" : " number"}.`);
  }
  return parsed;
}

function readStringContext(value: unknown, defaultValue: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : defaultValue;
}

const originPattern = /^https?:\/\/[^\s/]+$/;

function readAllowedOrigins(node: Construct["node"], propsOverride?: string[]): string[] {
  if (propsOverride !== undefined) return normalizeOrigins(propsOverride, "allowedOrigins");

  const allowedOriginsContext = node.tryGetContext("allowedOrigins");
  if (allowedOriginsContext !== undefined) {
    const raw = String(allowedOriginsContext).split(",").map((origin) => origin.trim()).filter(Boolean);
    return normalizeOrigins(raw, "allowedOrigins");
  }

  const frontendOriginContext = node.tryGetContext("frontendOrigin");
  const frontendOrigin = typeof frontendOriginContext === "string" && frontendOriginContext.trim()
    ? frontendOriginContext.trim()
    : "http://localhost:3000";
  return normalizeOrigins([frontendOrigin], "frontendOrigin");
}

function normalizeOrigins(origins: string[], key: string): string[] {
  if (origins.length === 0) throw new Error(`Invalid CDK context ${key}: expected at least one origin.`);
  for (const origin of origins) {
    if (!originPattern.test(origin)) {
      throw new Error(`Invalid CDK context ${key}: "${origin}" must be an http(s) origin without a trailing slash.`);
    }
  }
  return [...new Set(origins)];
}

function createGuardrailPolicy() {
  const filtersConfig = [
    "SEXUAL",
    "VIOLENCE",
    "HATE",
    "INSULTS",
    "MISCONDUCT",
    "PROMPT_ATTACK",
  ].map((type) => ({
    type,
    inputStrength: "HIGH",
    outputStrength: "HIGH",
    inputAction: "BLOCK",
    outputAction: "BLOCK",
    inputEnabled: true,
    outputEnabled: true,
  }));
  const piiEntitiesConfig = [
    "EMAIL",
    "PHONE",
    "ADDRESS",
    "USERNAME",
    "PASSWORD",
    "CREDIT_DEBIT_CARD_NUMBER",
  ].map((type) => ({
    type,
    action: "BLOCK",
    inputAction: "BLOCK",
    outputAction: "BLOCK",
    inputEnabled: true,
    outputEnabled: true,
  }));
  return {
    blockedInputMessaging: "This request cannot be processed.",
    blockedOutputsMessaging: "This generated content cannot be provided.",
    contentPolicyConfig: { filtersConfig },
    sensitiveInformationPolicyConfig: { piiEntitiesConfig },
  };
}
