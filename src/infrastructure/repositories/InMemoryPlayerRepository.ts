import type { PlayerRepository } from "../../application/player/PlayerRepository.ts";
import type { Player } from "../../domain/player/types.ts";
import { ApplicationError } from "../../application/errors.ts";

/**
 * Process-local player storage. Used by tests as a lightweight `PlayerRepository`
 * double, mirroring `InMemoryGameSessionRepository`.
 */
export class InMemoryPlayerRepository implements PlayerRepository {
  private readonly players = new Map<string, Player>();

  async list(): Promise<Player[]> {
    return [...this.players.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getById(playerId: string): Promise<Player | null> {
    return this.players.get(playerId) ?? null;
  }

  async create(player: Player): Promise<Player> {
    if (this.players.has(player.playerId)) {
      throw new ApplicationError("PLAYER_CONFLICT", "A player with this ID already exists.");
    }
    this.players.set(player.playerId, player);
    return player;
  }

  async update(player: Player): Promise<Player> {
    this.players.set(player.playerId, player);
    return player;
  }

  async delete(playerId: string): Promise<void> {
    this.players.delete(playerId);
  }
}
