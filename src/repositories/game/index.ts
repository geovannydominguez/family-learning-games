import type { GameRepository } from "./GameRepository";
import { MockGameRepository } from "./MockGameRepository";

export const gameRepository: GameRepository = new MockGameRepository();
