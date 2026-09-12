import { randomUUID } from "node:crypto";

import type { Player } from "../../domain/player/types.ts";
import { ApplicationError } from "../errors.ts";
import type { PlayerRepository } from "./PlayerRepository.ts";

const minAge = 3;
const maxAge = 99;
const maxNameLength = 50;

export interface CreatePlayerCommand {
  name: unknown;
  age: unknown;
}

export interface UpdatePlayerCommand {
  playerId: string;
  name: unknown;
  age: unknown;
}

/**
 * Application service for family player profile CRUD (ADR-012). Owns
 * validation, id generation, and timestamps; Infrastructure never sees this
 * logic and Domain stays a plain type. Mirrors the single-class-with-methods
 * style already used by `GameSessionService` rather than one class per use
 * case.
 */
export class PlayerService {
  private readonly repository: PlayerRepository;
  private readonly createId: () => string;
  private readonly now: () => string;

  constructor(
    repository: PlayerRepository,
    createId: () => string = randomUUID,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.repository = repository;
    this.createId = createId;
    this.now = now;
  }

  async list(): Promise<Player[]> {
    return this.repository.list();
  }

  async getById(playerId: string): Promise<Player> {
    const player = await this.repository.getById(playerId);
    if (!player) throw new ApplicationError("PLAYER_NOT_FOUND", "Player was not found.");
    return player;
  }

  async create(command: CreatePlayerCommand): Promise<Player> {
    const name = validateName(command.name);
    const age = validateAge(command.age);
    const timestamp = this.now();
    const player: Player = {
      playerId: `player-${this.createId()}`,
      name,
      age,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.repository.create(player);
  }

  async update(command: UpdatePlayerCommand): Promise<Player> {
    const name = validateName(command.name);
    const age = validateAge(command.age);
    const existing = await this.repository.getById(command.playerId);
    if (!existing) throw new ApplicationError("PLAYER_NOT_FOUND", "Player was not found.");
    const updated: Player = {
      ...existing,
      name,
      age,
      updatedAt: this.now(),
    };
    return this.repository.update(updated);
  }

  async delete(playerId: string): Promise<void> {
    const existing = await this.repository.getById(playerId);
    if (!existing) throw new ApplicationError("PLAYER_NOT_FOUND", "Player was not found.");
    await this.repository.delete(playerId);
  }
}

function validateName(value: unknown): string {
  if (typeof value !== "string") throw new ApplicationError("INVALID_PLAYER", "Player name is required.");
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxNameLength) {
    throw new ApplicationError("INVALID_PLAYER", "Player name must be between 1 and 50 characters.");
  }
  return trimmed;
}

function validateAge(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minAge || value > maxAge) {
    throw new ApplicationError("INVALID_PLAYER_AGE", `Player age must be an integer between ${minAge} and ${maxAge}.`);
  }
  return value;
}
