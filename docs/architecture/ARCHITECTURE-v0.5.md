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

BEDROCK_GENERATOR_MODEL_ID   # amazon.nova-lite-v1:0   (drafting)
BEDROCK_VALIDATOR_MODEL_ID   # amazon.nova-pro-v1:0    (independent review)
BEDROCK_REGION

BEDROCK_GUARDRAIL_ID
BEDROCK_GUARDRAIL_VERSION
```

Los modelos concretos continúan siendo configuración. Desde ADR-011 la
generación IA usa un pipeline de dos modelos: el generador (`amazon.nova-lite-v1:0`
desde la Revisión 7 de ADR-011 — antes `amazon.nova-micro-v1:0`, cambiado por
calidad de borrador; sólo configuración, sin cambio de arquitectura) genera el
borrador y Nova Pro resuelve cada pregunta **de forma independiente y a ciegas** —
no se le envía cuál opción marcó el generador. Application compara
determinísticamente la respuesta de Nova Pro con la del generador (y exige
`confident`, no `ambiguous`,
sin issues **de severidad `error`**); una discrepancia rechaza esa pregunta. El
LLM no decide la persistencia. Los reintentos son **rondas de reparación a nivel
de pregunta** (no regeneración del borrador completo): las preguntas válidas se
conservan y sólo se vuelven a pedir los huecos fallidos —enviando su texto como
`existingQuestions` para evitar duplicados—, hasta `MAX_REPAIR_ROUNDS = 5`. Se
separan las **rondas de contenido** de los **reintentos técnicos**: un fallo que
no produce candidatos (bloqueo del Guardrail, error de transporte, respuesta
malformada) obtiene primero un reintento acotado de la MISMA ronda
(`MAX_TECHNICAL_RETRIES_PER_ROUND = 1`) — sólo consume la ronda si persiste; un
`provider_error` que también falla su reintento falla cerrado (502).
`GameRepository.create` se llama una sola vez, sólo cuando existen 10 preguntas
únicas válidas; si se agotan las rondas → `AI_GENERATED_CONTENT_INVALID` / HTTP
422 / repositorio = 0. El **tamaño del lote** de generación es autoritativo y
distinto del tamaño final: `GenerateGameRequest.questionCount` es cuántas
preguntas debe devolver **esta llamada** — 10 en la primera ronda, `missingCount`
(1..9) en una reparación — nunca el 10 fijo del juego final. El prompt pide ese
conteo (una reparación dice "el juego final tiene 10 preguntas, pero esta
petición es sólo para N de reemplazo — devuelve exactamente N"), el parser de
`BedrockGameGenerator` valida la longitud contra el conteo pedido y rechaza
cualquier otra como `unexpected_question_count`, y `GenerateGameService`
re-verifica la longitud del lote antes de tocar los candidatos: un lote de más
(p. ej. 10 fijas para una reparación de 1) se rechaza completo, nunca se recorta
en silencio. `AI_GAME_REPAIR_ROUND` distingue `generatedCount` (el tamaño real
devuelto) / `acceptedCount` / `rejectedQuestionCount` (preguntas) / `issueCount`
(≥ el anterior) / `missingCount`; un desajuste de lote se registra además como
`ai_generation_failure` con `validationRule = unexpected_question_count`. El prompt de reparación es mínimo: sólo el conteo, los
textos de las preguntas aceptadas (para de-duplicar, nunca opciones ni
`isCorrect`) y códigos de issue estables — sin `reason` libre del validador ni
frases de anulación de instrucciones ("ignore the rule…"). Además, el Guardrail
evalúa **sólo contenido de usuario no confiable**: la petición Converse envía el
**topic** del usuario dentro de un bloque `guardContent` y deja todo el texto
propio de la aplicación (ajustes `{difficulty, questionCount}`, directivas de
reparación, códigos de issue) como bloques `text` normales. Con la API Converse,
si hay algún bloque `guardContent` el Guardrail de entrada evalúa **sólo** esos
bloques, así que las instrucciones de reparación ya no se clasifican como
`PROMPT_ATTACK` del usuario; la evaluación de **salida** sobre la respuesta del
modelo no cambia. `BedrockGameValidator` aplica la misma frontera (sólo el topic
va en `guardContent`). La configuración del Guardrail (filtros, temas denegados,
PII, política de palabras, salida, `trace`) no se toca. Una intervención del
Guardrail se registra como `AI_GAME_GUARDRAIL_INTERVENED` con un resumen sin
contenido (política/tipo/acción del filtro, `guardrailId`/`version`) leído de
`trace.guardrail`. Los issues se separan por
severidad **según el código, no según lo que afirme el modelo**: factuales y
estructurales (`ANSWER_MISMATCH`, `MULTIPLE_CORRECT_ANSWERS`, `AMBIGUOUS_QUESTION`,
`FACTUAL_UNCERTAINTY`, `OFF_TOPIC`, `AGE_INAPPROPRIATE`, `INVALID_OPTIONS` para
defectos objetivos) bloquean; calidad de distractores (`WEAK_DISTRACTOR`,
`TOO_EASY_DISTRACTOR`, `DISTRACTOR_QUALITY`, `DIFFICULTY_MISMATCH`) son
observaciones no bloqueantes (`warningCount`/`warningTypes` en
`AI_GAME_VALIDATION_SUCCEEDED`). Un quiz "fácil" para niños admite distractores
simples. Application depende
sólo de los puertos `GameGenerator` y `GameValidator`; nada se guarda sin un
veredicto limpio; un fallo técnico del validador falla cerrado. Ver
`docs/architecture/ADR-011-two-model-ai-generation-pipeline.md`.

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
ADR-011  Two-model AI generation pipeline (Nova Lite drafts, Nova Pro blind-solves)
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
