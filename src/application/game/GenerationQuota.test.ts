import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryGenerationQuota } from "../../infrastructure/repositories/InMemoryGenerationQuota.ts";
import {
  DailyGenerationQuota,
  localDateKey,
  nextLocalMidnightMs,
  readGenerationDailyLimit,
  readGenerationQuotaTimeZone,
  type GenerationQuota,
} from "./GenerationQuota.ts";

const guayaquil = "America/Guayaquil";
const at = (iso: string) => Date.parse(iso);

function quotaWith(store: GenerationQuota, dailyLimit: number, clock: { now: number }) {
  return new DailyGenerationQuota({ store, dailyLimit, timeZone: guayaquil, now: () => clock.now });
}

test("the quota day follows America/Guayaquil (UTC-5), not UTC", () => {
  assert.equal(localDateKey(at("2026-11-14T04:59:59.999Z"), guayaquil), "2026-11-13");
  assert.equal(localDateKey(at("2026-11-14T05:00:00.000Z"), guayaquil), "2026-11-14");
  assert.equal(localDateKey(at("2026-01-01T03:00:00.000Z"), guayaquil), "2025-12-31");
  assert.equal(nextLocalMidnightMs(at("2026-11-13T20:00:00.000Z"), guayaquil), at("2026-11-14T05:00:00.000Z"));
  assert.equal(nextLocalMidnightMs(at("2026-11-14T04:59:59.999Z"), guayaquil), at("2026-11-14T05:00:00.000Z"));
});

test("the next local midnight is DST-aware for any IANA zone", () => {
  // America/New_York: 2026-03-08 springs forward (EST→EDT), 2026-11-01 falls back.
  assert.equal(nextLocalMidnightMs(at("2026-03-08T12:00:00.000Z"), "America/New_York"), at("2026-03-09T04:00:00.000Z"));
  assert.equal(nextLocalMidnightMs(at("2026-11-01T12:00:00.000Z"), "America/New_York"), at("2026-11-02T05:00:00.000Z"));
  assert.equal(nextLocalMidnightMs(at("2026-06-01T12:00:00.000Z"), "Asia/Kolkata"), at("2026-06-01T18:30:00.000Z"));
});

test("first reservation of the day is admitted and carries a TTL after the period ends", async () => {
  const store = new InMemoryGenerationQuota();
  const clock = { now: at("2026-11-13T15:00:00.000Z") };
  const decision = await quotaWith(store, 20, clock).reserve();

  assert.deepEqual(decision, { allowed: true, periodKey: "2026-11-13", used: 1, limit: 20 });
  assert.equal(store.requests.length, 1);
  assert.equal(store.requests[0].periodKey, "2026-11-13");
  assert.equal(store.requests[0].limit, 20);
  assert.ok(store.requests[0].expiresAtEpochSeconds > at("2026-11-14T05:00:00.000Z") / 1000);
});

test("the last unit is admitted, the next request is rejected with seconds until local midnight", async () => {
  const store = new InMemoryGenerationQuota();
  const clock = { now: at("2026-11-13T15:00:00.000Z") }; // 10:00 in Guayaquil
  const quota = quotaWith(store, 3, clock);

  for (let index = 1; index <= 3; index += 1) {
    const decision = await quota.reserve();
    assert.equal(decision.allowed, true);
    if (decision.allowed) assert.equal(decision.used, index);
  }
  const rejected = await quota.reserve();
  assert.equal(rejected.allowed, false);
  if (!rejected.allowed) {
    assert.equal(rejected.periodKey, "2026-11-13");
    assert.equal(rejected.resetsAtMs, at("2026-11-14T05:00:00.000Z"));
    assert.equal(rejected.retryAfterSeconds, 14 * 60 * 60);
  }
  // Further rejections never add units.
  await quota.reserve();
  assert.equal(store.used("2026-11-13"), 3);
});

test("a new local day uses a new period key even if the previous item still exists", async () => {
  const store = new InMemoryGenerationQuota();
  const clock = { now: at("2026-11-14T04:59:00.000Z") }; // 23:59 on the 13th, local
  const quota = quotaWith(store, 1, clock);

  assert.equal((await quota.reserve()).allowed, true);
  assert.equal((await quota.reserve()).allowed, false);
  clock.now = at("2026-11-14T05:00:00.000Z"); // 00:00 on the 14th, local
  const next = await quota.reserve();
  assert.deepEqual(next, { allowed: true, periodKey: "2026-11-14", used: 1, limit: 1 });
  assert.equal(store.used("2026-11-13"), 1);
});

test("concurrent reservations never exceed the limit", async () => {
  const store = new InMemoryGenerationQuota();
  const quota = quotaWith(store, 20, { now: at("2026-11-13T15:00:00.000Z") });

  const decisions = await Promise.all(Array.from({ length: 60 }, () => quota.reserve()));
  assert.equal(decisions.filter((decision) => decision.allowed).length, 20);
  assert.equal(store.used("2026-11-13"), 20);
});

test("a limit of 0 rejects without touching storage", async () => {
  const store = new InMemoryGenerationQuota();
  const decision = await quotaWith(store, 0, { now: at("2026-11-13T15:00:00.000Z") }).reserve();
  assert.equal(decision.allowed, false);
  assert.equal(store.requests.length, 0);
});

test("a storage failure propagates (the caller fails closed)", async () => {
  const failing: GenerationQuota = { reserve: async () => { throw new Error("dynamodb down"); } };
  await assert.rejects(quotaWith(failing, 20, { now: Date.now() }).reserve(), /dynamodb down/);
});

test("configuration is validated: integer 0..1000 and a real IANA zone", () => {
  assert.equal(readGenerationDailyLimit("20"), 20);
  assert.equal(readGenerationDailyLimit(0), 0);
  for (const invalid of ["", "-1", "2.5", "1001", "abc", undefined, null]) {
    assert.throws(() => readGenerationDailyLimit(invalid), /daily limit/);
  }
  assert.equal(readGenerationQuotaTimeZone(" America/Guayaquil "), guayaquil);
  for (const invalid of ["", "Mars/Olympus", 5, undefined]) {
    assert.throws(() => readGenerationQuotaTimeZone(invalid), /time zone/);
  }
});
