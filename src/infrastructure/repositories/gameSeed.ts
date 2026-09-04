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
}

const initialTimestamp = "2026-09-01T00:00:00.000Z";

export function buildGameSeedRecords(source: GameSeedSource): GameRecord[] {
  return source.categories.map((category, sortOrder) => ({
      gameId: category.id,
      title: category.name,
      category,
      players: source.players,
      questions: source.questions.filter((question) => question.categoryId === category.id),
      version: 1,
      sortOrder,
      createdAt: initialTimestamp,
      updatedAt: initialTimestamp,
    }));
}

export function gameRecordToDomain(record: GameRecord): Game {
  return {
    id: record.gameId,
    title: record.title,
    category: record.category,
    players: record.players,
    questions: record.questions,
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
    Array.isArray(record.questions) &&
    typeof record.version === "number" &&
    typeof record.sortOrder === "number"
  );
}
