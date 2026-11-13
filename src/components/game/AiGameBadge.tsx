import { isAiGeneratedGameId } from "./gameUiState";

/**
 * Audit H1: discreet "IA" label for AI-generated games. Renders nothing for
 * seeded games or when the game id is unknown, so nothing is mislabeled.
 */
export function AiGameBadge({ gameId, className = "" }: { gameId: string | null | undefined; className?: string }) {
  if (!isAiGeneratedGameId(gameId)) return null;
  return (
    <span
      className={`inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 align-middle text-xs font-black tracking-wide text-violet-800 ${className}`}
      title="Creado con inteligencia artificial"
    >
      <span aria-hidden="true">IA</span>
      <span className="sr-only">Creado con inteligencia artificial</span>
    </span>
  );
}
