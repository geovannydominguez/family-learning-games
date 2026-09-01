import test from "node:test";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { FamilyLearningGamesBackendStack } from "./backend-stack.ts";

test("defines one Node 22 Lambda, one HTTP API, three routes, CORS and short-retention logs", () => {
  const app = new App({ context: { frontendOrigin: "https://family.example.com" } });
  const template = Template.fromStack(new FamilyLearningGamesBackendStack(app, "TestStack"));
  template.resourceCountIs("AWS::Lambda::Function", 1);
  template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
  template.resourceCountIs("AWS::ApiGatewayV2::Route", 3);
  template.resourceCountIs("AWS::Logs::LogGroup", 1);
  template.hasResourceProperties("AWS::Lambda::Function", { Runtime: "nodejs22.x" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Api", { CorsConfiguration: Match.objectLike({ AllowOrigins: ["https://family.example.com"] }) });
  template.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 7 });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "GET /game-setup" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /game-sessions" });
  template.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "POST /game-sessions/{sessionId}/answers" });
  for (const forbidden of ["AWS::DynamoDB::Table", "AWS::Cognito::UserPool", "AWS::SQS::Queue", "AWS::EC2::VPC"]) template.resourceCountIs(forbidden, 0);
});
