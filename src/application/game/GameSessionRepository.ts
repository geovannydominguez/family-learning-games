import type { GameSession } from "../../domain/game/types.ts";

export interface GameSessionRepository {
  findById(id: string): Promise<GameSession | null>;
  create(id: string, session: GameSession): Promise<void>;
  update(id: string, session: GameSession, expectedRevision: number): Promise<void>;
}
