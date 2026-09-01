import assert from "node:assert/strict";
import test from "node:test";

import { GameApiClient, GameApiError } from "./GameApiClient.ts";

test("invokes an injected fetcher with the global receiver", async () => {
  const receiverSensitiveFetcher: typeof fetch = async function (input, init) {
    if (this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }

    return new Response(JSON.stringify({ input: String(input), method: init?.method }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const client = new GameApiClient("https://api.example.com", receiverSensitiveFetcher);

  assert.deepEqual(await client.getSetup(), {
    input: "https://api.example.com/game-setup",
    method: "GET",
  });
});

test("normalizes the base URL and sends the expected methods and bodies", async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify({ players: [], categories: [], difficulties: ["easy", "normal", "hard"] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new GameApiClient("https://api.example.com/", fetcher);
  await client.getSetup();
  assert.equal(requests[0].input, "https://api.example.com/game-setup");
  assert.equal(requests[0].init?.method, "GET");

  const startFetcher: typeof fetch = async (input, init) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify({ id: "s" }), { status: 201, headers: { "content-type": "application/json" } });
  };
  await new GameApiClient("https://api.example.com", startFetcher).startSession({ playerId: "p", categoryId: "c", difficulty: "easy" });
  assert.equal(requests[1].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), { playerId: "p", categoryId: "c", difficulty: "easy" });

  await new GameApiClient("https://api.example.com/", startFetcher).answerSession("session/id", "answer-1");
  assert.equal(requests[2].input, "https://api.example.com/game-sessions/session%2Fid/answers");
  assert.deepEqual(JSON.parse(String(requests[2].init?.body)), { answerId: "answer-1" });
});

test("requires a configured URL and translates API, network and invalid JSON failures", async () => {
  assert.throws(() => new GameApiClient(""), /NEXT_PUBLIC_GAME_API_BASE_URL/);
  const api = new GameApiClient("https://api.example.com", async () => new Response(JSON.stringify({ error: { code: "SESSION_NOT_FOUND", message: "Lost" } }), { status: 404 }));
  await assert.rejects(api.answerSession("s", "a"), (error: unknown) => error instanceof GameApiError && error.code === "SESSION_NOT_FOUND" && error.status === 404);
  const networkCause = new TypeError("offline");
  const network = new GameApiClient("https://api.example.com", async () => { throw networkCause; });
  await assert.rejects(
    network.getSetup(),
    (error: unknown) => error instanceof GameApiError
      && error.code === "NETWORK_ERROR"
      && error.cause === networkCause,
  );
  const invalid = new GameApiClient("https://api.example.com", async () => new Response("not-json", { status: 200 }));
  await assert.rejects(invalid.getSetup(), (error: unknown) => error instanceof GameApiError && error.code === "INVALID_RESPONSE");
});
