import type { Readable } from "node:stream";
import type { StreamType } from "@discordjs/voice";

export interface TtsResult {
  stream: Readable;
  /** Tells @discordjs/voice how to ingest it without ffmpeg. */
  inputType: StreamType;
}

export interface TtsProvider {
  readonly name: string;
  /** True when this provider has the credentials/config it needs. */
  available(): boolean;
  synth(text: string): Promise<TtsResult>;
}
