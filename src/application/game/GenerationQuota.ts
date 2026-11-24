/**
 * v0.9.3 — ADR-021: global daily quota for `POST /games/generate`.
 *
 * The quota counts ADMITTED generation requests: a unit is reserved before the
 * first Bedrock call and is never returned, whatever the outcome (a failed
 * generation also consumed model tokens). It is global on purpose: no
 * client-supplied identifier (`playerId`, origin, …) takes part in it, so it
 * cannot be evaded by creating players.
 *
 * It bounds the number of generations per local day, and therefore (together
 * with the per-request bounds on repair rounds, `maxTokens` and execution time)
 * the number of Bedrock invocations. It is NOT a monetary cap.
 */

/** Storage port: one atomic, conditional reservation of a unit in one period. */
export interface GenerationQuota {
  reserve(reservation: GenerationQuotaReservation): Promise<GenerationQuotaOutcome>;
}

export interface GenerationQuotaReservation {
  /** Local calendar day, `YYYY-MM-DD`, in the configured IANA time zone. */
  periodKey: string;
  /** Maximum admitted requests in the period (≥ 1; 0 never reaches the store). */
  limit: number;
  /** Epoch seconds for TTL cleanup only; never consulted to decide admission. */
  expiresAtEpochSeconds: number;
}

/**
 * `reserved`: this call holds exactly one unit (`used` is the counter after it).
 * `exhausted`: the period already holds `limit` units; nothing was written.
 * Any technical or ambiguous storage failure is thrown, never returned, so the
 * caller fails closed and never invokes Bedrock.
 */
export type GenerationQuotaOutcome =
  | { status: "reserved"; used: number }
  | { status: "exhausted"; used?: number };

export type DailyGenerationQuotaDecision =
  | { allowed: true; periodKey: string; used: number; limit: number }
  | { allowed: false; periodKey: string; limit: number; resetsAtMs: number; retryAfterSeconds: number };

export const defaultGenerationDailyLimit = 20;
export const defaultGenerationQuotaTimeZone = "America/Guayaquil";
/** Upper bound keeps the per-day reservation set far below the 400 KB item limit. */
export const maxGenerationDailyLimit = 1_000;
/** TTL slack after the period ends. Cleanup only: a stale item never blocks a new day. */
const expirationSlackSeconds = 2 * 24 * 60 * 60;

export interface DailyGenerationQuotaOptions {
  store: GenerationQuota;
  dailyLimit: number;
  timeZone: string;
  now?: () => number;
}

/** Application policy: computes the local-day period and asks the store for one unit. */
export class DailyGenerationQuota {
  readonly dailyLimit: number;
  readonly timeZone: string;
  private readonly store: GenerationQuota;
  private readonly now: () => number;

  constructor(options: DailyGenerationQuotaOptions) {
    this.dailyLimit = readGenerationDailyLimit(options.dailyLimit);
    this.timeZone = readGenerationQuotaTimeZone(options.timeZone);
    this.store = options.store;
    this.now = options.now ?? Date.now;
  }

  async reserve(): Promise<DailyGenerationQuotaDecision> {
    const nowMs = this.now();
    const periodKey = localDateKey(nowMs, this.timeZone);
    const resetsAtMs = nextLocalMidnightMs(nowMs, this.timeZone);
    const rejected = (): DailyGenerationQuotaDecision => ({
      allowed: false,
      periodKey,
      limit: this.dailyLimit,
      resetsAtMs,
      retryAfterSeconds: Math.max(1, Math.ceil((resetsAtMs - nowMs) / 1000)),
    });
    // A limit of 0 disables generation without touching storage.
    if (this.dailyLimit === 0) return rejected();
    const outcome = await this.store.reserve({
      periodKey,
      limit: this.dailyLimit,
      expiresAtEpochSeconds: Math.floor(resetsAtMs / 1000) + expirationSlackSeconds,
    });
    if (outcome.status === "exhausted") return rejected();
    return { allowed: true, periodKey, used: outcome.used, limit: this.dailyLimit };
  }
}

export function readGenerationDailyLimit(value: unknown): number {
  const parsed = typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maxGenerationDailyLimit) {
    throw new Error(`AI generation daily limit must be an integer between 0 and ${maxGenerationDailyLimit}.`);
  }
  return parsed;
}

export function readGenerationQuotaTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("AI generation quota time zone is required.");
  const timeZone = value.trim();
  try {
    dateFormatter(timeZone);
  } catch {
    throw new Error("AI generation quota time zone must be a valid IANA time zone.");
  }
  return timeZone;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // Throws RangeError for an unknown IANA zone.
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Local calendar date (`YYYY-MM-DD`) of an instant in an IANA time zone (DST-aware via Intl). */
export function localDateKey(epochMs: number, timeZone: string): string {
  const parts = dateFormatter(timeZone).formatToParts(new Date(epochMs));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * First instant (epoch ms) whose local date differs from the local date of
 * `epochMs`. Found by bisection over the next 48 h, so it holds for any IANA
 * zone, including DST transitions and non-hour offsets.
 */
export function nextLocalMidnightMs(epochMs: number, timeZone: string): number {
  const today = localDateKey(epochMs, timeZone);
  let low = epochMs;
  let high = epochMs + 48 * 60 * 60 * 1000;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDateKey(middle, timeZone) === today) low = middle;
    else high = middle;
  }
  return high;
}
