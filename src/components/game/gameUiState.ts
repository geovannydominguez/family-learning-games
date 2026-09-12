import type { PublicGame, StartGameSessionCommand } from "../../application/game/gameSessionContracts.ts";
import type { Difficulty } from "../../domain/game/types.ts";
import { GameApiError } from "../../infrastructure/http/GameApiClient.ts";

export function buildStartSessionCommand(
  playerId: string,
  categoryId: string,
  difficulty: Difficulty,
  gameId?: string,
): StartGameSessionCommand {
  return {
    playerId,
    categoryId,
    difficulty,
    ...(gameId !== undefined ? { gameId } : {}),
  };
}

/**
 * From the full `GET /games` catalog, keep only AI-generated games (id `ai-…`).
 * Seed/base-category games (id === category id) are never included, so they
 * cannot be duplicated in the "Tus juegos creados" section. Returns `[]` for a
 * missing or malformed response so the section simply stays hidden.
 */
export function selectCreatedGames(games: readonly PublicGame[] | null | undefined): PublicGame[] {
  if (!Array.isArray(games)) return [];
  return games.filter((game) => typeof game?.id === "string" && game.id.startsWith("ai-"));
}

/** An AI game is generated with a single difficulty; fall back defensively. */
export function createdGameDifficulty(game: PublicGame): Difficulty {
  return game.difficulties[0] ?? "normal";
}

/**
 * Session command for replaying an already-persisted AI game. Always carries the
 * exact `gameId` (ai-…) and that game's own `category.id`, so the backend
 * selects the stored game by id and never falls back to legacy category lookup.
 * No call to Bedrock is involved.
 */
export function buildCreatedGameSessionCommand(playerId: string, game: PublicGame): StartGameSessionCommand {
  return buildStartSessionCommand(playerId, game.category.id, createdGameDifficulty(game), game.id);
}

export function gameUiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof GameApiError) {
    if (error.code === "RATE_LIMITED" || error.status === 429) {
      return "Muchas familias están creando juegos ahora. Espera un momento e inténtalo nuevamente.";
    }
    if (error.code === "AI_GENERATION_DISABLED") {
      return "La creación de juegos nuevos no está disponible en este momento.";
    }
    if (error.code === "INVALID_GENERATION_REQUEST") {
      return "Escribe un tema válido de hasta 80 caracteres y elige una dificultad.";
    }
    if (error.code === "AI_GENERATED_CONTENT_INVALID") {
      return "No pudimos obtener contenido válido para esta partida. Inténtalo nuevamente.";
    }
    if (error.code === "AI_GENERATION_FAILED") {
      return "No pudimos crear el juego en este momento. Inténtalo más tarde.";
    }
    if (error.code === "AI_GENERATION_BLOCKED") {
      return "No pudimos crear este juego. Intenta nuevamente o prueba con otro tema.";
    }
    if (error.code === "NETWORK_ERROR") {
      return "No pudimos conectar con el servicio. Revisa tu conexión e inténtalo otra vez.";
    }
    if (error.code === "MISSING_CONFIGURATION") {
      return "El servicio de juegos no está configurado. Define NEXT_PUBLIC_GAME_API_BASE_URL.";
    }
    if (error.code === "SESSION_NOT_FOUND") {
      return "La partida expiró. Inicia una nueva para continuar.";
    }
    if (error.code === "INVALID_PLAYER") {
      return "Escribe un nombre válido de hasta 50 caracteres.";
    }
    if (error.code === "INVALID_PLAYER_AGE") {
      return "La edad debe ser un número entero entre 3 y 99 años.";
    }
    if (error.code === "PLAYER_NOT_FOUND") {
      return "No encontramos ese jugador. Elige otro perfil de la lista.";
    }
    return error.message;
  }
  return fallback;
}
