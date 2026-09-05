# Family Learning Games — Requirements v0.5

## 1. Objetivo

La versión **v0.5** corresponde a la **FASE 5 — Desplegar públicamente en AWS** del roadmap de Family Learning Games.

El objetivo principal es permitir que la aplicación completa pueda ser utilizada desde un navegador conectado a Internet, sin necesidad de ejecutar el frontend localmente.

Al finalizar v0.5 deberá ser posible:

```text
Internet
   │
   ▼
Family Learning Games
   │
   ├── Frontend público
   │
   ▼
Backend AWS
   │
   ├── API Gateway HTTP API
   ├── Lambda
   ├── DynamoDB
   └── Amazon Bedrock
```

v0.5 no introduce nuevas capacidades de negocio significativas. Su propósito es **publicar y operar en AWS lo construido hasta v0.4**.

---

# 2. Contexto heredado

v0.5 parte de las capacidades implementadas en las versiones anteriores.

## v0.1

Frontend local jugable:

```text
Next.js
   │
   ▼
MockGameRepository
   │
   ▼
JSON local
```

## v0.2

Backend serverless AWS:

```text
Next.js
   │
   ▼
API Gateway HTTP API
   │
   ▼
Lambda
```

## v0.3

Persistencia:

```text
API Gateway
   │
   ▼
Lambda
   │
   ▼
DynamoDB
```

Tablas:

```text
Games
GameSessions
```

## v0.4

Generación de juegos mediante IA:

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

La generación mediante IA se encuentra desacoplada del dominio mediante el puerto `GameGenerator`.

---

# 3. Alcance v0.5

v0.5 debe incorporar:

1. Hosting público del frontend.
2. Integración del frontend desplegado con el backend existente.
3. HTTPS para acceso a la aplicación.
4. Configuración del frontend para utilizar la API desplegada.
5. Configuración CORS del backend para aceptar el origen público.
6. Deployment reproducible.
7. Validaciones posteriores al deployment.
8. Controles básicos para evitar costos AWS inesperados.

---

# 4. Requerimientos funcionales

## FR-001 — Acceso público

La aplicación debe ser accesible desde un navegador mediante una URL HTTPS pública.

Ejemplo conceptual:

```text
https://main.xxxxx.amplifyapp.com
```

No debe ser necesario ejecutar:

```bash
npm run dev
```

para utilizar la aplicación.

---

## FR-002 — Flujo completo de juego

Desde la aplicación publicada el usuario debe poder ejecutar el flujo funcional existente:

```text
HOME
  ↓
Seleccionar jugadores
  ↓
Seleccionar categoría
  ↓
Seleccionar dificultad
  ↓
Jugar
  ↓
Responder preguntas
  ↓
Resultado
```

---

## FR-003 — Consumo del backend AWS

El frontend publicado debe consumir la instancia desplegada del backend.

La URL del backend no debe estar codificada directamente en componentes React.

Debe obtenerse mediante configuración.

Ejemplo:

```text
NEXT_PUBLIC_GAME_API_BASE_URL
```

---

## FR-004 — Game setup

Desde el frontend público debe continuar funcionando:

```http
GET /game-setup
```

---

## FR-005 — Game sessions

Desde el frontend público debe continuar funcionando:

```http
POST /game-sessions
GET /game-sessions/{id}
```

---

## FR-006 — Generación de juegos con IA

La funcionalidad introducida en v0.4 debe continuar operativa después del despliegue público.

Cuando:

```text
AI_GAME_GENERATION_ENABLED=true
```

el backend podrá generar juegos mediante Amazon Bedrock.

Cuando:

```text
AI_GAME_GENERATION_ENABLED=false
```

la aplicación deberá continuar funcionando sin depender de generación IA.

---

## FR-007 — CORS

El backend deberá aceptar solicitudes originadas desde la URL pública del frontend.

Por ejemplo:

```text
http://localhost:3000
https://<application>.amplifyapp.com
```

El origen permitido deberá ser configurable y no estar disperso por el código.

---

## FR-008 — Deployment desde Git

El frontend deberá poder desplegarse desde el repositorio Git del proyecto.

El flujo esperado será:

```text
Developer
   │
   ▼
GitHub
   │
   ▼
AWS Amplify Hosting
   │
   ▼
Build
   │
   ▼
Deploy
```

---

# 5. Requerimientos no funcionales

## NFR-001 — HTTPS

Todo acceso público al frontend deberá realizarse mediante HTTPS.

---

## NFR-002 — Separación frontend/backend

La publicación del frontend no deberá acoplar el frontend con la implementación del backend.

La dependencia continuará siendo únicamente:

```text
Frontend
   │
HTTP
   ▼
Game API
```

---

## NFR-003 — Configuración externa

Valores dependientes del entorno deberán configurarse mediante variables de entorno.

Como mínimo:

```text
NEXT_PUBLIC_GAME_API_BASE_URL
```

No deberán existir URLs AWS de ambientes específicas hardcodeadas en componentes o casos de uso.

---

## NFR-004 — Infraestructura existente

v0.5 deberá reutilizar la infraestructura backend existente siempre que sea posible.

No se crearán nuevos microservicios ni nuevas Lambdas únicamente para publicar el frontend.

---

## NFR-005 — Cost awareness

Los recursos introducidos deberán mantener el proyecto dentro de una arquitectura apropiada para:

```text
uso personal
+
tráfico bajo
+
crecimiento progresivo
```

No se introducirán recursos permanentemente costosos sin una necesidad funcional.

---

## NFR-006 — Observabilidad mínima

Un error de deployment deberá poder diagnosticarse mediante los logs de build/deployment proporcionados por la plataforma de hosting.

Los logs existentes de Lambda y API Gateway continuarán siendo utilizados para diagnosticar errores del backend.

---

## NFR-007 — Reproducibilidad

Un nuevo deployment deberá poder ejecutarse sin cambios manuales en el código fuente.

La configuración dependiente del entorno deberá permanecer fuera del código.

---

## NFR-008 — Seguridad de secretos

No deberán utilizarse variables públicas de Next.js para almacenar:

```text
AWS access keys
AWS secret keys
Bedrock credentials
API keys privadas
tokens privados
```

Únicamente valores destinados al navegador podrán utilizar prefijos públicos como:

```text
NEXT_PUBLIC_*
```

---

# 6. Deployment objetivo

Frontend:

```text
GitHub
   │
   ▼
AWS Amplify Hosting
   │
   ▼
HTTPS public URL
```

Backend:

```text
Amazon API Gateway HTTP API
             │
             ▼
           Lambda
        ┌────┴────┐
        ▼         ▼
    DynamoDB    Bedrock
```

Integración:

```text
Browser
   │
   │ HTTPS
   ▼
Amplify Hosting
   │
   │ HTTPS
   ▼
API Gateway HTTP API
   │
   ▼
Lambda
```

---

# 7. Fuera de alcance

Los siguientes elementos **NO forman parte de v0.5**:

### Autenticación

No se incorporarán todavía:

```text
Cognito
login
passwords
JWT
usuarios
roles
```

Esto podrá evaluarse como parte de perfiles familiares.

---

### Perfiles familiares

Corresponde a:

```text
FASE 6
```

---

### PWA

Corresponde a:

```text
FASE 7
```

---

### Audio e imágenes

Corresponde a:

```text
FASE 8
```

---

### Multiplayer

Corresponde a:

```text
FASE 9
```

---

### Nuevos tipos de juegos

Corresponde a:

```text
FASE 10
```

---

### Dominio personalizado

Un dominio personalizado no es requisito para considerar v0.5 terminada.

La URL administrada por la plataforma de hosting es suficiente para el MVP público.

Un dominio personalizado podrá incorporarse posteriormente.

---

### CI/CD avanzado

No se incorporarán todavía pipelines complejos con múltiples ambientes, promotion workflows o estrategias blue/green.

El deployment automático asociado al repositorio será suficiente.

---

# 8. Restricciones

v0.5 deberá preservar las decisiones arquitectónicas existentes.

En particular:

* Domain no dependerá de AWS.
* Application no dependerá directamente del SDK de Bedrock.
* `GameGenerator` seguirá siendo el puerto para generación de juegos.
* DynamoDB continuará detrás de repositories.
* API Gateway continuará siendo HTTP API.
* Se reutilizará la Lambda backend existente.
* IA continuará pudiendo deshabilitarse mediante configuración.

---

# 9. Criterios de aceptación

v0.5 se considerará terminada cuando todas las siguientes condiciones sean verdaderas.

## Build

```bash
npm ci
npm run lint
npx tsc --noEmit
npm test
npm run build
npx cdk synth
git diff --check
```

Todos los comandos deben finalizar correctamente.

---

## Frontend

Desde un dispositivo conectado a Internet:

```text
Given
  la aplicación está desplegada

When
  el usuario abre la URL pública

Then
  puede visualizar Family Learning Games
```

---

## Backend

Desde el frontend publicado:

```text
GET /game-setup
```

debe responder correctamente.

---

## Juego

El usuario deberá poder completar una partida completa:

```text
crear partida
→ responder preguntas
→ finalizar
→ visualizar resultado
```

---

## Persistencia

Las sesiones creadas desde Internet deberán almacenarse en DynamoDB.

---

## IA

Cuando IA esté habilitada deberá ser posible generar un juego utilizando el flujo implementado en v0.4.

---

## CORS

No deberán aparecer errores CORS al consumir el backend desde la URL pública.

---

## HTTPS

El frontend deberá utilizar HTTPS.

---

# 10. Definition of Done

v0.5 estará completa cuando:

```text
[ ] Frontend desplegado en AWS
[ ] URL HTTPS pública disponible
[ ] Frontend conectado al backend
[ ] CORS configurado
[ ] Game setup funciona
[ ] Creación de sesión funciona
[ ] Consulta de sesión funciona
[ ] DynamoDB funciona
[ ] Generación IA funciona cuando está habilitada
[ ] Flujo completo probado desde Internet
[ ] Validaciones estándar pasan
[ ] Documentación v0.5 actualizada
[ ] Tag Git v0.5.0 creado
[ ] GitHub Release v0.5.0 creado
```

---

# 11. Resultado esperado

Antes de v0.5:

```text
Laptop
 │
 ├── localhost:3000
 │
 └───────────────► AWS Backend
```

Después de v0.5:

```text
                  INTERNET

User Browser
     │
     │ HTTPS
     ▼
AWS Amplify Hosting
     │
     │ HTTPS
     ▼
API Gateway
     │
     ▼
Lambda
   ┌─┴──────────────┐
   ▼                ▼
DynamoDB        Amazon Bedrock
```

Family Learning Games deja de ser una aplicación que requiere un entorno local para convertirse en una **aplicación web públicamente accesible**.
