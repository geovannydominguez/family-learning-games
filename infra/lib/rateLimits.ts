/**
 * v0.9.2 — Infrastructure Rate Limits.
 *
 * One typed, validated source for the API Gateway throttling and DynamoDB
 * on-demand maximum throughput applied by the backend stack. Defaults live
 * here so that `cdk synth` and `cdk deploy` are reproducible without extra
 * flags; a single optional CDK context key, `rateLimits`, overrides any subset:
 *
 *   -c rateLimits='{"webSocket":{"rateLimit":30},"tables":{"multiplayer":{"maxWriteRequestUnits":400}}}'
 *
 * `POST /games/generate` keeps its pre-existing context keys
 * (`generationThrottleRateLimit` / `generationThrottleBurstLimit`), read by the stack.
 *
 * These limits bound request *rates*. They are aggregate (not per client), they
 * are not a spending cap, and they do not guarantee any maximum number of
 * concurrent or daily operations.
 */

export interface ThrottleLimit {
  /** Steady-state requests (messages) per second. May be fractional (e.g. 0.1). */
  rateLimit: number;
  /** Bucket size: requests accepted in a short burst. Positive integer. */
  burstLimit: number;
}

export interface TableThroughputLimit {
  maxReadRequestUnits: number;
  maxWriteRequestUnits: number;
}

/** Exact HTTP API route keys (as created by `api.addRoutes`) that get a route-level override. */
export const httpRouteThrottleKeys = {
  questionAudio: "POST /games/{gameId}/questions/{questionId}/audio",
  createRoom: "POST /multiplayer/rooms",
  joinRoom: "POST /multiplayer/rooms/{roomCode}/join",
} as const;

export type HttpRouteThrottleName = keyof typeof httpRouteThrottleKeys;
export type TableName = "games" | "gameSessions" | "players" | "multiplayer";

export interface RateLimitSettings {
  /** `$default` stage default route settings: every HTTP route without its own override. */
  httpDefault: ThrottleLimit;
  httpRoutes: Record<HttpRouteThrottleName, ThrottleLimit>;
  /** WebSocket `production` stage default route settings (all routes, including `$connect`). */
  webSocket: ThrottleLimit;
  tables: Record<TableName, TableThroughputLimit>;
}

/** Generation defaults (v0.9.2): at most one request every ~10 s on average, no burst beyond one. */
export const defaultGenerationThrottle: ThrottleLimit = { rateLimit: 0.1, burstLimit: 1 };

/**
 * Defaults. Throttling values were approved for v0.9.2. Table values are
 * CANDIDATES sized from code-level access patterns and hourly metrics, still
 * pending validation against per-minute peaks (docs/security/infrastructure-rate-limits-v0.9.2.md).
 */
export const defaultRateLimits: RateLimitSettings = {
  httpDefault: { rateLimit: 10, burstLimit: 20 },
  httpRoutes: {
    questionAudio: { rateLimit: 2, burstLimit: 10 },
    createRoom: { rateLimit: 1, burstLimit: 5 },
    joinRoom: { rateLimit: 2, burstLimit: 10 },
  },
  webSocket: { rateLimit: 20, burstLimit: 40 },
  tables: {
    games: { maxReadRequestUnits: 200, maxWriteRequestUnits: 20 },
    gameSessions: { maxReadRequestUnits: 50, maxWriteRequestUnits: 50 },
    players: { maxReadRequestUnits: 50, maxWriteRequestUnits: 20 },
    multiplayer: { maxReadRequestUnits: 600, maxWriteRequestUnits: 300 },
  },
};

// Sanity ceilings that catch typos: the regional API Gateway account defaults
// (10,000 rps / 5,000 burst) and the default per-table on-demand quota (40,000).
const maxRateLimit = 10_000;
const maxBurstLimit = 5_000;
const maxRequestUnits = 40_000;

const contextKey = "rateLimits";

/** Reads the optional `rateLimits` context (JSON string or object) on top of the defaults. */
export function readRateLimits(value: unknown): RateLimitSettings {
  if (value === undefined) return clone(defaultRateLimits);
  let override: unknown = value;
  if (typeof value === "string") {
    try {
      override = JSON.parse(value);
    } catch {
      throw invalid("expected a JSON object");
    }
  }
  const root = readObject(override, contextKey, ["httpDefault", "httpRoutes", "webSocket", "tables"]);
  const settings = clone(defaultRateLimits);
  if (root.httpDefault !== undefined) settings.httpDefault = readThrottle(root.httpDefault, settings.httpDefault, "httpDefault");
  if (root.httpRoutes !== undefined) {
    const routes = readObject(root.httpRoutes, "httpRoutes", Object.keys(httpRouteThrottleKeys));
    for (const name of Object.keys(routes) as HttpRouteThrottleName[]) {
      settings.httpRoutes[name] = readThrottle(routes[name], settings.httpRoutes[name], `httpRoutes.${name}`);
    }
  }
  if (root.webSocket !== undefined) settings.webSocket = readThrottle(root.webSocket, settings.webSocket, "webSocket");
  if (root.tables !== undefined) {
    const tables = readObject(root.tables, "tables", Object.keys(defaultRateLimits.tables));
    for (const name of Object.keys(tables) as TableName[]) {
      settings.tables[name] = readTableLimit(tables[name], settings.tables[name], `tables.${name}`);
    }
  }
  return settings;
}

function validateThrottle(limit: ThrottleLimit, path: string): ThrottleLimit {
  return {
    rateLimit: readRate(limit.rateLimit, `${path}.rateLimit`),
    burstLimit: readInteger(limit.burstLimit, `${path}.burstLimit`, maxBurstLimit),
  };
}

function readThrottle(value: unknown, base: ThrottleLimit, path: string): ThrottleLimit {
  const record = readObject(value, path, ["rateLimit", "burstLimit"]);
  return validateThrottle({
    rateLimit: (record.rateLimit ?? base.rateLimit) as number,
    burstLimit: (record.burstLimit ?? base.burstLimit) as number,
  }, path);
}

function readTableLimit(value: unknown, base: TableThroughputLimit, path: string): TableThroughputLimit {
  const record = readObject(value, path, ["maxReadRequestUnits", "maxWriteRequestUnits"]);
  return {
    maxReadRequestUnits: readInteger(record.maxReadRequestUnits ?? base.maxReadRequestUnits, `${path}.maxReadRequestUnits`, maxRequestUnits),
    maxWriteRequestUnits: readInteger(record.maxWriteRequestUnits ?? base.maxWriteRequestUnits, `${path}.maxWriteRequestUnits`, maxRequestUnits),
  };
}

function readObject(value: unknown, path: string, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${path} must be an object`);
  const record = value as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.includes(key));
  if (unknownKey) throw invalid(`unknown key ${path === contextKey ? "" : `${path}.`}${unknownKey}`);
  return record;
}

function readRate(value: unknown, path: string): number {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maxRateLimit) {
    throw invalid(`${path} must be a positive number up to ${maxRateLimit}`);
  }
  return parsed;
}

function readInteger(value: unknown, path: string, max: number): number {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw invalid(`${path} must be an integer between 1 and ${max}`);
  return parsed;
}

function invalid(detail: string): Error {
  return new Error(`Invalid CDK context ${contextKey}: ${detail}.`);
}

function clone(settings: RateLimitSettings): RateLimitSettings {
  return JSON.parse(JSON.stringify(settings)) as RateLimitSettings;
}
