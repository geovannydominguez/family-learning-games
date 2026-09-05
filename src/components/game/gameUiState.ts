import type { StartGameSessionCommand } from "../../application/game/gameSessionContracts.ts";
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
    if (error.code === "NETWORK_ERROR") {
      return "No pudimos conectar con el servicio. Revisa tu conexión e inténtalo otra vez.";
    }
    if (error.code === "MISSING_CONFIGURATION") {
      return "El servicio de juegos no está configurado. Define NEXT_PUBLIC_GAME_API_BASE_URL.";
    }
    if (error.code === "SESSION_NOT_FOUND") {
      return "La partida expiró. Inicia una nueva para continuar.";
    }
    return error.message;
  }
  return fallback;
}
