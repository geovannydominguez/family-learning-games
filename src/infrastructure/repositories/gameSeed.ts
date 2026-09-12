import type { Category, Game, Player, Question } from "../../domain/game/types.ts";

export interface GameSeedSource {
  players: Player[];
  categories: Category[];
  questions: Question[];
}

export interface GameRecord {
  gameId: string;
  title: string;
  category: Category;
  players: Player[];
  questions: Question[];
  version: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  generationMetadata?: Game["generationMetadata"];
}

const initialTimestamp = "2026-09-01T00:00:00.000Z";

export function buildGameSeedRecords(source: GameSeedSource): GameRecord[] {
  return source.categories.map((category, sortOrder) => gameDomainToRecord({
    id: category.id,
    title: category.name,
    category,
    players: source.players,
    questions: source.questions.filter((question) => question.categoryId === category.id),
  }, initialTimestamp, sortOrder));
}

export function gameDomainToRecord(
  game: Game,
  timestamp: string,
  sortOrder = Number.MAX_SAFE_INTEGER,
): GameRecord {
  return {
    gameId: game.id,
    title: game.title,
    category: game.category,
    players: game.players,
    questions: game.questions,
    version: 1,
    sortOrder,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(game.generationMetadata ? { generationMetadata: game.generationMetadata } : {}),
  };
}

export function gameRecordToDomain(record: GameRecord): Game {
  return {
    id: record.gameId,
    title: record.title,
    category: record.category,
    players: record.players,
    questions: record.questions,
    ...(record.generationMetadata ? { generationMetadata: record.generationMetadata } : {}),
  };
}

export function isGameRecord(value: unknown): value is GameRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<GameRecord>;
  return (
    typeof record.gameId === "string" &&
    typeof record.title === "string" &&
    !!record.category &&
    typeof record.category.id === "string" &&
    Array.isArray(record.players) &&
    record.players.every(isPlayer) &&
    Array.isArray(record.questions) &&
    typeof record.version === "number" &&
    typeof record.sortOrder === "number"
  );
}

function isPlayer(value: unknown): value is Player {
  if (!value || typeof value !== "object") return false;
  const player = value as Partial<Player>;
  return (
    typeof player.id === "string"
    && typeof player.name === "string"
    && typeof player.avatar === "string"
    && typeof player.age === "number"
    && Number.isInteger(player.age)
    && player.age > 0
  );
}
