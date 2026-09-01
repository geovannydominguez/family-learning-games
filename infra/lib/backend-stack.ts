import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { HttpMethod, CorsHttpMethod, HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export class FamilyLearningGamesBackendStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const frontendOrigin = this.node.tryGetContext("frontendOrigin") ?? "http://localhost:3000";
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
      bundling: {
        target: "node22",
        format: OutputFormat.ESM,
        mainFields: ["module", "main"],
        sourceMap: true,
      },
    });
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
    api.addRoutes({ path: "/game-sessions", methods: [HttpMethod.POST], integration });
    api.addRoutes({ path: "/game-sessions/{sessionId}/answers", methods: [HttpMethod.POST], integration });

    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "FunctionName", { value: backend.functionName });
  }
}
