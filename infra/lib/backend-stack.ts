import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { HttpMethod, CorsHttpMethod, HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export class FamilyLearningGamesBackendStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const frontendOrigin = this.node.tryGetContext("frontendOrigin") ?? "http://localhost:3000";
    const environment = this.node.tryGetContext("environment") ?? "dev";
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
    const backend = new NodejsFunction(this, "BackendFunction", {
      functionName: "family-learning-games-backend",
      entry: path.resolve(currentDirectory, "../../src/interfaces/http/lambda.ts"),
      handler: "handler",
      runtime: Runtime.NODEJS_22_X,
      timeout: Duration.seconds(10),
      memorySize: 256,
      logGroup,
      environment: {
        GAMES_TABLE_NAME: gamesTable.tableName,
        GAME_SESSIONS_TABLE_NAME: gameSessionsTable.tableName,
      },
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
    const integration = new HttpLambdaIntegration("BackendIntegration", backend);
    const api = new HttpApi(this, "BackendApi", {
      apiName: "family-learning-games-api",
      corsPreflight: {
        allowOrigins: [frontendOrigin],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.OPTIONS],
        allowHeaders: ["content-type"],
      },
    });
    api.addRoutes({ path: "/game-setup", methods: [HttpMethod.GET], integration });
    api.addRoutes({ path: "/games", methods: [HttpMethod.GET], integration });
    api.addRoutes({ path: "/games/{gameId}", methods: [HttpMethod.GET], integration });
    api.addRoutes({ path: "/game-sessions", methods: [HttpMethod.POST], integration });
    api.addRoutes({ path: "/game-sessions/{sessionId}/answers", methods: [HttpMethod.POST], integration });
    api.addRoutes({ path: "/game-sessions/{sessionId}", methods: [HttpMethod.GET], integration });

    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "FunctionName", { value: backend.functionName });
    new CfnOutput(this, "GamesTableName", { value: gamesTable.tableName });
    new CfnOutput(this, "GameSessionsTableName", { value: gameSessionsTable.tableName });
  }
}
