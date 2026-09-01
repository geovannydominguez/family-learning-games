import type { GameSession } from "../../domain/game/types.ts";

export interface GameSessionRepository {
  findById(id: string): Promise<GameSession | null>;
  save(id: string, session: GameSession): Promise<void>;
}
