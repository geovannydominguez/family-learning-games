import assert from "node:assert/strict";
import test from "node:test";

import {
  ExecutionBudget,
  defaultExecutionBudgetPolicy,
  estimatedGeneratorMs,
  estimatedValidatorMs,
  latencyFactor,
} from "./executionBudget.ts";

test("the default policy is the fixed + per-question envelope from the controlled measurement", () => {
  assert.deepEqual(defaultExecutionBudgetPolicy, {
    safetyMarginMs: 1_000,
    generatorFixedMs: 3_000,
    generatorPerQuestionMs: 1_200,
    validatorFixedMs: 3_000,
    validatorPerQuestionMs: 450,
  });
});

test("generator and validator estimates scale with the batch size", () => {
  assert.equal(estimatedGeneratorMs(1), 4_200);
  assert.equal(estimatedGeneratorMs(2), 5_400);
  assert.equal(estimatedGeneratorMs(3), 6_600);
  assert.equal(estimatedGeneratorMs(5), 9_000);
  assert.equal(estimatedGeneratorMs(10), 15_000);
  assert.equal(estimatedValidatorMs(1), 3_450);
  assert.equal(estimatedValidatorMs(2), 3_900);
  assert.equal(estimatedValidatorMs(3), 4_350);
  assert.equal(estimatedValidatorMs(5), 5_250);
  assert.equal(estimatedValidatorMs(10), 7_500);
});

test("the envelopes cover every maximum observed in the live measurement", () => {
  const observedMaxima = [
    { batchSize: 1, generator: 4_083, validator: 2_967 },
    { batchSize: 2, generator: 5_215, validator: 2_242 },
    { batchSize: 3, generator: 6_363, validator: 3_588 },
    { batchSize: 5, generator: 8_704, validator: 5_219 },
    { batchSize: 10, generator: 13_315, validator: 6_034 },
  ];
  for (const { batchSize, generator, validator } of observedMaxima) {
    assert.ok(estimatedGeneratorMs(batchSize) >= generator, `generator envelope below observed max for ${batchSize}`);
    assert.ok(estimatedValidatorMs(batchSize) >= validator, `validator envelope below observed max for ${batchSize}`);
  }
});

test("required time: generate = generator + validator + margin; validate = validator + margin", () => {
  const budget = new ExecutionBudget(() => 0);
  assert.equal(budget.requiredTimeMs("generate", 1), 8_650);
  assert.equal(budget.requiredTimeMs("generate", 2), 10_300);
  assert.equal(budget.requiredTimeMs("generate", 3), 11_950);
  assert.equal(budget.requiredTimeMs("generate", 5), 15_250);
  assert.equal(budget.requiredTimeMs("generate", 10), 23_500);
  assert.equal(budget.requiredTimeMs("validate", 1), 4_450);
  assert.equal(budget.requiredTimeMs("validate", 10), 8_500);
});

test("without a remaining-time source every operation is allowed", () => {
  const budget = new ExecutionBudget(undefined);
  assert.deepEqual(budget.check("generate", 10), { sufficient: true });
  assert.deepEqual(budget.check("validate", 10), { sufficient: true });
});

test("the check compares the remaining time against the batch-size estimate", () => {
  let remaining = 8_650;
  const budget = new ExecutionBudget(() => remaining);

  assert.deepEqual(budget.check("generate", 1), { sufficient: true });
  remaining = 8_649;
  assert.deepEqual(budget.check("generate", 1), { sufficient: false, remainingTimeMs: 8_649, requiredTimeMs: 8_650 });
  assert.deepEqual(budget.check("validate", 1), { sufficient: true });
});

test("the latency factor is never below 1", () => {
  assert.equal(latencyFactor(1_000, 15_000), 1);
  assert.equal(latencyFactor(Number.NaN, 15_000), 1);
  assert.equal(latencyFactor(-5, 15_000), 1);
  assert.equal(latencyFactor(10_000, 0), 1);
  assert.equal(latencyFactor(18_000, 15_000), 1.2);
});

test("a faster-than-baseline round does not shrink later estimates", () => {
  const budget = new ExecutionBudget(() => 0);
  budget.recordGenerator(12_000, 10);
  budget.recordValidator(3_000, 10);
  assert.equal(budget.requiredTimeMs("generate", 1), 8_650);
});

test("a slower-than-baseline round raises the factor for its own role, using the real batch size", () => {
  const budget = new ExecutionBudget(() => 0);
  budget.recordGenerator(18_000, 10); // 18 000 / 15 000 → ×1.2
  assert.equal(budget.requiredTimeMs("generate", 1), Math.ceil(4_200 * 1.2 + 3_450 + 1_000));
  budget.recordValidator(9_000, 10); // 9 000 / 7 500 → ×1.2
  assert.equal(budget.requiredTimeMs("validate", 1), Math.ceil(3_450 * 1.2 + 1_000));

  // The factor is relative to the batch the duration was measured on, not a fixed 10.
  const small = new ExecutionBudget(() => 0);
  small.recordGenerator(8_400, 1); // 8 400 / 4 200 → ×2
  assert.equal(small.requiredTimeMs("generate", 2), Math.ceil(5_400 * 2 + 3_900 + 1_000));
});

test("the factor only grows within one operation", () => {
  const budget = new ExecutionBudget(() => 0);
  budget.recordGenerator(18_000, 10); // ×1.2
  budget.recordGenerator(4_000, 1); // faster: stays ×1.2
  assert.equal(budget.requiredTimeMs("generate", 1), Math.ceil(4_200 * 1.2 + 3_450 + 1_000));
});

test("a non-finite remaining time never blocks generation", () => {
  assert.deepEqual(new ExecutionBudget(() => Number.NaN).check("generate", 10), { sufficient: true });
});
