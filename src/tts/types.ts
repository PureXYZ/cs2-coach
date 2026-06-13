import type { Readable } from "node:stream";
import type { StreamType } from "@discordjs/voice";

export interface TtsResult {
  stream: Readable;
  /** Tells @discordjs/voice how to ingest it without ffmpeg. */
  inputType: StreamType;
}

export interface SynthOptions {
  /** Override the voice for this one line. ElevenLabs honors it; the other
   *  providers have no equivalent and ignore it. Unset = the provider's current
   *  voice (for ElevenLabs, the live `/coach voice` selection). */
  voiceId?: string;
}

export interface TtsProvider {
  readonly name: string;
  /** True when this provider has the credentials/config it needs. */
  available(): boolean;
  synth(text: string, opts?: SynthOptions): Promise<TtsResult>;
}
