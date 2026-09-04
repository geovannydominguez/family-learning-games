import test from "node:test";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { FamilyLearningGamesBackendStack } from "./backend-stack.ts";

test("defines the v0.3 Lambda, HTTP API, durable tables, least-privilege access and development lifecycle", () => {
  const app = new App({ context: { frontendOrigin: "https://family.example.com" } });
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(app, "TestStack"));
  template.resourceCountIs("AWS::Lambda::Function", 1);
  template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
  template.resourceCountIs("AWS::ApiGatewayV2::Route", 6);
  template.resourceCountIs("AWS::DynamoDB::Table", 2);
  template.resourceCountIs("AWS::Logs::LogGroup", 1);
  template.hasResourceProperties("AWS::Lambda::Function", { Runtime: "nodejs22.x" });
  template.hasResourceProperties("AWS::Lambda::Function", { Environment: { Variables: Match.objectLike({ GAMES_TABLE_NAME: Match.anyValue(), GAME_SESSIONS_TABLE_NAME: Match.anyValue() }) } });
  template.hasResourceProperties("AWS::ApiGatewayV2::Api", { CorsConfiguration: Match.objectLike({ AllowOrigins: ["https://family.example.com"] }) });
  template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 7 });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /game-setup" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /games" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /games/{gameId}" });
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
  for (const forbidden of ["AWS::Cognito::UserPool", "AWS::SQS::Queue", "AWS::EC2::VPC"]) template.resourceCountIs(forbidden, 0);
});

test("prefixes DynamoDB table names with the configured environment", () => {
  const app = new App({ context: { environment: "test" } });
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(app, "TestEnvironmentStack"));

  template.hasResourceProperties("AWS::DynamoDB::Table", { TableName: "test-family-learning-games-games" });
  template.hasResourceProperties("AWS::DynamoDB::Table", { TableName: "test-family-learning-games-game-sessions" });
});
