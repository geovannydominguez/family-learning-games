import { createHash } from "node:crypto";

import type { Question } from "../../domain/game/types.ts";
import type { GameRepository } from "../../repositories/game/GameRepository.ts";
import { ApplicationError } from "../errors.ts";
import { type MediaEvent, safeErrorName } from "./mediaEvents.ts";
import type { MediaObjectStore, SpeechSynthesizer } from "./ports.ts";

/** FR-0844: bounded input before calling the provider (well under Polly's plain-text limit). */
export const maxSpeechTextLength = 1_500;
export const audioContentType = "audio/mpeg";

const controlCharacters = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;
const pictographs = /[\p{Extended_Pictographic}\uFE0E\uFE0F\u20E3]/gu;
const markup = /[<>]/g;
const terminalPunctuation = /[.!?…:;]$/;
const cacheVersionPattern = /^[a-z0-9-]{1,16}$/;
/**
 * v0.8 has a single speech profile: Spanish (es-US), matching the game content
 * and the spoken labels ("Opción N"). No language selection or i18n.
 */
export const speechLanguageCode = "es-US";

function cleanFragment(value: string): string {
  return value
    .normalize("NFC")
    .replace(controlCharacters, " ")
    .replace(pictographs, " ")
    .replace(markup, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function asSentence(value: string): string {
  return terminalPunctuation.test(value) ? value : `${value}.`;
}

/**
 * Builds the Spanish plain text read aloud for a question (FR-0840..FR-0843): the
 * question, then every answer option with a deterministic number in the
 * persisted (= displayed) order. Only public text is read — never
 * `isCorrect`, IDs, emoji, image metadata or anything hinting at the answer.
 * Returns `null` when the question has nothing speakable or exceeds the bound.
 */
export function buildQuestionSpeechText(question: Pick<Question, "text" | "answers">): string | null {
  const questionText = cleanFragment(question.text);
  const options = question.answers.map((answer) => cleanFragment(answer.text));
  if (!questionText || options.length === 0 || options.some((option) => !option)) return null;
  const speech = [
    questionText,
    ...options.map((option, index) => `Opción ${index + 1}: ${asSentence(option)}`),
  ].join("\n");
  return speech.length <= maxSpeechTextLength ? speech : null;
}

/**
 * FR-0846 / FR-0847: deterministic, opaque cache identity. Changes whenever the
 * spoken text, language, voice profile or cache version changes; contains no
 * readable question/topic/player data.
 */
export function audioCacheKey(input: { text: string; languageCode: string; voiceProfile: string; cacheVersion: string }): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([input.cacheVersion, input.languageCode, input.voiceProfile, input.text]))
    .digest("hex");
  return `audio-cache/${input.cacheVersion}/${hash}.mp3`;
}

export interface QuestionAudioCommand {
  gameId: string;
  questionId: string;
  correlationId?: string;
}

export interface QuestionAudioResponse {
  audioUrl: string;
  expiresAt: string;
}

export interface QuestionSpeechOptions {
  languageCode: string;
  cacheVersion: string;
  urlTtlSeconds: number;
  now?: () => number;
  logEvent?: (event: MediaEvent) => void;
}

/**
 * On-demand question audio (ADR-017). Independent of `POST /games/generate`:
 * it never touches the Generator/Validator pipeline or its execution budget.
 */
export class QuestionSpeechService {
  private readonly games: GameRepository;
  private readonly synthesizer: SpeechSynthesizer;
  private readonly store: MediaObjectStore;
  private readonly languageCode: string;
  private readonly cacheVersion: string;
  private readonly urlTtlSeconds: number;
  private readonly now: () => number;
  private readonly logEvent: (event: MediaEvent) => void;

  constructor(games: GameRepository, synthesizer: SpeechSynthesizer, store: MediaObjectStore, options: QuestionSpeechOptions) {
    if (options.languageCode !== speechLanguageCode) {
      throw new Error(`Question audio uses the single v0.8 speech profile: the language must be ${speechLanguageCode}.`);
    }
    if (!cacheVersionPattern.test(options.cacheVersion)) throw new Error("Question audio cache version is invalid.");
    if (!Number.isInteger(options.urlTtlSeconds) || options.urlTtlSeconds < 60 || options.urlTtlSeconds > 3_600) {
      throw new Error("Question audio URL TTL must be an integer between 60 and 3600 seconds.");
    }
    this.games = games;
    this.synthesizer = synthesizer;
    this.store = store;
    this.languageCode = options.languageCode;
    this.cacheVersion = options.cacheVersion;
    this.urlTtlSeconds = options.urlTtlSeconds;
    this.now = options.now ?? Date.now;
    this.logEvent = options.logEvent ?? (() => {});
  }

  async getQuestionAudio(command: QuestionAudioCommand): Promise<QuestionAudioResponse> {
    const context = {
      ...(command.correlationId ? { correlationId: command.correlationId } : {}),
      gameId: command.gameId,
      questionId: command.questionId,
    };
    this.logEvent({ event: "QUESTION_AUDIO_REQUESTED", level: "info", ...context });

    const game = await this.games.findById(command.gameId);
    if (!game) throw new ApplicationError("RESOURCE_NOT_FOUND", "Game was not found.");
    const question = game.questions.find((candidate) => candidate.id === command.questionId);
    if (!question) throw new ApplicationError("RESOURCE_NOT_FOUND", "Question was not found.");

    const text = buildQuestionSpeechText(question);
    if (!text) {
      this.logEvent({ event: "QUESTION_AUDIO_FAILED", level: "warn", ...context, stage: "content" });
      throw new ApplicationError("QUESTION_AUDIO_UNSUPPORTED", "This question cannot be read aloud.");
    }
    const key = audioCacheKey({
      text,
      languageCode: this.languageCode,
      voiceProfile: this.synthesizer.voiceProfile,
      cacheVersion: this.cacheVersion,
    });

    const cached = await this.step(context, "storage", () => this.store.exists(key));
    if (cached) {
      this.logEvent({ event: "QUESTION_AUDIO_CACHE_HIT", level: "info", ...context, cacheHit: true });
    } else {
      this.logEvent({ event: "QUESTION_AUDIO_CACHE_MISS", level: "info", ...context, cacheHit: false });
      const startedAt = this.now();
      const audio = await this.step(context, "synthesis", () => this.synthesizer.synthesize({ text, languageCode: this.languageCode }));
      this.logEvent({
        event: "QUESTION_AUDIO_SYNTHESIZED",
        level: "info",
        ...context,
        cacheHit: false,
        durationMs: Math.max(0, this.now() - startedAt),
      });
      await this.step(context, "storage", () => this.store.put(key, audio, audioContentType));
    }

    const issuedAt = this.now();
    const audioUrl = await this.step(context, "signing", () => this.store.createReadUrl(key, this.urlTtlSeconds));
    return { audioUrl, expiresAt: new Date(issuedAt + this.urlTtlSeconds * 1_000).toISOString() };
  }

  /** Translates any provider/storage failure into one safe public error. */
  private async step<T>(
    context: Pick<MediaEvent, "correlationId" | "gameId" | "questionId">,
    stage: "synthesis" | "storage" | "signing",
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.logEvent({ event: "QUESTION_AUDIO_FAILED", level: "error", ...context, stage, errorName: safeErrorName(error) });
      throw new ApplicationError("QUESTION_AUDIO_FAILED", "Question audio is temporarily unavailable.");
    }
  }
}
