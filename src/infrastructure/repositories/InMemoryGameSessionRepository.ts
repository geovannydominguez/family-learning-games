import type { GameSessionRepository } from "../../application/game/GameSessionRepository.ts";
import type { GameSession } from "../../domain/game/types.ts";
import { ApplicationError } from "../../application/errors.ts";

/**
 * Process-local session storage for v0.2 only. Lambda may recycle or replace the
 * execution environment at any time, so sessions can disappear between requests.
 */
export class InMemoryGameSessionRepository implements GameSessionRepository {
  private readonly sessions = new Map<string, GameSession>();

  async findById(id: string): Promise<GameSession | null> {
    const session = this.sessions.get(id);
    return session ? normalizeSession(session) : null;
  }

  async create(id: string, session: GameSession): Promise<void> {
    if (this.sessions.has(id)) throw new ApplicationError("SESSION_CONFLICT", "The game session already exists.");
    this.sessions.set(id, normalizeSession(session));
  }

  async update(id: string, session: GameSession, expectedRevision: number): Promise<void> {
    const current = this.sessions.get(id);
    if (!current || current.revision !== expectedRevision) {
      throw new ApplicationError("SESSION_CONFLICT", "The game session changed before this request could be saved.");
    }
    this.sessions.set(id, normalizeSession(session));
  }
}

function normalizeSession(session: GameSession): GameSession {
  return session.gameId ? session : { ...session, gameId: session.category.id };
}
