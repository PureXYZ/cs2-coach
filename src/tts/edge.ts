import type { Readable } from "node:stream";
import { StreamType } from "@discordjs/voice";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { idleGuarded } from "./idle.js";
import type { TtsProvider, TtsResult } from "./types.js";

/** Mid-stream stall watchdog window — matches the other providers. */
const STREAM_IDLE_MS = 5_000;

/**
 * Free fallback: Microsoft Edge's Read Aloud voices via msedge-tts. Zero cost and
 * no API key, but the endpoint has a history of intermittent breakage (it's an
 * undocumented Microsoft service) — keep it last in the chain. Output is WebM/Opus,
 * which @discordjs/voice demuxes without ffmpeg.
 */
export class EdgeTts implements TtsProvider {
  readonly name = "edge";

  constructor(private readonly voice: string) {}

  available(): boolean {
    return true;
  }

  async synth(text: string): Promise<TtsResult> {
    // A fresh instance per synth avoids stale-WebSocket errors from the unofficial endpoint.
    const tts = new MsEdgeTTS();
    let audioStream: Readable;
    try {
      await tts.setMetadata(this.voice, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
      ({ audioStream } = tts.toStream(text));
    } catch (err) {
      // On a connect-time rejection there's no audio stream and thus no 'close'
      // handler to fire — close the socket here (idempotent) so it can't leak.
      try {
        tts.close();
      } catch {
        /* already closed */
      }
      throw err;
    }
    // The library never closes its WebSocket on its own — close it once the audio
    // stream finishes (or is destroyed) so sockets don't pile up over a match.
    audioStream.once("close", () => {
      try {
        tts.close();
      } catch {
        /* already closed */
      }
    });
    // Wrap in the mid-stream stall watchdog like the other providers: a mid-audio
    // stall would otherwise wedge the voice queue. The guard destroys the source on
    // timeout, which surfaces as the audioStream 'close' above — so tts.close() still runs.
    return {
      stream: idleGuarded(audioStream, STREAM_IDLE_MS),
      inputType: StreamType.WebmOpus,
    };
  }
}
