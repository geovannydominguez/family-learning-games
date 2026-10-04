import assert from "node:assert/strict";
import test from "node:test";

import type { Game, Question } from "../../domain/game/types.ts";
import { MockGameRepository } from "../../repositories/game/MockGameRepository.ts";
import { ApplicationError } from "../errors.ts";
import type { MediaEvent } from "./mediaEvents.ts";
import type { MediaObjectStore, SpeechSynthesisCommand, SpeechSynthesizer } from "./ports.ts";
import { audioCacheKey, buildQuestionSpeechText, maxSpeechTextLength, QuestionSpeechService } from "./questionSpeech.ts";

class FakeSynthesizer implements SpeechSynthesizer {
  readonly voiceProfile: string;
  readonly calls: SpeechSynthesisCommand[] = [];
  failure: Error | undefined;

  constructor(voiceProfile = "fake:voice") {
    this.voiceProfile = voiceProfile;
  }

  async synthesize(command: SpeechSynthesisCommand): Promise<Uint8Array> {
    this.calls.push(command);
    if (this.failure) throw this.failure;
    return new Uint8Array([0xff, 0xfb, 0x90]);
  }
}

class FakeStore implements MediaObjectStore {
  readonly objects = new Map<string, { content: Uint8Array; contentType: string }>();
  readonly signed: Array<{ key: string; ttl: number }> = [];
  failOn: "exists" | "put" | "sign" | undefined;

  async exists(key: string): Promise<boolean> {
    if (this.failOn === "exists") throw Object.assign(new Error("arn:aws:s3:::secret-bucket denied"), { name: "AccessDenied" });
    return this.objects.has(key);
  }

  async put(key: string, content: Uint8Array, contentType: string): Promise<void> {
    if (this.failOn === "put") throw Object.assign(new Error("secret-bucket/audio-cache failed"), { name: "SlowDown" });
    this.objects.set(key, { content, contentType });
  }

  async createReadUrl(key: string, ttl: number): Promise<string> {
    if (this.failOn === "sign") throw new Error("credentials unavailable");
    this.signed.push({ key, ttl });
    return `https://signed.example/${key}?X-Amz-Signature=secret`;
  }
}

const sensitivePlayer = { id: "amelia", name: "Amelia Secreta", avatar: "👧", age: 4 };

function gameWith(question: Question): Game {
  return {
    id: "ai-game-1",
    title: "Juego",
    category: { id: "animals", name: "Animales", description: "d", icon: "🐼" },
    players: [sensitivePlayer],
    questions: [question],
    generationMetadata: { targetAge: 4, difficulty: "easy" },
  };
}

const oceanQuestion: Question = {
  id: "q1",
  categoryId: "animals",
  difficulty: "easy",
  text: "¿Cuál de estos animales vive en el océano?",
  emoji: "🐬",
  media: { image: { assetId: "animals/dolphin-01", altText: "Un delfín nadando" } },
  answers: [
    { id: "q1a1", text: "León", isCorrect: false },
    { id: "q1a2", text: "Delfín", isCorrect: true },
    { id: "q1a3", text: "Caballo", isCorrect: false },
    { id: "q1a4", text: "Águila", isCorrect: false },
  ],
};

async function fixture(question: Question = oceanQuestion) {
  const games = new MockGameRepository();
  await games.create(gameWith(question));
  const synthesizer = new FakeSynthesizer();
  const store = new FakeStore();
  const events: MediaEvent[] = [];
  let clock = Date.parse("2026-10-03T12:00:00.000Z");
  const service = new QuestionSpeechService(games, synthesizer, store, {
    languageCode: "es-US",
    cacheVersion: "v1",
    urlTtlSeconds: 900,
    now: () => clock,
    logEvent: (event) => events.push(event),
  });
  return { service, synthesizer, store, events, advance: (ms: number) => { clock += ms; } };
}

test("speech text reads the question and every option in persisted (displayed) order", () => {
  assert.equal(
    buildQuestionSpeechText(oceanQuestion),
    "¿Cuál de estos animales vive en el océano?\nOpción 1: León.\nOpción 2: Delfín.\nOpción 3: Caballo.\nOpción 4: Águila.",
  );
});

test("speech text never reveals the answer key, IDs, media metadata, emoji or player data", () => {
  const text = buildQuestionSpeechText(oceanQuestion)!;
  for (const forbidden of ["isCorrect", "true", "false", "correct", "correcta", "q1a2", "q1", "dolphin", "delfín nadando", "🐬", "Amelia", "ai-game-1"]) {
    assert.equal(text.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
  // Every option is read with the same neutral framing, so none stands out.
  assert.equal(text.match(/Opción \d: /g)?.length, 4);
});

test("speech text strips markup/control characters, keeps punctuation, and is bounded", () => {
  const text = buildQuestionSpeechText({
    text: "  <speak>Hola</speak>\u0000‮ ¿Qué es?  ",
    answers: [{ id: "a", text: "Sí!", isCorrect: true }, { id: "b", text: "No 🚀", isCorrect: false }],
  });
  assert.equal(text, "speak Hola /speak ¿Qué es?\nOpción 1: Sí!\nOpción 2: No.");
  assert.equal(buildQuestionSpeechText({ text: "x".repeat(maxSpeechTextLength), answers: oceanQuestion.answers }), null);
  assert.equal(buildQuestionSpeechText({ text: "   ", answers: oceanQuestion.answers }), null);
  assert.equal(buildQuestionSpeechText({ text: "Pregunta", answers: [] }), null);
});

test("audio cache key is deterministic, opaque, and changes with text, language, voice or version", () => {
  const base = { text: "Hola", languageCode: "es-US", voiceProfile: "polly:Lupe:neural:mp3", cacheVersion: "v1" };
  const key = audioCacheKey(base);
  assert.equal(key, audioCacheKey({ ...base }));
  assert.match(key, /^audio-cache\/v1\/[a-f0-9]{64}\.mp3$/);
  assert.equal(key.includes("Hola"), false);
  for (const change of [{ text: "Hola!" }, { languageCode: "es-MX" }, { voiceProfile: "polly:Mia:neural:mp3" }, { cacheVersion: "v2" }]) {
    assert.notEqual(audioCacheKey({ ...base, ...change }), key);
  }
});

test("cache miss synthesizes once, stores MP3 under audio-cache/, and returns a short-lived URL", async () => {
  const { service, synthesizer, store, events } = await fixture();
  const response = await service.getQuestionAudio({ gameId: "ai-game-1", questionId: "q1", correlationId: "req-1" });

  assert.equal(synthesizer.calls.length, 1);
  assert.equal(synthesizer.calls[0].languageCode, "es-US");
  assert.equal(synthesizer.calls[0].text, buildQuestionSpeechText(oceanQuestion));
  const [[key, object]] = [...store.objects.entries()];
  assert.match(key, /^audio-cache\/v1\/[a-f0-9]{64}\.mp3$/);
  assert.equal(object.contentType, "audio/mpeg");
  assert.deepEqual(store.signed, [{ key, ttl: 900 }]);
  assert.equal(response.audioUrl, `https://signed.example/${key}?X-Amz-Signature=secret`);
  assert.equal(response.expiresAt, "2026-10-03T12:15:00.000Z");
  assert.deepEqual(events.map((event) => event.event), [
    "QUESTION_AUDIO_REQUESTED",
    "QUESTION_AUDIO_CACHE_MISS",
    "QUESTION_AUDIO_SYNTHESIZED",
  ]);
  assert.equal(events.every((event) => event.correlationId === "req-1" && event.gameId === "ai-game-1" && event.questionId === "q1"), true);
});

test("a repeated request is a cache hit: Polly is not invoked again and a fresh URL is issued", async () => {
  const { service, synthesizer, store, events, advance } = await fixture();
  const first = await service.getQuestionAudio({ gameId: "ai-game-1", questionId: "q1" });
  advance(60_000);
  events.length = 0;
  const second = await service.getQuestionAudio({ gameId: "ai-game-1", questionId: "q1" });

  assert.equal(synthesizer.calls.length, 1);
  assert.equal(store.objects.size, 1);
  assert.equal(store.signed.length, 2);
  assert.equal(second.audioUrl, first.audioUrl);
  assert.equal(second.expiresAt, "2026-10-03T12:16:00.000Z");
  assert.deepEqual(events.map((event) => [event.event, event.cacheHit]), [
    ["QUESTION_AUDIO_REQUESTED", undefined],
    ["QUESTION_AUDIO_CACHE_HIT", true],
  ]);
});

test("unknown game or question returns a safe not-found error without touching media providers", async () => {
  const { service, synthesizer, store } = await fixture();
  await assert.rejects(service.getQuestionAudio({ gameId: "missing", questionId: "q1" }), { code: "RESOURCE_NOT_FOUND", message: "Game was not found." });
  await assert.rejects(service.getQuestionAudio({ gameId: "ai-game-1", questionId: "q9" }), { code: "RESOURCE_NOT_FOUND", message: "Question was not found." });
  assert.equal(synthesizer.calls.length, 0);
  assert.equal(store.signed.length, 0);
});

test("seeded games are speakable too", async () => {
  const { service, synthesizer } = await fixture();
  await service.getQuestionAudio({ gameId: "animals", questionId: "animals-easy-1" });
  assert.match(synthesizer.calls[0].text, /^¿Qué animal dice miau\?\nOpción 1: Gato\./);
});

test("unspeakable content is rejected before calling Polly", async () => {
  const { service, synthesizer } = await fixture({ ...oceanQuestion, text: "🐬" });
  await assert.rejects(service.getQuestionAudio({ gameId: "ai-game-1", questionId: "q1" }), { code: "QUESTION_AUDIO_UNSUPPORTED" });
  assert.equal(synthesizer.calls.length, 0);
});

test("Polly and S3 failures become one safe error with a safe event; nothing is cached on failure", async () => {
  for (const scenario of ["synthesis", "exists", "put", "sign"] as const) {
    const { service, synthesizer, store, events } = await fixture();
    if (scenario === "synthesis") synthesizer.failure = Object.assign(new Error("arn:aws:polly secret detail"), { name: "ServiceFailureException" });
    else store.failOn = scenario;

    const error = await service.getQuestionAudio({ gameId: "ai-game-1", questionId: "q1" }).catch((caught: unknown) => caught);
    assert.ok(error instanceof ApplicationError);
    assert.equal(error.code, "QUESTION_AUDIO_FAILED");
    assert.equal(error.message, "Question audio is temporarily unavailable.");
    const failed = events.find((event) => event.event === "QUESTION_AUDIO_FAILED");
    assert.ok(failed, scenario);
    assert.equal(JSON.stringify(failed).includes("secret"), false);
    if (scenario === "synthesis") assert.equal(store.objects.size, 0);
  }
});

test("events never contain spoken text, answer correctness, URLs or object keys", async () => {
  const { service, events } = await fixture();
  await service.getQuestionAudio({ gameId: "ai-game-1", questionId: "q1" });
  await service.getQuestionAudio({ gameId: "ai-game-1", questionId: "q1" });
  const serialized = JSON.stringify(events);
  for (const forbidden of ["océano", "Delfín", "isCorrect", "https://", "audio-cache", "Signature"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("rejects unsafe configuration", () => {
  const games = new MockGameRepository();
  const build = (options: Partial<{ languageCode: string; cacheVersion: string; urlTtlSeconds: number }>) => () =>
    new QuestionSpeechService(games, new FakeSynthesizer(), new FakeStore(), { languageCode: "es-US", cacheVersion: "v1", urlTtlSeconds: 900, ...options });
  assert.throws(build({ cacheVersion: "../x" }));
  assert.throws(build({ urlTtlSeconds: 86_400 }));
  assert.throws(build({ languageCode: " " }));
  // v0.8 has a single speech profile (es-US): every other language, including other Spanish variants, is rejected.
  for (const languageCode of ["en-US", "es-MX", "es-ES"]) assert.throws(build({ languageCode }), /single v0\.8 speech profile/);
  assert.doesNotThrow(build({ languageCode: "es-US" }));
});
