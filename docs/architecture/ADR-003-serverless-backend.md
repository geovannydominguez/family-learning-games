# ADR-003 — Use AWS Serverless Backend

## Status

Accepted for v0.2.

---

## Context

Family Learning Games v0.1 runs locally and provides a complete playable quiz experience.

The roadmap now enters Phase 2: introduce the first backend using AWS.

The project currently has low expected traffic, irregular usage, no need for permanently running compute, a TypeScript codebase and no requirement for containers or Kubernetes.

Candidate compute options include AWS Lambda, ECS, EKS, EC2 and App Runner.

---

## Decision

Use **AWS Lambda** as the backend compute runtime for v0.2.

```text
Client
  |
  v
API Gateway
  |
  v
AWS Lambda
  |
  v
Application
  |
  v
Domain
```

---

## Rationale

AWS Lambda is preferred because it requires no always-running server, aligns cost with low initial usage, scales automatically, has low operational overhead and integrates directly with API Gateway.

The project does not currently need container orchestration or dedicated compute.

---

## Consequences

### Positive

* low infrastructure overhead
* pay-per-use model
* automatic scaling
* simple API Gateway integration
* small operational surface

### Negative

* execution is ephemeral
* in-memory state is not durable
* cold starts may exist
* runtime limits must be respected

---

## Important constraint

Lambda execution memory must not be treated as persistent application storage.

Durable persistence belongs to Phase 3 / v0.3.

---

## Rejected alternatives

### Amazon EKS

Rejected because Kubernetes would introduce substantial complexity without a current requirement.

### Amazon ECS

Rejected because container-based services provide little benefit for the current small request/response workload.

### Amazon EC2

Rejected because instance management and always-on compute are unnecessary.

### AWS App Runner

Rejected because the backend does not require a continuously running web service and Lambda is simpler for the current workload.

---

## Revisit when

Reconsider if long-running workloads appear, sustained traffic materially changes the cost model, persistent connections are required, container-specific dependencies become necessary or Lambda limits become a real constraint.

Any change should be documented in a new ADR.
