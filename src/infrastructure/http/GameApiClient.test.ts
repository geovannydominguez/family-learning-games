import assert from "node:assert/strict";
import test from "node:test";

import { GameApiClient, GameApiError } from "./GameApiClient.ts";

test("invokes an injected fetcher with the global receiver", async () => {
  const receiverSensitiveFetcher: typeof fetch = async function (this: typeof globalThis, input, init) {
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
  await new GameApiClient("https://api.example.com", startFetcher).startSession({ playerId: "p", categoryId: "c", gameId: "ai-c-1", difficulty: "easy" });
  assert.equal(requests[1].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), { playerId: "p", categoryId: "c", gameId: "ai-c-1", difficulty: "easy" });

  await new GameApiClient("https://api.example.com", startFetcher).startSession({ playerId: "p", categoryId: "c", difficulty: "easy" });
  assert.deepEqual(JSON.parse(String(requests[2].init?.body)), { playerId: "p", categoryId: "c", difficulty: "easy" });

  await new GameApiClient("https://api.example.com/", startFetcher).answerSession("session/id", "answer-1");
  assert.equal(requests[3].input, "https://api.example.com/game-sessions/session%2Fid/answers");
  assert.deepEqual(JSON.parse(String(requests[3].init?.body)), { answerId: "answer-1" });
});

test("generates games and surfaces throttling without automatic retry", async () => {
  let calls = 0;
  const success = new GameApiClient("https://api.example.com", async (input, init) => {
    calls += 1;
    assert.equal(String(input), "https://api.example.com/games/generate");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { topic: "animals", difficulty: "easy", questionCount: 10, playerId: "amelia" });
    return new Response(JSON.stringify({ id: "ai-animals-1", questions: [] }), { status: 201 });
  });
  assert.equal((await success.generateGame({ topic: "animals", difficulty: "easy", questionCount: 10, playerId: "amelia" })).id, "ai-animals-1");

  const throttled = new GameApiClient("https://api.example.com", async () => {
    calls += 1;
    return new Response(JSON.stringify({}), { status: 429 });
  });
  await assert.rejects(
    throttled.generateGame({ topic: "animals", difficulty: "easy", questionCount: 10, playerId: "amelia" }),
    (error: unknown) => error instanceof GameApiError
      && error.code === "RATE_LIMITED"
      && error.status === 429
      && error.message === "Too many generation requests. Try again later.",
  );
  assert.equal(calls, 2);
});

test("lists games with a GET request and returns the catalog as-is", async () => {
  const requests: Array<{ input: string; method?: string }> = [];
  const catalog = [
    { id: "animals", title: "Animales", category: { id: "animals", name: "Animales", description: "d", icon: "🐼" }, difficulties: ["easy"], questions: [] },
    { id: "ai-pokemon-1", title: "Pokémon", category: { id: "pokemon", name: "Pokémon", description: "d", icon: "🎮" }, difficulties: ["hard"], questions: [] },
  ];
  const client = new GameApiClient("https://api.example.com", async (input, init) => {
    requests.push({ input: String(input), method: init?.method });
    return new Response(JSON.stringify(catalog), { status: 200, headers: { "content-type": "application/json" } });
  });

  const games = await client.listGames();

  assert.equal(requests[0].input, "https://api.example.com/games");
  assert.equal(requests[0].method, "GET");
  assert.deepEqual(games.map((game) => game.id), ["animals", "ai-pokemon-1"]);
});

test("starts a session for a persisted ai game by sending its exact gameId", async () => {
  const requests: Array<{ input: string; body: unknown }> = [];
  const client = new GameApiClient("https://api.example.com", async (input, init) => {
    requests.push({ input: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ id: "session-1" }), { status: 201, headers: { "content-type": "application/json" } });
  });

  await client.startSession({ playerId: "joaquin", categoryId: "pokemon", gameId: "ai-pokemon-1", difficulty: "hard" });

  assert.equal(requests[0].input, "https://api.example.com/game-sessions");
  assert.deepEqual(requests[0].body, { playerId: "joaquin", categoryId: "pokemon", gameId: "ai-pokemon-1", difficulty: "hard" });
});

test("maps a non-JSON 429 response without retrying", async () => {
  let calls = 0;
  const client = new GameApiClient("https://api.example.com", async () => {
    calls += 1;
    return new Response("Too Many Requests", { status: 429 });
  });

  await assert.rejects(
    client.generateGame({ topic: "animals", difficulty: "easy", questionCount: 10, playerId: "amelia" }),
    (error: unknown) => error instanceof GameApiError
      && error.code === "RATE_LIMITED"
      && error.status === 429,
  );
  assert.equal(calls, 1);
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

test("listPlayers unwraps the players envelope from GET /players", async () => {
  const requests: Array<{ input: string; method?: string }> = [];
  const players = [{ playerId: "amelia", name: "Amelia", age: 4, createdAt: "t", updatedAt: "t" }];
  const client = new GameApiClient("https://api.example.com", async (input, init) => {
    requests.push({ input: String(input), method: init?.method });
    return new Response(JSON.stringify({ players }), { status: 200, headers: { "content-type": "application/json" } });
  });

  assert.deepEqual(await client.listPlayers(), players);
  assert.equal(requests[0].input, "https://api.example.com/players");
  assert.equal(requests[0].method, "GET");
});

test("createPlayer, updatePlayer and deletePlayer send the expected requests", async () => {
  const requests: Array<{ input: string; method?: string; body?: unknown }> = [];
  const client = new GameApiClient("https://api.example.com", async (input, init) => {
    requests.push({ input: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ playerId: "amelia", name: "Amelia", age: 4, createdAt: "t", updatedAt: "t" }), { status: 200, headers: { "content-type": "application/json" } });
  });

  await client.createPlayer({ name: "Amelia", age: 4 });
  assert.equal(requests[0].input, "https://api.example.com/players");
  assert.equal(requests[0].method, "POST");
  assert.deepEqual(requests[0].body, { name: "Amelia", age: 4 });

  await client.updatePlayer("amelia", { name: "Amelia Rose", age: 5 });
  assert.equal(requests[1].input, "https://api.example.com/players/amelia");
  assert.equal(requests[1].method, "PUT");
  assert.deepEqual(requests[1].body, { name: "Amelia Rose", age: 5 });

  await client.deletePlayer("amelia");
  assert.equal(requests[2].input, "https://api.example.com/players/amelia");
  assert.equal(requests[2].method, "DELETE");
});
