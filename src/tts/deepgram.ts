import { Readable } from "node:stream";
import { StreamType } from "@discordjs/voice";
import { STREAM_IDLE_MS } from "./constants.js";
import { ttfbFetch } from "./http.js";
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

    // ttfbFetch guards only time-to-first-byte (see http.ts): the body is an audio
    // stream consumed during playback, so a fixed AbortSignal on the whole fetch
    // would cut a long line off mid-sentence. It aborts only until the headers land
    // and throws (with the provider name) on a non-OK status or missing body.
    const res = await ttfbFetch(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
      },
      "Deepgram",
    );

    return {
      stream: idleGuarded(
        Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
        STREAM_IDLE_MS,
      ),
      inputType: StreamType.OggOpus,
    };
  }
}
