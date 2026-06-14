import { Readable } from "node:stream";
import { StreamType } from "@discordjs/voice";
import { STREAM_IDLE_MS, TTS_TTFB_MS } from "./constants.js";
import { idleGuarded } from "./idle.js";
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

  /** Output-affecting params. Deepgram ignores opts.voiceId (no switchable voices),
   *  so its audio is voice-independent — one cache entry per text serves every voice. */
  cacheSignature(): string {
    return `${this.model}|${this.bitrate}`;
  }

  async synth(text: string): Promise<TtsResult> {
    const url = new URL("https://api.deepgram.com/v1/speak");
    url.searchParams.set("model", this.model);
    url.searchParams.set("encoding", "opus"); // Ogg container, 48 kHz
    // Without this, Deepgram encodes Opus at a barely-intelligible 12 kbps default.
    url.searchParams.set("bit_rate", String(this.bitrate));

    // Guard only time-to-first-byte: the body is an audio stream consumed during
    // playback, so a fixed AbortSignal on the whole fetch would cut a long line
    // off mid-sentence. Abort only until the headers land — a stalled request
    // (no headers) still fails fast to the next provider; streaming then runs as
    // long as the audio needs. Tradeoff: a headers-then-no-audio stall no longer
    // fails over — it's caught downstream by idleGuarded / the synth deadline,
    // which drop the line and advance rather than retrying the next provider.
    const controller = new AbortController();
    const ttfbTimer = setTimeout(() => controller.abort(), TTS_TTFB_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(ttfbTimer);
    }

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Deepgram TTS HTTP ${res.status}: ${detail.slice(0, 200)}`);
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
