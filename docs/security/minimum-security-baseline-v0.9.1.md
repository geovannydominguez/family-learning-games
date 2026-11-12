# Family Learning Games — Minimum Security Baseline v0.9.1

**Project:** Family JOAM Games  
**Application:** Family Learning Games  
**Version:** v0.9.1  
**Release name:** Access Control & Cost Monitoring  
**Date:** 2026-11-11  
**Environment:** Production  
**AWS Region:** us-east-1  
**Status:** IMPLEMENTED — VALIDATED (release pending)

---

## 1. Objective

Establish a minimum security baseline for Family Learning Games, focusing on reducing unauthorized public access and improving visibility into unexpected AWS costs.

The primary objectives are:

- Restrict public access to the application frontend.
- Establish AWS cost monitoring and alerting.
- Identify publicly exposed backend APIs.
- Document existing security limitations.
- Define the baseline for subsequent infrastructure protection.

This release prioritizes simplicity, low operating costs, and compatibility with the existing multiplayer functionality.

**Important:** This release does not guarantee a maximum AWS expenditure or prevent direct access to backend APIs.

## 2. Scope

### Included

- AWS Amplify access control.
- AWS Budgets monitoring.
- AWS Cost Anomaly Detection.
- HTTP API Gateway security assessment.
- WebSocket API Gateway security assessment.
- Documentation of risks and future controls.

### Excluded

- Amazon Cognito.
- JWT authentication.
- API Gateway Lambda Authorizers.
- AWS WAF.
- API Gateway throttling changes.
- AWS Lambda reserved concurrency changes.
- DynamoDB maximum throughput configuration.
- Application-level usage quotas for Amazon Bedrock and Amazon Polly.

These controls will be evaluated or implemented in subsequent releases.

## 3. Existing Architecture

The application uses the following AWS components:

| Component | Service | Purpose |
|---|---|---|
| Frontend | AWS Amplify | Application hosting |
| Backend API | API Gateway HTTP API | HTTP endpoints |
| Multiplayer API | API Gateway WebSocket API | Real-time multiplayer |
| Compute | AWS Lambda | Backend execution |
| Persistence | Amazon DynamoDB | Application data |
| Generative AI | Amazon Bedrock | AI-powered functionality |
| Speech | Amazon Polly | Speech functionality |
| Monitoring | AWS Budgets / Cost Anomaly Detection | Financial monitoring |

### Exposure model

```text
Internet
   |
   v
play.joamgames.com
   |
   v
AWS Amplify
   |
   +-- Username/password protection
   |
   v
Family Learning Games
   |
   +---------------------+
   |                     |
   v                     v
API Gateway HTTP     API Gateway WebSocket
   |                     |
   +----------+----------+
              |
              v
          AWS Lambda
              |
       +------+------+
       |      |      |
       v      v      v
    DynamoDB Bedrock Polly
```

**Security limitation:** Amplify access control protects the hosted frontend. It does not authenticate requests sent directly to API Gateway.

## 4. AWS Cost Monitoring

### 4.1 AWS Budgets

An existing AWS account-level budget was reviewed and retained.

| Property | Configuration |
|---|---|
| Budget name | `Total-Account-Cost-Alert` |
| Budget type | Cost budget |
| Period | Monthly |
| Budget amount | USD 5.00 |
| Start date | 2026-11-01 |
| Status | Healthy at verification |
| Email recipients | 2 |
| Email status | Active (legacy) |
| Configured alerts | 3 |

#### Verification

The budget was successfully reviewed in AWS Billing and Cost Management.

Both registered email recipients displayed the status `Active (legacy)`, indicating that they remain valid under the legacy verification mechanism.

Previously received AWS Budgets notifications were also confirmed.

The budget amount was retained at USD 5.00 based on the application's current operating scale.

**Limitation:** AWS Budgets provides financial visibility and alerts. It does not automatically stop services when the budget threshold is reached.

### 4.2 AWS Cost Anomaly Detection

The following monitor and subscription were configured:

| Property | Configuration |
|---|---|
| Monitor | `family-joam-games-cost-monitor` |
| Monitor type | AWS services |
| Managed by | AWS |
| Services monitored | All services |
| Subscription | `family-joam-games-cost-alerts` |
| Alert threshold | USD 5.00 |
| Frequency | Daily summaries |
| Recipients | 2 |
| Configuration status | Created |

#### Frequency decision

`Daily summaries` was selected instead of `Individual alerts` because individual alerts required an Amazon SNS topic in the AWS console.

The selected configuration supports email notifications without introducing an additional SNS resource.

#### Limitations

- Anomaly detection is not instantaneous.
- Daily summaries may delay notification.
- The configured USD 5 threshold may not detect smaller cost increases.
- The service does not enforce hard spending limits.
- Notification delivery remains subject to AWS monitoring and email delivery behavior.

## 5. AWS Amplify Access Control

### 5.1 Configuration

Password protection was enabled for the production branch.

| Property | Configuration |
|---|---|
| Amplify application | `family-learning-games` |
| Branch | `main` |
| Custom domain | `play.joamgames.com` |
| Access setting | Restricted - password required |
| Manage access for all branches | Disabled |
| Username | `joam-family` |
| Password | Configured — not documented |

Credentials must not be committed to the repository or included in release artifacts.

### 5.2 Validation

The following validations were performed:

| Test | Result |
|---|---|
| Open public application URL | Authentication required |
| Authenticate with configured credentials | Successful |
| Access application after authentication | Successful |
| Execute gameplay | Successful |

**Result:** PASSED.

The deployed frontend requires authentication before users can access the application.

### 5.3 Limitations

Amplify password protection is not a substitute for backend authentication or authorization.

The following risks remain:

- Direct API Gateway invocation.
- Automated HTTP requests to public backend routes.
- Unauthorized WebSocket connection attempts.
- Excessive invocation of Lambda and downstream AWS services.
- Shared frontend credentials without individual user identity.

These risks require independent backend controls.

## 6. API Gateway HTTP API Assessment

### 6.1 Identified API

| Property | Value |
|---|---|
| API name | `family-learning-games-api` |
| API ID | `qkyddcomyj` |
| API type | HTTP API |
| Region | us-east-1 |
| Authorization | No authorizers configured |
| Custom throttling | Not configured |

### 6.2 Findings

The reviewed API routes do not have API Gateway authorizers attached.

For example, the route `GET /games` was verified with no authorizer configured.

The lack of an API Gateway authorizer means that access is not restricted at this layer. Any application-level checks must be evaluated separately.

No application-specific throttling configuration had been established at the time of this assessment.

### 6.3 Risks

- Direct requests can bypass frontend password protection.
- Automated clients may generate excessive API requests.
- API Gateway requests may trigger Lambda executions.
- Downstream services may incur usage-based charges.
- CORS restrictions do not prevent direct requests from scripts or non-browser clients.

**Status:** IDENTIFIED — MITIGATION PENDING.

## 7. API Gateway WebSocket Assessment

### 7.1 Identified API

| Property | Value |
|---|---|
| API name | `family-learning-games-multiplayer` |
| API ID | `vd9aqlptji` |
| API type | WebSocket API |
| Stage | `production` |
| Region | us-east-1 |
| `$connect` authorization | None |
| API key required | False |
| Stage rate limit | 10,000 requests/second |
| Stage burst limit | 5,000 |

### 7.2 Identified Routes

The following routes were observed:

```text
$connect
$disconnect
$default

IDENTIFY
NEXT_QUESTION
QUESTION_TIMEOUT
START_GAME
SUBMIT_ANSWER
SYNC_ROOM
```

### 7.3 Findings

The `$connect` route does not require API Gateway authorization.

The WebSocket stage has rate and burst limits that are considerably higher than the expected normal usage of a small family multiplayer application.

These limits do not represent guaranteed maximum billing amounts.

Authentication and authorization behavior implemented inside Lambda, if any, were not verified during this assessment.

### 7.4 Risks

- Direct WebSocket connection attempts.
- Automated message submission.
- Excessive Lambda invocations.
- Unexpected DynamoDB read/write consumption.
- Potential interference with legitimate multiplayer sessions.

**Status:** IDENTIFIED — MITIGATION PENDING.

## 8. Security Controls Summary

| Control | Status | Release |
|---|---|---|
| AWS Budgets | Configured | v0.9.1 |
| Budget email recipients | Validated | v0.9.1 |
| Cost Anomaly Detection | Configured | v0.9.1 |
| Amplify password protection | Validated | v0.9.1 |
| Frontend gameplay after authentication | Validated | v0.9.1 |
| HTTP API exposure assessment | Completed | v0.9.1 |
| WebSocket API exposure assessment | Completed | v0.9.1 |
| HTTP API throttling | Pending | v0.9.2 |
| WebSocket throttling | Pending | v0.9.2 |
| Lambda reserved concurrency | Pending | v0.9.2 |
| DynamoDB maximum throughput | Pending | v0.9.2 |
| Bedrock usage quotas | Pending | v0.9.3 |
| Polly usage limits | Pending evaluation | v0.9.3 |

## 9. Risk Register

| ID | Risk | Priority | Planned mitigation |
|---|---|---|---|
| SEC-001 | Public HTTP API without Gateway authorization | High | Throttling and future authentication assessment |
| SEC-002 | WebSocket `$connect` without authorization | High | Connection protection and message throttling assessment |
| SEC-003 | Excessive Lambda invocation costs | High | Reserved concurrency |
| SEC-004 | Unbounded DynamoDB On-Demand consumption | High | Maximum throughput |
| SEC-005 | Excessive Bedrock/Polly usage | High | Application-level quotas |
| SEC-006 | Delayed financial alerts | Medium | Infrastructure-level consumption controls |
| SEC-007 | Shared frontend credentials | Low | Review authentication needs as user base grows |

Risk priorities are qualitative assessments and do not represent confirmed exploitation or measured financial impact.

## 10. Next Release — v0.9.2

**Release name:** Infrastructure Rate Limits

### Planned controls

1. Define HTTP API throttling at stage and route level.
2. Configure appropriate WebSocket rate and burst limits.
3. Evaluate Lambda execution patterns and configure reserved concurrency.
4. Define DynamoDB On-Demand maximum throughput limits.
5. Validate multiplayer functionality under normal concurrent usage.
6. Test controlled throttling scenarios.
7. Review CloudWatch metrics and unexpected errors.

### Implementation guidelines

- Prefer infrastructure as code over manual console changes.
- Review existing SST/CDK definitions before editing deployed resources.
- Avoid introducing unnecessary recurring costs.
- Preserve multiplayer functionality.
- Validate changes before release.
- Do not assume throttling provides an absolute billing cap.

## 11. Acceptance Criteria

| ID | Acceptance criterion | Result |
|---|---|---|
| AC-01 | A monthly AWS budget is configured | PASS |
| AC-02 | Budget notification recipients are active | PASS |
| AC-03 | AWS Cost Anomaly Detection is configured | PASS |
| AC-04 | Amplify production branch requires credentials | PASS |
| AC-05 | Application gameplay works after authentication | PASS |
| AC-06 | HTTP API exposure is assessed | PASS |
| AC-07 | WebSocket API exposure is assessed | PASS |
| AC-08 | Remaining risks are documented | PASS |
| AC-09 | Documentation is committed and release published | PENDING |

## 12. Release Conclusion

Family Learning Games v0.9.1 establishes an initial security and cost monitoring baseline.

The implemented controls provide:

- Restricted access to the hosted frontend.
- AWS budget monitoring.
- Cost anomaly monitoring.
- Documented exposure of public backend APIs.
- A defined scope for subsequent consumption protection.

**The frontend access control and financial monitoring baseline are operationally validated.**

However, the application remains exposed to direct backend requests. This is an accepted, documented limitation of the current release scope, not a statement that the backend is secure against abuse.

The immediate next priority is implementing infrastructure-level consumption controls in v0.9.2.

---

**Release status:** READY FOR DOCUMENTATION COMMIT — GITHUB RELEASE PENDING  
**Next milestone:** v0.9.2 — Infrastructure Rate Limits