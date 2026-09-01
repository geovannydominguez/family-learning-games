# ADR-005 — Use AWS CDK with TypeScript for Infrastructure as Code

## Status

Accepted for v0.2.

---

## Context

v0.2 introduces AWS infrastructure including API Gateway HTTP API, Lambda, IAM permissions and CloudWatch logging.

The project needs Infrastructure as Code so infrastructure is reproducible, reviewable, version-controlled and not dependent on manual console steps.

Candidate approaches include AWS CDK, CloudFormation, SAM, Terraform and manual AWS Console configuration.

The application codebase already uses TypeScript.

---

## Decision

Use **AWS CDK with TypeScript** as the Infrastructure as Code tool for Family Learning Games v0.2.

Conceptual structure:

```text
infra/
  bin/
    family-learning-games.ts
  lib/
    backend-stack.ts
```

The exact directory names may follow existing repository conventions.

---

## Rationale

AWS CDK with TypeScript is preferred because the project already uses TypeScript, infrastructure can use the same language/tooling, constructs reduce low-level CloudFormation verbosity and `cdk synth` provides CloudFormation output for validation.

---

## Consequences

### Positive

* one primary language across application and infrastructure
* strongly typed infrastructure definitions
* simple npm integration
* reproducible deployments
* generated CloudFormation available through synthesis

### Negative

* introduces CDK dependencies
* developers need basic CDK knowledge
* abstraction can hide CloudFormation details if used carelessly
* CDK version management becomes part of maintenance

---

## Infrastructure scope rule

CDK must not become a reason to overbuild infrastructure.

For v0.2, expected resources are intentionally limited:

```text
FamilyLearningGamesBackendStack
        |
        +-- API Gateway HTTP API
        +-- Lambda
        +-- IAM
        +-- CloudWatch logging
```

Do not add resources for future phases unless approved.

---

## Manual console usage

The AWS Console may be used for inspection and troubleshooting.

It must not become the source of truth for project infrastructure.

Persistent infrastructure configuration should be represented in CDK.

---

## Rejected alternatives

### Manual AWS Console

Rejected because it is difficult to reproduce, review and version.

### Raw CloudFormation

Not selected because CDK provides a more productive TypeScript authoring model for this project.

### Terraform

Not selected because the project is currently AWS-only and CDK allows reuse of the existing TypeScript skill set.

### AWS SAM

Not selected because CDK provides a broader infrastructure model that can evolve with later project phases while remaining suitable for the current serverless backend.

---

## Validation

Infrastructure changes should at minimum pass:

```bash
npx cdk synth
```

Where appropriate, tests should also validate important stack properties.

---

## Revisit when

Reconsider if the project becomes multi-cloud, organizational tooling mandates another IaC standard, CDK introduces material constraints or infrastructure ownership moves to a platform model requiring another tool.

Any change should be captured in a new ADR.
