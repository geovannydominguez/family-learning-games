#!/usr/bin/env node
import { App } from "aws-cdk-lib";

import { FamilyLearningGamesBackendStack } from "../lib/backend-stack.ts";

const app = new App();
new FamilyLearningGamesBackendStack(app, "FamilyLearningGamesBackendStack");
