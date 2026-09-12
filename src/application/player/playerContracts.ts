import type { Player } from "../../domain/player/types.ts";

export interface CreatePlayerRequest {
  name: string;
  age: number;
}

export interface UpdatePlayerRequest {
  name: string;
  age: number;
}

export interface PlayersListResponse {
  players: Player[];
}
