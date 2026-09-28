/**
 * ADR-015 execution-budget policy for the synchronous `POST /games/generate`
 * request.
 *
 * Before every expensive AI call, Application checks whether the remaining
 * execution time can still accommodate that call (plus, for a generation, the
 * validation that must follow it) and a safety margin. When it cannot, the
 * operation stops in a controlled way instead of being killed by the Lambda
 * timeout mid-call.
 *
 * Latency is modelled as FIXED + VARIABLE per question, because that is what a
 * controlled live measurement showed (Claude Sonnet 4.6, 15 generator + 15
 * validator calls, batch sizes 1/2/3/5/10; generator ≈ 2.8 s + 1.05 s/question,
 * validator ≈ 1.9 s + 0.33 s/question with more variance). The defaults below
 * are envelopes ABOVE every maximum observed in that measurement. They are
 * experimental evidence for this project, not a Bedrock latency guarantee/SLA.
 *
 * Because the envelopes already absorb the observed variance, the safety margin
 * only has to cover the work after the last AI call (deterministic comparison,
 * answer shuffle, DynamoDB PutItem, serialization, logs) and residual variance.
 *
 * If Bedrock is slower than the baseline in a given request, the observed calls
 * raise a per-role latency factor (never below 1) that scales later estimates.
 */
export interface ExecutionBudgetPolicy {
  safetyMarginMs: number;
  generatorFixedMs: number;
  generatorPerQuestionMs: number;
  validatorFixedMs: number;
  validatorPerQuestionMs: number;
}

export const defaultExecutionBudgetPolicy: Readonly<ExecutionBudgetPolicy> = {
  safetyMarginMs: 1_000,
  generatorFixedMs: 3_000,
  generatorPerQuestionMs: 1_200,
  validatorFixedMs: 3_000,
  validatorPerQuestionMs: 450,
};

/** Baseline generator latency envelope for a batch of `batchSize` questions. */
export function estimatedGeneratorMs(batchSize: number, policy: ExecutionBudgetPolicy = defaultExecutionBudgetPolicy): number {
  return policy.generatorFixedMs + policy.generatorPerQuestionMs * Math.max(0, batchSize);
}

/** Baseline validator latency envelope for a batch of `batchSize` questions. */
export function estimatedValidatorMs(batchSize: number, policy: ExecutionBudgetPolicy = defaultExecutionBudgetPolicy): number {
  return policy.validatorFixedMs + policy.validatorPerQuestionMs * Math.max(0, batchSize);
}

/**
 * How much slower than its baseline envelope a completed call was, never below
 * 1: a faster-than-baseline call never shrinks later estimates.
 */
export function latencyFactor(observedMs: number, estimatedMs: number): number {
  if (!Number.isFinite(observedMs) || observedMs < 0 || !(estimatedMs > 0)) return 1;
  return Math.max(1, observedMs / estimatedMs);
}

export type BudgetedOperation = "generate" | "validate";

export type BudgetCheck =
  | { sufficient: true }
  | { sufficient: false; remainingTimeMs: number; requiredTimeMs: number };

export class ExecutionBudget {
  private readonly remainingTimeMs: (() => number) | undefined;
  private readonly policy: ExecutionBudgetPolicy;
  private generatorFactor = 1;
  private validatorFactor = 1;

  /** Without a `remainingTimeMs` source (local runs, tests) every check passes. */
  constructor(remainingTimeMs: (() => number) | undefined, policy: ExecutionBudgetPolicy = defaultExecutionBudgetPolicy) {
    this.remainingTimeMs = remainingTimeMs;
    this.policy = policy;
  }

  /**
   * Records a generator call that completed and returned content, for the
   * batch size it was actually asked for. The factor only ever grows within one
   * operation, so a slow round keeps later estimates conservative.
   */
  recordGenerator(durationMs: number, batchSize: number): void {
    this.generatorFactor = Math.max(
      this.generatorFactor,
      latencyFactor(durationMs, estimatedGeneratorMs(batchSize, this.policy)),
    );
  }

  /** Records a validator call that completed and returned a review, for its real batch size. */
  recordValidator(durationMs: number, batchSize: number): void {
    this.validatorFactor = Math.max(
      this.validatorFactor,
      latencyFactor(durationMs, estimatedValidatorMs(batchSize, this.policy)),
    );
  }

  /**
   * Time a call on `batchSize` questions needs before it may start. A
   * generation is only worth starting if its output can also be validated, so it
   * must fit generator + validator + margin; a validation must fit validator + margin.
   */
  requiredTimeMs(operation: BudgetedOperation, batchSize: number): number {
    const validator = estimatedValidatorMs(batchSize, this.policy) * this.validatorFactor;
    const generator = operation === "generate" ? estimatedGeneratorMs(batchSize, this.policy) * this.generatorFactor : 0;
    return Math.ceil(generator + validator + this.policy.safetyMarginMs);
  }

  check(operation: BudgetedOperation, batchSize: number): BudgetCheck {
    if (!this.remainingTimeMs) return { sufficient: true };
    const remainingTimeMs = this.remainingTimeMs();
    if (!Number.isFinite(remainingTimeMs)) return { sufficient: true };
    const requiredTimeMs = this.requiredTimeMs(operation, batchSize);
    return remainingTimeMs >= requiredTimeMs
      ? { sufficient: true }
      : { sufficient: false, remainingTimeMs: Math.max(0, Math.floor(remainingTimeMs)), requiredTimeMs };
  }
}
