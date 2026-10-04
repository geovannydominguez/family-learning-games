/**
 * v0.8 question audio playback logic, kept framework-free so it can be unit
 * tested. Audio only ever starts from `listen()` (an explicit user action):
 * nothing here autoplays. Failures surface as an `"error"` status and never
 * throw, so the game stays fully playable without audio (FR-0807).
 */

export type QuestionAudioStatus = "idle" | "loading" | "playing" | "error";

export interface QuestionAudioPlayer {
  /** Starts playback of `url` from the beginning; rejects if playback cannot start. */
  play(url: string): Promise<void>;
  stop(): void;
}

export interface QuestionAudioControllerOptions {
  fetchAudio: (gameId: string, questionId: string) => Promise<{ audioUrl: string; expiresAt: string }>;
  player: QuestionAudioPlayer;
  onStatusChange: (status: QuestionAudioStatus) => void;
  now?: () => number;
}

/** Refetch a little before the signed URL expires so replay never uses a dead link. */
const expirySafetyMarginMs = 30_000;

export class QuestionAudioController {
  private readonly options: QuestionAudioControllerOptions;
  private readonly now: () => number;
  private readonly urls = new Map<string, { url: string; expiresAtMs: number }>();
  private status: QuestionAudioStatus = "idle";
  /** Bumped on every question change so late responses never play stale audio. */
  private generation = 0;
  private pendingGeneration: number | null = null;

  constructor(options: QuestionAudioControllerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get currentStatus(): QuestionAudioStatus {
    return this.status;
  }

  /**
   * Plays (or replays from the start) the question audio. A cached, still-valid
   * URL is played without any request; while a request is pending further calls
   * are ignored (FR-0873).
   */
  async listen(gameId: string, questionId: string): Promise<void> {
    if (this.pendingGeneration === this.generation) return;
    const generation = this.generation;
    const key = `${gameId}/${questionId}`;
    this.options.player.stop();

    let entry = this.urls.get(key);
    if (!entry || entry.expiresAtMs - expirySafetyMarginMs <= this.now()) {
      this.pendingGeneration = generation;
      this.setStatus("loading");
      try {
        const response = await this.options.fetchAudio(gameId, questionId);
        const expiresAtMs = Date.parse(response.expiresAt);
        entry = { url: response.audioUrl, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : this.now() };
        this.urls.set(key, entry);
      } catch {
        if (generation === this.generation) this.setStatus("error");
        return;
      } finally {
        if (this.pendingGeneration === generation) this.pendingGeneration = null;
      }
      if (generation !== this.generation) return;
    }

    this.setStatus("playing");
    try {
      await this.options.player.play(entry.url);
    } catch {
      this.urls.delete(key);
      if (generation === this.generation) this.setStatus("error");
    }
  }

  /** Called by the player when playback finishes. */
  ended(): void {
    if (this.status === "playing") this.setStatus("idle");
  }

  /** Called when the question changes or the view unmounts: stop and forget in-flight work. */
  reset(): void {
    this.generation += 1;
    this.pendingGeneration = null;
    this.options.player.stop();
    this.setStatus("idle");
  }

  private setStatus(status: QuestionAudioStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatusChange(status);
  }
}
