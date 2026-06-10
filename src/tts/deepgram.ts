import { Readable } from "node:stream";
import { StreamType } from "@discordjs/voice";
import type { TtsProvider, TtsResult } from "./types.js";

/**
 * Deepgram Aura-2 over REST. encoding=opus returns an Ogg/Opus stream at a fixed
 * 48 kHz — exactly what Discord wants, so it pipes straight into the player with
 * no ffmpeg and no resampling. ~$0.030 per 1K characters; new accounts get a $200
 * credit, which covers this project's usage for years.
 */
export class DeepgramTts implements TtsProvider {
  readonly name = "deepgram";

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
    private readonly bitrate: number,
  ) {}

  available(): boolean {
    return !!this.apiKey;
  }

  async synth(text: string): Promise<TtsResult> {
    const url = new URL("https://api.deepgram.com/v1/speak");
    url.searchParams.set("model", this.model);
    url.searchParams.set("encoding", "opus"); // Ogg container, 48 kHz
    // Without this, Deepgram encodes Opus at a barely-intelligible 12 kbps default.
    url.searchParams.set("bit_rate", String(this.bitrate));

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
      // A stalled request must fail fast so the chain falls through to the next provider.
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Deepgram TTS HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }

    return {
      stream: Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      inputType: StreamType.OggOpus,
    };
  }
}
