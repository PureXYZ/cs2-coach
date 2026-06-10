import { StreamType } from "@discordjs/voice";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import type { TtsProvider, TtsResult } from "./types.js";

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
    await tts.setMetadata(this.voice, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
    const { audioStream } = tts.toStream(text);
    // The library never closes its WebSocket on its own — close it once the audio
    // stream finishes (or is destroyed) so sockets don't pile up over a match.
    audioStream.once("close", () => {
      try {
        tts.close();
      } catch {
        /* already closed */
      }
    });
    return { stream: audioStream, inputType: StreamType.WebmOpus };
  }
}
