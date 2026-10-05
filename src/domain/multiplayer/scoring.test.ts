import assert from "node:assert/strict";
import test from "node:test";

import { addScores, calculateQuestionResults, compareScores, rankScores, scoreDelta, type ScorableAnswer } from "./scoring.ts";
import { emptyMultiplayerScore, type MultiplayerScore } from "./types.ts";

const answer = (playerId: string, serverReceivedAtMs: number, isCorrect: boolean): ScorableAnswer => ({
  playerId, isCorrect, serverReceivedAtMs, responseDurationMs: serverReceivedAtMs - 1_000,
});

const points = (results: ReturnType<typeof calculateQuestionResults>) =>
  Object.fromEntries(results.map((result) => [result.playerId, result.pointsAwarded]));

test("correct answers get 1000 plus a 300/200/100/0 speed bonus by server receive order", () => {
  const results = calculateQuestionResults(
    [answer("d", 5_000, true), answer("a", 2_000, true), answer("c", 4_000, true), answer("b", 3_000, true)],
    ["a", "b", "c", "d"],
    100,
  );
  assert.deepEqual(points(results), { a: 1_300, b: 1_200, c: 1_100, d: 1_000 });
  assert.deepEqual(results.map((result) => [result.playerId, result.placement]), [["a", 1], ["b", 2], ["c", 3], ["d", 4]]);
});

test("a fastest incorrect answer gets 0 and does not consume first place; no answer gets 0", () => {
  const results = calculateQuestionResults([answer("a", 1_100, false), answer("b", 2_500, true)], ["a", "b", "c"]);
  const byPlayer = Object.fromEntries(results.map((result) => [result.playerId, result]));
  assert.deepEqual(byPlayer.a, { playerId: "a", answered: true, isCorrect: false, placement: null, pointsAwarded: 0 });
  assert.equal(byPlayer.b.placement, 1);
  assert.equal(byPlayer.b.pointsAwarded, 1_300);
  assert.deepEqual(byPlayer.c, { playerId: "c", answered: false, isCorrect: false, placement: null, pointsAwarded: 0 });
});

test("correct answers inside the 100 ms tie window share placement and bonus (competition ranking)", () => {
  const results = calculateQuestionResults(
    [answer("a", 1_000, true), answer("b", 1_100, true), answer("c", 1_101, true), answer("d", 1_200, true)],
    ["a", "b", "c", "d"],
    100,
  );
  assert.deepEqual(results.map((result) => [result.playerId, result.placement, result.pointsAwarded]), [
    ["a", 1, 1_300],
    ["b", 1, 1_300],
    ["c", 3, 1_100],
    ["d", 3, 1_100],
  ]);
  // A zero window never ties distinct timestamps.
  assert.deepEqual(calculateQuestionResults([answer("a", 1_000, true), answer("b", 1_001, true)], ["a", "b"], 0).map((result) => result.placement), [1, 2]);
});

test("score deltas count placements and only correct response time", () => {
  const [first, wrong] = calculateQuestionResults([answer("a", 1_500, true), answer("b", 1_200, false)], ["a", "b"]);
  assert.deepEqual(scoreDelta(first), {
    correctAnswers: 1, totalPoints: 1_300, firstPlaceCorrectAnswers: 1, secondPlaceCorrectAnswers: 0, thirdPlaceCorrectAnswers: 0, cumulativeCorrectResponseTimeMs: 500,
  });
  assert.deepEqual(scoreDelta(wrong), emptyMultiplayerScore());
  assert.deepEqual(addScores(scoreDelta(first), scoreDelta(first)).totalPoints, 2_600);
});

const score = (overrides: Partial<MultiplayerScore>): MultiplayerScore => ({ ...emptyMultiplayerScore(), ...overrides });

test("the podium comparator applies accuracy, points, 1st/2nd/3rd places, then lower cumulative time", () => {
  const criteria: Array<[Partial<MultiplayerScore>, Partial<MultiplayerScore>]> = [
    // More correct answers wins even with fewer points (accuracy > speed).
    [{ correctAnswers: 3, totalPoints: 3_000 }, { correctAnswers: 2, totalPoints: 2_600 }],
    [{ correctAnswers: 2, totalPoints: 2_500 }, { correctAnswers: 2, totalPoints: 2_400 }],
    [{ correctAnswers: 2, totalPoints: 2_400, firstPlaceCorrectAnswers: 1 }, { correctAnswers: 2, totalPoints: 2_400 }],
    [{ correctAnswers: 2, totalPoints: 2_400, secondPlaceCorrectAnswers: 2 }, { correctAnswers: 2, totalPoints: 2_400, secondPlaceCorrectAnswers: 1 }],
    [{ correctAnswers: 2, totalPoints: 2_400, thirdPlaceCorrectAnswers: 1 }, { correctAnswers: 2, totalPoints: 2_400 }],
    [{ correctAnswers: 2, totalPoints: 2_000, cumulativeCorrectResponseTimeMs: 5_000 }, { correctAnswers: 2, totalPoints: 2_000, cumulativeCorrectResponseTimeMs: 5_001 }],
  ];
  for (const [better, worse] of criteria) {
    assert.ok(compareScores(score(better), score(worse)) < 0, JSON.stringify(better));
    assert.ok(compareScores(score(worse), score(better)) > 0, JSON.stringify(worse));
  }
});

test("a fast guesser with fewer correct answers does not win", () => {
  const ranked = rankScores([
    { playerId: "fast", score: score({ correctAnswers: 1, totalPoints: 1_300, firstPlaceCorrectAnswers: 1, cumulativeCorrectResponseTimeMs: 900 }) },
    { playerId: "accurate", score: score({ correctAnswers: 2, totalPoints: 2_000, cumulativeCorrectResponseTimeMs: 20_000 }) },
  ]);
  assert.deepEqual(ranked.map((entry) => [entry.playerId, entry.rank]), [["accurate", 1], ["fast", 2]]);
});

test("identical scores are a real tie: shared rank, deterministic order", () => {
  const same = score({ correctAnswers: 2, totalPoints: 2_400, firstPlaceCorrectAnswers: 1, cumulativeCorrectResponseTimeMs: 3_000 });
  const ranked = rankScores([
    { playerId: "zoe", score: same },
    { playerId: "low", score: score({ correctAnswers: 1, totalPoints: 1_000 }) },
    { playerId: "max", score: same },
  ]);
  assert.deepEqual(ranked.map((entry) => [entry.playerId, entry.rank]), [["max", 1], ["zoe", 1], ["low", 3]]);
  assert.equal(compareScores(same, { ...same }), 0);
});
