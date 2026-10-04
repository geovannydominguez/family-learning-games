/**
 * Provider-independent media ports (v0.8, ADR-016 / ADR-017). Infrastructure
 * provides the Polly and S3 implementations; Application never imports them.
 */

export interface SpeechSynthesisCommand {
  /** Plain text built by Application from persisted question content. Never SSML. */
  text: string;
  languageCode: string;
}

export interface SpeechSynthesizer {
  /**
   * Opaque fingerprint of the effective voice configuration (voice, engine,
   * format). Part of the audio cache identity so changing it never serves
   * audio produced with a different voice.
   */
  readonly voiceProfile: string;
  /** Returns MP3 audio bytes. */
  synthesize(command: SpeechSynthesisCommand): Promise<Uint8Array>;
}

export interface MediaObjectStore {
  exists(key: string): Promise<boolean>;
  put(key: string, content: Uint8Array, contentType: string): Promise<void>;
  /** A short-lived, read-only URL. Never persisted, never logged in full. */
  createReadUrl(key: string, expiresInSeconds: number): Promise<string>;
}
