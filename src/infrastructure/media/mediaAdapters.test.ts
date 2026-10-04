import assert from "node:assert/strict";
import test from "node:test";

import { SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import { PollySpeechSynthesizer } from "./PollySpeechSynthesizer.ts";
import { S3MediaObjectStore } from "./S3MediaObjectStore.ts";

const voice = { voiceId: "Lupe", engine: "neural", outputFormat: "mp3" };

test("Polly adapter sends plain text with the configured voice and returns MP3 bytes", async () => {
  const sent: SynthesizeSpeechCommand[] = [];
  const synthesizer = new PollySpeechSynthesizer({
    send: async (command) => {
      sent.push(command);
      return { AudioStream: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } };
    },
  }, voice);

  const audio = await synthesizer.synthesize({ text: "Hola\nOpción 1: Gato.", languageCode: "es-US" });
  assert.deepEqual([...audio], [1, 2, 3]);
  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof SynthesizeSpeechCommand);
  assert.deepEqual(sent[0].input, {
    Text: "Hola\nOpción 1: Gato.",
    TextType: "text",
    LanguageCode: "es-US",
    VoiceId: "Lupe",
    Engine: "neural",
    OutputFormat: "mp3",
  });
  assert.equal(synthesizer.voiceProfile, "polly:Lupe:neural:mp3");
});

test("Polly adapter rejects empty audio and unsafe configuration", async () => {
  const empty = new PollySpeechSynthesizer({ send: async () => ({ AudioStream: { transformToByteArray: async () => new Uint8Array() } }) }, voice);
  await assert.rejects(empty.synthesize({ text: "Hola", languageCode: "es-US" }), { name: "EmptyAudioStream" });
  const client = { send: async () => ({}) };
  // v0.8 single profile: only Lupe / neural / mp3.
  for (const voiceId of ["Lupe;rm", "Mia", "Andres", "Lucia", "Sergio"]) assert.throws(() => new PollySpeechSynthesizer(client, { ...voice, voiceId }), voiceId);
  for (const engine of ["turbo", "standard", "generative"]) assert.throws(() => new PollySpeechSynthesizer(client, { ...voice, engine }), engine);
  assert.throws(() => new PollySpeechSynthesizer(client, { ...voice, outputFormat: "pcm" }));
});

test("S3 adapter: HEAD 404 is a cache miss, other errors propagate, PUT stores private MP3, URLs are signed reads", async () => {
  const sent: Array<HeadObjectCommand | PutObjectCommand> = [];
  let headError: unknown;
  const signed: Array<[string, string, number]> = [];
  const store = new S3MediaObjectStore({
    send: async (command) => {
      sent.push(command);
      if (command instanceof HeadObjectCommand && headError) throw headError;
      return {};
    },
  }, "media-bucket", async (bucket, key, ttl) => {
    signed.push([bucket, key, ttl]);
    return "https://signed.example/x";
  });

  assert.equal(await store.exists("audio-cache/v1/a.mp3"), true);
  headError = Object.assign(new Error("Not Found"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
  assert.equal(await store.exists("audio-cache/v1/a.mp3"), false);
  headError = Object.assign(new Error("Forbidden"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
  await assert.rejects(store.exists("audio-cache/v1/a.mp3"), { name: "AccessDenied" });

  await store.put("audio-cache/v1/a.mp3", new Uint8Array([1]), "audio/mpeg");
  const put = sent.at(-1);
  assert.ok(put instanceof PutObjectCommand);
  assert.equal(put.input.Bucket, "media-bucket");
  assert.equal(put.input.Key, "audio-cache/v1/a.mp3");
  assert.equal(put.input.ContentType, "audio/mpeg");
  assert.equal("ACL" in put.input, false);

  assert.equal(await store.createReadUrl("audio-cache/v1/a.mp3", 900), "https://signed.example/x");
  assert.deepEqual(signed, [["media-bucket", "audio-cache/v1/a.mp3", 900]]);
});
