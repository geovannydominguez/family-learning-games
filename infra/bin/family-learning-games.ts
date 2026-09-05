#!/usr/bin/env node
import { App } from "aws-cdk-lib";

import { FamilyLearningGamesBackendStack } from "../lib/backend-stack.ts";

const app = new App();
const configuredRegion = app.node.tryGetContext("deploymentRegion");
const deploymentRegion = configuredRegion === undefined
  ? "us-east-1"
  : String(configuredRegion).trim();
if (!deploymentRegion) throw new Error("Invalid CDK context deploymentRegion: expected a non-empty AWS region.");

new FamilyLearningGamesBackendStack(app, "FamilyLearningGamesBackendStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: deploymentRegion,
  },
});
