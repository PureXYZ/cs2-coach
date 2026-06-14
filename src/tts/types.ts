import type { Readable } from "node:stream";
import type { StreamType } from "@discordjs/voice";

export interface TtsResult {
  stream: Readable;
  /** Tells @discordjs/voice how to ingest it without ffmpeg. */
  inputType: StreamType;
  /** The ElevenLabs voice id this audio was actually synthesized with, when the
   *  ElevenLabs provider produced it. Lets the player apply that voice's per-voice
   *  volume to the right audio (even a prefetched line, synthesized before a later
   *  voice switch). Unset for providers without switchable voices (Deepgram/Edge)
   *  → playback falls back to the global COACH_VOLUME. */
  voiceId?: string;
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
  /** A stable string of every output-affecting setting for the given options, so
   *  the TTS cache can key audio by (provider, signature, text). Two calls that
   *  would produce byte-identical audio MUST return the same string; any change
   *  that alters the audio (voice, model, speed, …) MUST change it. */
  cacheSignature(opts?: SynthOptions): string;
}
