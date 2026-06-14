import { config, type TtsProviderName } from "../config.js";
import { log } from "../log.js";
import { DeepgramTts } from "./deepgram.js";
import { EdgeTts } from "./edge.js";
import { ElevenLabsTts } from "./elevenlabs.js";
import { normalizeForSpeech } from "./normalize.js";
import type { SynthOptions, TtsProvider, TtsResult } from "./types.js";

export type { SynthOptions, TtsProvider, TtsResult } from "./types.js";

function buildProvider(name: TtsProviderName): TtsProvider | null {
  switch (name) {
    case "deepgram":
      return new DeepgramTts(
        config.tts.deepgram.apiKey,
        config.tts.deepgram.model,
        config.tts.deepgram.bitrate,
      );
    case "elevenlabs":
      return new ElevenLabsTts(
        config.tts.elevenlabs.apiKey,
        config.tts.elevenlabs.modelId,
        {
          stability: config.tts.elevenlabs.stability,
          similarityBoost: config.tts.elevenlabs.similarityBoost,
          style: config.tts.elevenlabs.style,
          speed: config.tts.elevenlabs.speed,
        },
      );
    case "edge":
      return new EdgeTts(config.tts.edge.voice);
    default:
      log.warn("tts", `Unknown TTS provider "${name}" in TTS_PROVIDER — skipping`);
      return null;
  }
}

/** Tries each configured provider in order until one produces audio. */
export class TtsChain {
  private providers: TtsProvider[];

  constructor() {
    this.providers = config.tts.order
      .map(buildProvider)
      .filter((p): p is TtsProvider => p !== null && p.available());

    if (this.providers.length === 0) {
      log.warn("tts", "No TTS providers configured — falling back to free edge-tts");
      this.providers = [new EdgeTts(config.tts.edge.voice)];
    }
    log.info("tts", `Providers: ${this.providers.map((p) => p.name).join(" → ")}`);
  }

  get activeNames(): string[] {
    return this.providers.map((p) => p.name);
  }

  async synth(text: string, opts?: SynthOptions): Promise<TtsResult> {
    // Spell out bombsite/callout letters ("A site" → "Ay site") so providers
    // don't read a lone "A" as the article. Done once here, the single point
    // every provider flows through, so logs upstream keep the readable text.
    const spoken = normalizeForSpeech(text);
    let lastErr: unknown;
    for (const provider of this.providers) {
      const startedAt = Date.now();
      try {
        const result = await provider.synth(spoken, opts);
        // Providers resolve once audio starts streaming, so this is time-to-first-audio.
        log.info("tts", `${provider.name} started streaming in ${Date.now() - startedAt}ms`);
        return result;
      } catch (err) {
        lastErr = err;
        log.warn("tts", `${provider.name} failed after ${Date.now() - startedAt}ms (${err instanceof Error ? err.message : err}) — trying next`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("All TTS providers failed");
  }
}
