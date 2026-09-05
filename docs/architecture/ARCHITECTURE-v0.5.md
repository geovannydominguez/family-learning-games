# Family Learning Games — Architecture v0.5

## 1. Propósito

Este documento describe la arquitectura de **Family Learning Games v0.5**.

v0.5 implementa:

> **FASE 5 — Desplegar públicamente en AWS**

La versión no introduce un nuevo dominio funcional.

Su cambio arquitectónico principal es incorporar la capa de hosting público necesaria para ejecutar el frontend Next.js desde Internet.

---

# 2. Evolución arquitectónica

## v0.1

```text
Browser
  │
  ▼
Next.js
  │
  ▼
MockGameRepository
  │
  ▼
JSON
```

---

## v0.2

```text
Browser
  │
  ▼
Next.js
  │
  ▼
GameApiClient
  │
  ▼
API Gateway HTTP API
  │
  ▼
Lambda
```

---

## v0.3

```text
Browser
  │
  ▼
Next.js
  │
  ▼
API Gateway
  │
  ▼
Lambda
  │
  ▼
Application
  │
  ▼
Repositories
  │
  ▼
DynamoDB
```

---

## v0.4

```text
                        ┌──► DynamoDB
                        │
Browser → API → Lambda → Application
                        │
                        └──► GameGenerator
                                  │
                                  ▼
                         BedrockGameGenerator
                                  │
                                  ▼
                           Amazon Bedrock
```

---

## v0.5

```text
GitHub
  │
  │ source
  ▼
AWS Amplify Hosting
  │
  │ HTTPS
  ▼
Browser
  │
  │ HTTPS
  ▼
API Gateway HTTP API
  │
  ▼
Lambda
  │
  ▼
Application
 ┌┴──────────────────────┐
 │                       │
 ▼                       ▼
Repositories       GameGenerator
 │                       │
 ▼                       ▼
DynamoDB        BedrockGameGenerator
                         │
                         ▼
                  Amazon Bedrock
```

---

# 3. Architecture drivers

Los principales drivers de v0.5 son:

### Public accessibility

La aplicación debe dejar de depender de:

```text
localhost:3000
```

---

### Simplicidad

El proyecto continúa siendo pequeño.

No se necesita introducir:

```text
EKS
ECS
ALB
EC2
Kubernetes
containers
```

para servir el frontend.

---

### Bajo costo operacional

La solución deberá seguir aprovechando servicios administrados/serverless.

---

### Separación frontend/backend

El frontend desplegado continuará consumiendo el backend mediante HTTP.

---

### Deployment reproducible

El deployment deberá derivarse del repositorio Git y configuración del ambiente.

---

# 4. Arquitectura lógica

```text
┌───────────────────────────────────────────────────────┐
│                      PRESENTATION                     │
│                                                       │
│                    Next.js / React                    │
└───────────────────────────┬───────────────────────────┘
                            │
                            │ GameApiClient
                            ▼
┌───────────────────────────────────────────────────────┐
│                      HTTP API                         │
│                                                       │
│              Amazon API Gateway HTTP API              │
└───────────────────────────┬───────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────┐
│                    INFRASTRUCTURE                     │
│                                                       │
│                  Backend Lambda                       │
└───────────────────────────┬───────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────┐
│                    APPLICATION                        │
│                                                       │
│         Use Cases / Services / Application Ports      │
│                                                       │
│        Repository              GameGenerator           │
└─────────────┬───────────────────────────┬─────────────┘
              │                           │
              ▼                           ▼
┌────────────────────────┐     ┌────────────────────────┐
│      DynamoDB          │     │ BedrockGameGenerator   │
└────────────────────────┘     └────────────┬───────────┘
                                           │
                                           ▼
                                ┌────────────────────────┐
                                │    Amazon Bedrock      │
                                └────────────────────────┘
```

---

# 5. Arquitectura física AWS

```text
┌─────────────────────────────────────────────────────────────┐
│                         INTERNET                            │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               │ HTTPS
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                   AWS Amplify Hosting                       │
│                                                             │
│                   Family Learning Games                     │
│                       Next.js                               │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               │ HTTPS
                               ▼
┌─────────────────────────────────────────────────────────────┐
│               Amazon API Gateway HTTP API                   │
│                                                             │
│                    Family Learning API                      │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                        AWS Lambda                           │
│                                                             │
│              family-learning-games-backend                  │
└───────────────────────┬───────────────────┬─────────────────┘
                        │                   │
                        │                   │
             ┌──────────▼───────┐   ┌──────▼──────────────┐
             │ Amazon DynamoDB  │   │ Amazon Bedrock      │
             │                  │   │                     │
             │ Games            │   │ Game generation     │
             │ GameSessions     │   │                     │
             └──────────────────┘   └─────────────────────┘
```

---

# 6. Hosting del frontend

Se utilizará:

```text
AWS Amplify Hosting
```

Responsabilidades:

```text
Git integration
build
deployment
HTTPS
public URL
frontend hosting
deployment logs
```

Amplify será infraestructura de presentación.

No contendrá reglas de dominio.

---

# 7. Flujo de deployment

```text
Developer
    │
    │ git push
    ▼
GitHub
    │
    │ repository integration
    ▼
AWS Amplify
    │
    ├── npm install / npm ci
    ├── build
    ├── package
    └── deploy
            │
            ▼
     Public HTTPS URL
```

El proceso de deployment no deberá requerir modificar el código para apuntar al backend correspondiente.

---

# 8. Comunicación frontend → backend

El navegador continuará utilizando:

```text
GameApiClient
```

El cliente obtiene la dirección del API mediante:

```text
NEXT_PUBLIC_GAME_API_BASE_URL
```

Flujo:

```text
React Component
      │
      ▼
Application UI
      │
      ▼
GameApiClient
      │
      │ HTTPS
      ▼
API Gateway
```

No se permitirá:

```ts
fetch("https://some-random-api.execute-api.us-east-1.amazonaws.com")
```

directamente desde componentes.

---

# 9. CORS

Antes:

```text
Allowed origin:
http://localhost:3000
```

v0.5:

```text
Allowed origins:

http://localhost:3000
https://<amplify-host>
```

El origen público deberá configurarse mediante infraestructura/configuración.

Conceptualmente:

```text
ALLOWED_ORIGINS
```

o configuración equivalente en CDK.

---

# 10. Persistencia

No existen cambios arquitectónicos respecto a v0.3.

```text
GameRepository
      │
      ▼
DynamoDbGameRepository
      │
      ▼
Games
```

y:

```text
GameSessionRepository
      │
      ▼
DynamoDbGameSessionRepository
      │
      ▼
GameSessions
```

Las tablas existentes serán reutilizadas.

---

# 11. Generación mediante IA

No existen cambios conceptuales respecto a v0.4.

```text
Application
    │
    ▼
GameGenerator
    │
    ▼
BedrockGameGenerator
    │
    ▼
Amazon Bedrock
```

Se preserva la configuración:

```text
AI_GAME_GENERATION_ENABLED

BEDROCK_MODEL_ID
BEDROCK_REGION

BEDROCK_GUARDRAIL_ID
BEDROCK_GUARDRAIL_VERSION
```

El modelo concreto continuará siendo configuración.

---

# 12. Límites de arquitectura

## Presentation

Puede depender de:

```text
Application contracts
HTTP client abstractions
```

No debe depender de:

```text
AWS SDK
DynamoDB SDK
Bedrock SDK
```

---

## Domain

Debe continuar completamente independiente de AWS.

```text
Domain
   X
AWS SDK
```

---

## Application

Define puertos como:

```ts
interface GameGenerator {
  generate(
    request: GenerateGameRequest
  ): Promise<GeneratedGameDraft>;
}
```

Application no conoce:

```text
Bedrock Converse API
modelId
guardrailId
AWS credentials
```

---

## Infrastructure

Contiene implementaciones AWS:

```text
DynamoDbGameRepository
DynamoDbGameSessionRepository
BedrockGameGenerator
Lambda adapters
```

---

# 13. IAM

El frontend no deberá disponer de credenciales AWS.

```text
Browser
   X
AWS credentials
```

El acceso a AWS ocurre mediante:

```text
Browser
   │
   ▼
API Gateway
   │
   ▼
Lambda IAM Role
```

El role de Lambda conservará únicamente los permisos necesarios para sus responsabilidades.

Por ejemplo:

```text
DynamoDB read/write
Bedrock invoke
CloudWatch Logs
```

cuando correspondan.

---

# 14. Secrets

No se almacenarán credenciales AWS en:

```text
NEXT_PUBLIC_*
Git
source code
browser local storage
```

`NEXT_PUBLIC_GAME_API_BASE_URL` es aceptable porque la URL de una API pública no constituye un secreto.

---

# 15. Ambientes

Para v0.5 se mantiene deliberadamente un modelo sencillo.

```text
main
 │
 ▼
public application
```

No se introducen todavía:

```text
dev
qa
staging
production
```

como ambientes independientes completos.

Esto podrá evolucionar cuando el proyecto tenga usuarios o necesidades operacionales reales.

---

# 16. Dominio

Para v0.5:

```text
Amplify-managed domain
```

es suficiente.

Ejemplo:

```text
https://main.xxxxx.amplifyapp.com
```

Un dominio como:

```text
familylearninggames.com
```

no es necesario para completar esta versión.

---

# 17. Observabilidad

Frontend deployment:

```text
Amplify build/deploy logs
```

Backend:

```text
CloudWatch Logs
     │
     ├── Lambda
     └── API execution/runtime information
```

No se introducirá todavía una plataforma adicional de observabilidad.

---

# 18. Failure boundaries

## Amplify failure

Puede afectar:

```text
frontend availability
```

pero no modifica datos directamente.

---

## API Gateway/Lambda failure

Puede afectar:

```text
game setup
game sessions
AI generation
```

---

## DynamoDB failure

Puede afectar:

```text
game retrieval
session persistence
```

---

## Bedrock failure

Debe afectar únicamente las funcionalidades que requieren generación mediante IA.

No debe impedir que el backend arranque ni que las funcionalidades no dependientes de IA puedan operar.

---

# 19. Decisiones preservadas

v0.5 preserva:

```text
ADR-001  Next.js + backend desacoplado por APIs
...
ADR-008  Amazon Bedrock behind GameGenerator
```

Y añade:

```text
ADR-010  AWS Amplify Hosting for public web deployment
```

---

# 20. Arquitectura objetivo v0.5

```text
                         GitHub
                            │
                            ▼
                    AWS Amplify Hosting
                            │
                       HTTPS│
                            ▼
                     ┌─────────────┐
                     │   Browser   │
                     └──────┬──────┘
                            │
                       HTTPS│
                            ▼
                  ┌──────────────────┐
                  │ API Gateway HTTP │
                  └────────┬─────────┘
                           │
                           ▼
                    ┌────────────┐
                    │   Lambda   │
                    └──────┬─────┘
                           │
                ┌──────────┴───────────┐
                │                      │
                ▼                      ▼
          ┌────────────┐       ┌──────────────┐
          │ Application│       │ Infrastructure│
          └─────┬──────┘       └──────────────┘
                │
          ┌─────┴────────────┐
          │                  │
          ▼                  ▼
    Repositories        GameGenerator
          │                  │
          ▼                  ▼
      DynamoDB      BedrockGameGenerator
                             │
                             ▼
                      Amazon Bedrock
```

---

# 21. Principio rector de v0.5

> **Publicar lo que ya funciona, sin convertir el deployment en una nueva plataforma.**

v0.5 debe ser una evolución incremental:

```text
v0.4
Aplicación completa
pero frontend local

        ↓

v0.5
Misma aplicación
públicamente accesible
```
