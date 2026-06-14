import { Readable } from "node:stream";
import { StreamType } from "@discordjs/voice";
import { STREAM_IDLE_MS } from "./constants.js";
import { ttfbFetch } from "./http.js";
import { idleGuarded } from "./idle.js";
import { currentVoiceId, findVoiceById } from "./voices.js";
import type { SynthOptions, TtsProvider, TtsResult } from "./types.js";

/**
 * ElevenLabs Flash v2.5 over the streaming REST endpoint with native 48 kHz
 * Ogg/Opus output. Lowest measured perceived latency of the paid options
 * (mid-2026), but needs the Creator plan (~$22/mo) at this project's volume —
 * optional upgrade path over Deepgram.
 */
export class ElevenLabsTts implements TtsProvider {
  readonly name = "elevenlabs";

  constructor(
    private readonly apiKey: string | undefined,
    private readonly modelId: string,
    private readonly voiceSettings: {
      stability: number;
      similarityBoost: number;
      style: number;
      speed: number;
    },
  ) {}

  available(): boolean {
    return !!this.apiKey;
  }

  /** Every param that changes the synthesized audio, resolving the voice id and
   *  per-voice speed override EXACTLY as synth() does (so the cache key matches
   *  the bytes). Fixed precision so 1 vs 1.0 can't fork the key. */
  cacheSignature(opts?: SynthOptions): string {
    const voiceId = opts?.voiceId ?? currentVoiceId();
    const speed = findVoiceById(voiceId)?.speed ?? this.voiceSettings.speed;
    const { stability, similarityBoost, style } = this.voiceSettings;
    return [
      this.modelId,
      voiceId,
      stability.toFixed(3),
      similarityBoost.toFixed(3),
      style.toFixed(3),
      speed.toFixed(3),
    ].join("|");
  }

  async synth(text: string, opts?: SynthOptions): Promise<TtsResult> {
    // Per-line override (the `/coach say voice:` option) wins; otherwise the live
    // `/coach voice` selection, read fresh each synth so a switch takes effect
    // on the very next line.
    const voiceId = opts?.voiceId ?? currentVoiceId();
    // Per-voice speed override (ELEVENLABS_VOICES entry) wins; otherwise the global
    // ELEVENLABS_SPEED this provider was built with.
    const speed = findVoiceById(voiceId)?.speed ?? this.voiceSettings.speed;
    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`);
    url.searchParams.set("output_format", "opus_48000_64");

    // ttfbFetch guards only time-to-first-byte (see http.ts). The response body is
    // an audio stream consumed lazily DURING playback, so a fixed AbortSignal on
    // the whole fetch would tear the connection down mid-stream and cut a long line
    // off mid-sentence (~8s in, per the captured logs). It aborts only until the
    // headers arrive and throws (with the provider name) on a non-OK status or
    // missing body.
    const res = await ttfbFetch(
      url,
      {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: this.modelId,
          voice_settings: {
            stability: this.voiceSettings.stability,
            similarity_boost: this.voiceSettings.similarityBoost,
            style: this.voiceSettings.style,
            speed,
          },
        }),
      },
      "ElevenLabs",
    );

    return {
      stream: idleGuarded(
        Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
        STREAM_IDLE_MS,
      ),
      inputType: StreamType.OggOpus,
      // Surface the actual synthesizing voice so the player can apply its per-voice volume.
      voiceId,
    };
  }
}
