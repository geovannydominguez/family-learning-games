import type { Player } from "../../domain/player/types.ts";

/**
 * Application-owned port for persistent family player profiles (ADR-012).
 * Infrastructure implements this against DynamoDB; Application and Domain
 * never import an AWS SDK type here.
 */
export interface PlayerRepository {
  list(): Promise<Player[]>;
  getById(playerId: string): Promise<Player | null>;
  create(player: Player): Promise<Player>;
  update(player: Player): Promise<Player>;
  delete(playerId: string): Promise<void>;
}
