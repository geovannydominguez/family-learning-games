import type { GameSetup } from "../../domain/game/types.ts";
import type { GameRepository } from "../../repositories/game/GameRepository.ts";

export async function loadGameSetup(
  repository: GameRepository,
): Promise<GameSetup> {
  const [players, categories, questions] = await Promise.all([
    repository.getPlayers(),
    repository.getCategories(),
    repository.getQuestions(),
  ]);

  return { players, categories, questions };
}
