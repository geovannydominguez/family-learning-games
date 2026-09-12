/**
 * A persistent family player profile (ADR-012). This is intentionally a
 * distinct concept from the legacy `Player` in `domain/game/types.ts` (which
 * carries an `avatar` and is embedded in `Game`/`GameSession` for the seeded
 * quiz flow). This `Player` has no AWS/DynamoDB/Lambda/Bedrock dependency and
 * carries only the minimum profile data required by v0.6.
 */
export interface Player {
  playerId: string;
  name: string;
  age: number;
  createdAt: string;
  updatedAt: string;
}
