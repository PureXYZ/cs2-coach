import { Readable } from "node:stream";
import { StreamType } from "@discordjs/voice";
import { idleGuarded } from "./idle.js";
import { currentVoiceId } from "./voices.js";
import type { SynthOptions, TtsProvider, TtsResult } from "./types.js";

/** Mid-stream stall watchdog window — the per-fetch abort now guards only TTFB. */
const STREAM_IDLE_MS = 5_000;

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

  async synth(text: string, opts?: SynthOptions): Promise<TtsResult> {
    // Per-line override (the `/coach say voice:` option) wins; otherwise the live
    // `/coach voice` selection, read fresh each synth so a switch takes effect
    // on the very next line.
    const voiceId = opts?.voiceId ?? currentVoiceId();
    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`);
    url.searchParams.set("output_format", "opus_48000_64");

    // The timeout must guard only time-to-first-byte. The response body is an
    // audio stream consumed lazily DURING playback, so a fixed AbortSignal on the
    // whole fetch would tear the connection down mid-stream and cut a long line
    // off mid-sentence (~8s in, per the captured logs). Abort only until the
    // headers arrive — a genuinely stalled request (no headers) still fails fast
    // and falls through to the next provider; once streaming starts it runs as
    // long as the audio needs. Tradeoff: a rarer headers-then-no-audio stall no
    // longer fails over to the next provider — it's caught downstream by the
    // idleGuarded watchdog / the voice queue's synth deadline, which drop the
    // line and advance the queue rather than retrying on Deepgram/Edge.
    const controller = new AbortController();
    const ttfbTimer = setTimeout(() => controller.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(url, {
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
            speed: this.voiceSettings.speed,
          },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(ttfbTimer);
    }

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ElevenLabs TTS HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }

    return {
      stream: idleGuarded(
        Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
        STREAM_IDLE_MS,
      ),
      inputType: StreamType.OggOpus,
    };
  }
}
