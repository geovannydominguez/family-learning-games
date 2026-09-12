import assert from "node:assert/strict";
import { test } from "node:test";

import { registerServiceWorker, shouldRegisterServiceWorker } from "./registerServiceWorker.ts";

test("shouldRegisterServiceWorker requires both production and browser support", () => {
  assert.equal(shouldRegisterServiceWorker({ isProduction: true, hasServiceWorkerSupport: true }), true);
  assert.equal(shouldRegisterServiceWorker({ isProduction: false, hasServiceWorkerSupport: true }), false);
  assert.equal(shouldRegisterServiceWorker({ isProduction: true, hasServiceWorkerSupport: false }), false);
  assert.equal(shouldRegisterServiceWorker({ isProduction: false, hasServiceWorkerSupport: false }), false);
});

test("registerServiceWorker skips outside production without calling register", async () => {
  let calls = 0;
  const outcome = await registerServiceWorker(
    { isProduction: false, hasServiceWorkerSupport: true },
    async () => {
      calls += 1;
      return undefined;
    },
  );
  assert.equal(outcome, "skipped");
  assert.equal(calls, 0);
});

test("registerServiceWorker skips when the browser has no Service Worker support", async () => {
  let calls = 0;
  const outcome = await registerServiceWorker(
    { isProduction: true, hasServiceWorkerSupport: false },
    async () => {
      calls += 1;
      return undefined;
    },
  );
  assert.equal(outcome, "skipped");
  assert.equal(calls, 0);
});

test("registerServiceWorker registers /sw.js in production when supported", async () => {
  const requestedUrls: string[] = [];
  const outcome = await registerServiceWorker(
    { isProduction: true, hasServiceWorkerSupport: true },
    async (scriptUrl) => {
      requestedUrls.push(scriptUrl);
      return { scope: "/" };
    },
  );
  assert.equal(outcome, "registered");
  assert.deepEqual(requestedUrls, ["/sw.js"]);
});

test("registerServiceWorker swallows registration failures as a safe no-op", async () => {
  const outcome = await registerServiceWorker(
    { isProduction: true, hasServiceWorkerSupport: true },
    async () => {
      throw new Error("registration refused");
    },
  );
  assert.equal(outcome, "failed");
});
