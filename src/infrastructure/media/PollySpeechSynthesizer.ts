import { SynthesizeSpeechCommand, type Engine, type LanguageCode, type VoiceId } from "@aws-sdk/client-polly";

import type { SpeechSynthesisCommand, SpeechSynthesizer } from "../../application/media/ports.ts";

/** Minimal structural view of the Polly client used by this adapter. */
export interface PollySendClient {
  send(command: SynthesizeSpeechCommand): Promise<unknown>;
}

export interface PollyVoiceConfiguration {
  voiceId: string;
  engine: string;
  outputFormat: string;
}

/**
 * ADR-017: plain-text Polly synthesis (never SSML). Voice, engine and format
 * are deployment configuration fixed at construction — the public API can
 * never choose them.
 */
export class PollySpeechSynthesizer implements SpeechSynthesizer {
  readonly voiceProfile: string;
  private readonly client: PollySendClient;
  private readonly configuration: PollyVoiceConfiguration;

  constructor(client: PollySendClient, configuration: PollyVoiceConfiguration) {
    // v0.8 single speech profile (ADR-017): Lupe / neural / mp3, es-US.
    if (configuration.voiceId !== "Lupe") throw new Error("v0.8 question audio supports only the Polly voice Lupe.");
    if (configuration.engine !== "neural") throw new Error("v0.8 question audio supports only the neural Polly engine.");
    if (configuration.outputFormat !== "mp3") throw new Error("Only mp3 Polly output is supported.");
    this.client = client;
    this.configuration = configuration;
    this.voiceProfile = `polly:${configuration.voiceId}:${configuration.engine}:${configuration.outputFormat}`;
  }

  async synthesize(command: SpeechSynthesisCommand): Promise<Uint8Array> {
    const response = (await this.client.send(new SynthesizeSpeechCommand({
      Text: command.text,
      TextType: "text",
      LanguageCode: command.languageCode as LanguageCode,
      VoiceId: this.configuration.voiceId as VoiceId,
      Engine: this.configuration.engine as Engine,
      OutputFormat: "mp3",
    }))) as { AudioStream?: { transformToByteArray?: () => Promise<Uint8Array> } };
    const audio = await response.AudioStream?.transformToByteArray?.();
    if (!audio || audio.byteLength === 0) {
      const error = new Error("Polly returned no audio.");
      error.name = "EmptyAudioStream";
      throw error;
    }
    return audio;
  }
}
