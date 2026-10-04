import assert from "node:assert/strict";
import test from "node:test";

import { QuestionAudioController, type QuestionAudioStatus } from "./questionAudio.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture(fetchAudio = async () => ({ audioUrl: "https://signed.example/a.mp3", expiresAt: "2026-10-03T12:15:00.000Z" })) {
  const statuses: QuestionAudioStatus[] = [];
  const fetches: string[] = [];
  const played: string[] = [];
  let stops = 0;
  let playFailure: Error | undefined;
  let clock = Date.parse("2026-10-03T12:00:00.000Z");
  const controller = new QuestionAudioController({
    fetchAudio: async (gameId, questionId) => {
      fetches.push(`${gameId}/${questionId}`);
      return fetchAudio();
    },
    player: {
      play: async (url) => {
        if (playFailure) throw playFailure;
        played.push(url);
      },
      stop: () => { stops += 1; },
    },
    onStatusChange: (status) => statuses.push(status),
    now: () => clock,
  });
  return {
    controller,
    statuses,
    fetches,
    played,
    stops: () => stops,
    failPlayback: (error: Error | undefined) => { playFailure = error; },
    advance: (ms: number) => { clock += ms; },
  };
}

test("never autoplays: creating or resetting the controller requests and plays nothing", () => {
  const { controller, fetches, played } = fixture();
  controller.reset();
  assert.deepEqual(fetches, []);
  assert.deepEqual(played, []);
});

test("listen requests the audio once, shows loading, then plays", async () => {
  const { controller, statuses, fetches, played } = fixture();
  await controller.listen("animals", "animals-easy-1");
  assert.deepEqual(fetches, ["animals/animals-easy-1"]);
  assert.deepEqual(played, ["https://signed.example/a.mp3"]);
  assert.deepEqual(statuses, ["loading", "playing"]);
  controller.ended();
  assert.equal(controller.currentStatus, "idle");
});

test("rapid repeated clicks while loading do not send duplicate requests", async () => {
  const pending = deferred<{ audioUrl: string; expiresAt: string }>();
  const { controller, fetches, played } = fixture(() => pending.promise);
  const first = controller.listen("g", "q");
  await controller.listen("g", "q");
  await controller.listen("g", "q");
  pending.resolve({ audioUrl: "https://signed.example/a.mp3", expiresAt: "2026-10-03T12:15:00.000Z" });
  await first;
  assert.equal(fetches.length, 1);
  assert.equal(played.length, 1);
});

test("replay reuses the still-valid URL without another request, restarting playback", async () => {
  const { controller, fetches, played, stops } = fixture();
  await controller.listen("g", "q");
  await controller.listen("g", "q");
  assert.equal(fetches.length, 1);
  assert.equal(played.length, 2);
  assert.equal(stops(), 2, "any previous playback is stopped first (no overlapping audio)");
});

test("an expiring URL is refreshed before replay", async () => {
  const { controller, fetches, advance } = fixture();
  await controller.listen("g", "q");
  advance(14 * 60_000 + 45_000);
  await controller.listen("g", "q");
  assert.equal(fetches.length, 2);
});

test("API or playback failures surface as a non-throwing error status and can be retried", async () => {
  let fail = true;
  const { controller, statuses, fetches, failPlayback } = fixture(async () => {
    if (fail) throw new Error("QUESTION_AUDIO_FAILED");
    return { audioUrl: "https://signed.example/a.mp3", expiresAt: "2026-10-03T12:15:00.000Z" };
  });
  await controller.listen("g", "q");
  assert.equal(controller.currentStatus, "error");

  fail = false;
  failPlayback(new Error("NotAllowedError"));
  await controller.listen("g", "q");
  assert.equal(controller.currentStatus, "error");

  failPlayback(undefined);
  await controller.listen("g", "q");
  assert.equal(controller.currentStatus, "playing");
  assert.equal(fetches.length, 3, "a URL that failed to play is not reused");
  assert.deepEqual(statuses, ["loading", "error", "loading", "playing", "error", "loading", "playing"]);
});

test("changing question cancels pending audio so stale audio never plays", async () => {
  const pending = deferred<{ audioUrl: string; expiresAt: string }>();
  const { controller, played } = fixture(() => pending.promise);
  const listening = controller.listen("g", "q1");
  controller.reset();
  pending.resolve({ audioUrl: "https://signed.example/old.mp3", expiresAt: "2026-10-03T12:15:00.000Z" });
  await listening;
  assert.deepEqual(played, []);
  assert.equal(controller.currentStatus, "idle");
});
