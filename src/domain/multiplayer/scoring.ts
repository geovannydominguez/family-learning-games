import type { MultiplayerQuestionResult, MultiplayerScore } from "./types.ts";

/**
 * v0.9 multiplayer scoring (ADR-019). Pure and deterministic: the backend is
 * the only caller whose result counts. Accuracy is ranked before speed.
 */
export const BASE_CORRECT_POINTS = 1_000;
export const SPEED_BONUS_BY_PLACEMENT: Readonly<Record<number, number>> = { 1: 300, 2: 200, 3: 100 };
export const DEFAULT_PLACEMENT_TIE_WINDOW_MS = 100;

export interface ScorableAnswer {
  playerId: string;
  isCorrect: boolean;
  serverReceivedAtMs: number;
  responseDurationMs: number;
}

export function speedBonus(placement: number): number {
  return SPEED_BONUS_BY_PLACEMENT[placement] ?? 0;
}

/**
 * Scores one question for every eligible player.
 *
 * - Incorrect and missing answers get 0 and never consume a placement.
 * - Correct answers are ordered by server receive time; answers within
 *   `tieWindowMs` of the first answer of a group share that group's placement
 *   (competition ranking: two tied firsts are followed by a third).
 */
export function calculateQuestionResults(
  answers: readonly ScorableAnswer[],
  eligiblePlayerIds: readonly string[],
  tieWindowMs: number = DEFAULT_PLACEMENT_TIE_WINDOW_MS,
): MultiplayerQuestionResult[] {
  const correct = answers
    .filter((answer) => answer.isCorrect)
    .sort((left, right) => left.serverReceivedAtMs - right.serverReceivedAtMs || left.playerId.localeCompare(right.playerId));
  const placements = new Map<string, number>();
  let groupStartMs = Number.NEGATIVE_INFINITY;
  let groupPlacement = 0;
  correct.forEach((answer, index) => {
    if (answer.serverReceivedAtMs - groupStartMs > tieWindowMs) {
      groupStartMs = answer.serverReceivedAtMs;
      groupPlacement = index + 1;
    }
    placements.set(answer.playerId, groupPlacement);
  });

  const byPlayer = new Map(answers.map((answer) => [answer.playerId, answer]));
  const players = [...new Set([...eligiblePlayerIds, ...answers.map((answer) => answer.playerId)])].sort();
  return players.map((playerId) => {
    const answer = byPlayer.get(playerId);
    const placement = placements.get(playerId) ?? null;
    if (!answer || placement === null) {
      return { playerId, answered: Boolean(answer), isCorrect: false, placement: null, pointsAwarded: 0 };
    }
    return {
      playerId,
      answered: true,
      isCorrect: true,
      placement,
      pointsAwarded: BASE_CORRECT_POINTS + speedBonus(placement),
      responseDurationMs: answer.responseDurationMs,
    };
  });
}

/** The aggregate increment one question result adds to a member's score. */
export function scoreDelta(result: MultiplayerQuestionResult): MultiplayerScore {
  const correct = result.isCorrect && result.placement !== null;
  return {
    correctAnswers: correct ? 1 : 0,
    totalPoints: result.pointsAwarded,
    firstPlaceCorrectAnswers: correct && result.placement === 1 ? 1 : 0,
    secondPlaceCorrectAnswers: correct && result.placement === 2 ? 1 : 0,
    thirdPlaceCorrectAnswers: correct && result.placement === 3 ? 1 : 0,
    cumulativeCorrectResponseTimeMs: correct ? result.responseDurationMs ?? 0 : 0,
  };
}

export function addScores(left: MultiplayerScore, right: MultiplayerScore): MultiplayerScore {
  return {
    correctAnswers: left.correctAnswers + right.correctAnswers,
    totalPoints: left.totalPoints + right.totalPoints,
    firstPlaceCorrectAnswers: left.firstPlaceCorrectAnswers + right.firstPlaceCorrectAnswers,
    secondPlaceCorrectAnswers: left.secondPlaceCorrectAnswers + right.secondPlaceCorrectAnswers,
    thirdPlaceCorrectAnswers: left.thirdPlaceCorrectAnswers + right.thirdPlaceCorrectAnswers,
    cumulativeCorrectResponseTimeMs: left.cumulativeCorrectResponseTimeMs + right.cumulativeCorrectResponseTimeMs,
  };
}

/**
 * The single podium comparator, shared by the live scoreboard, live podium and
 * final podium. Negative means `left` ranks ahead of `right`; 0 is a real tie.
 */
export function compareScores(left: MultiplayerScore, right: MultiplayerScore): number {
  return (
    right.correctAnswers - left.correctAnswers
    || right.totalPoints - left.totalPoints
    || right.firstPlaceCorrectAnswers - left.firstPlaceCorrectAnswers
    || right.secondPlaceCorrectAnswers - left.secondPlaceCorrectAnswers
    || right.thirdPlaceCorrectAnswers - left.thirdPlaceCorrectAnswers
    || left.cumulativeCorrectResponseTimeMs - right.cumulativeCorrectResponseTimeMs
  );
}

/**
 * Orders entries with `compareScores` and assigns competition ranks: entries
 * that tie on every criterion share a rank. Ties are listed by `playerId` so
 * the order is deterministic on every device.
 */
export function rankScores<T extends { playerId: string; score: MultiplayerScore }>(entries: readonly T[]): Array<T & { rank: number }> {
  const sorted = [...entries].sort((left, right) => compareScores(left.score, right.score) || left.playerId.localeCompare(right.playerId));
  let rank = 0;
  return sorted.map((entry, index) => {
    if (index === 0 || compareScores(sorted[index - 1].score, entry.score) !== 0) rank = index + 1;
    return { ...entry, rank };
  });
}
