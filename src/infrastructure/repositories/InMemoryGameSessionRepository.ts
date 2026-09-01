import type { GameSessionRepository } from "../../application/game/GameSessionRepository.ts";
import type { GameSession } from "../../domain/game/types.ts";

/**
 * Process-local session storage for v0.2 only. Lambda may recycle or replace the
 * execution environment at any time, so sessions can disappear between requests.
 */
export class InMemoryGameSessionRepository implements GameSessionRepository {
  private readonly sessions = new Map<string, GameSession>();

  async findById(id: string): Promise<GameSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async save(id: string, session: GameSession): Promise<void> {
    this.sessions.set(id, session);
  }
}
