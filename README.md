# Family Learning Games

MVP local de juegos educativos para completar una partida familiar de principio a fin, sin backend ni cuentas.

## Inicio rápido

```bash
npm install
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000) y completa este flujo:

```text
Inicio → jugador → categoría → dificultad → 10 preguntas → resultado
```

La pantalla final permite repetir la partida con la misma selección o elegir otra categoría conservando el jugador.

## Contenido de v0.1

| Área | Incluido |
| --- | --- |
| Jugadores | Amelia, Joaquín, Papá y Mamá |
| Categorías | Animales, Espacio y Números |
| Dificultades | Fácil, Normal y Difícil |
| Partida | 10 preguntas únicas, feedback inmediato, progreso y puntaje |
| Resultado | Mensaje personalizado, repetir o elegir otro juego |
| Datos | 90 preguntas locales: 10 por categoría y dificultad |

## Arquitectura

```text
Next.js UI
    ↓
Application / Game Use Cases
    ↓
GameRepository
    ↓
MockGameRepository
    ↓
JSON local
```

`src/app/page.tsx` obtiene la configuración mediante el caso de uso de aplicación. Los componentes reciben modelos del dominio y nunca importan el JSON. La selección aleatoria, validación de respuestas, puntaje, avance, resultado y reinicio viven en `src/application/game`.

El estado de la partida permanece en React y se pierde al recargar la página, según el alcance de v0.1.

## Verificación

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
```

Los tests cubren el loop de juego y validan el dataset local completo.

## Fuera de alcance

v0.1 no incluye backend, autenticación, persistencia, APIs externas, infraestructura cloud, IA, audio, multijugador ni una librería de estado global.
