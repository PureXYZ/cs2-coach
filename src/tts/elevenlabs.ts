import { Readable } from "node:stream";
import { StreamType } from "@discordjs/voice";
import type { TtsProvider, TtsResult } from "./types.js";

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
    private readonly voiceId: string,
    private readonly modelId: string,
    private readonly voiceSettings: {
      stability: number;
      similarityBoost: number;
      style: number;
    },
  ) {}

  available(): boolean {
    return !!this.apiKey;
  }

  async synth(text: string): Promise<TtsResult> {
    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream`);
    url.searchParams.set("output_format", "opus_48000_64");

    const res = await fetch(url, {
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
        },
      }),
      // A stalled request must fail fast so the chain falls through to the next provider.
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ElevenLabs TTS HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }

    return {
      stream: Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      inputType: StreamType.OggOpus,
    };
  }
}
