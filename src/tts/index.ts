import { Readable, finished } from "node:stream";
import { config, type TtsProviderName } from "../config.js";
import { log } from "../log.js";
import { cacheableLineTexts } from "../coach/lines.js";
import { TtsCache } from "./cache.js";
import { DeepgramTts } from "./deepgram.js";
import { EdgeTts } from "./edge.js";
import { ElevenLabsTts } from "./elevenlabs.js";
import { normalizeForSpeech } from "./normalize.js";
import { currentVoiceId } from "./voices.js";
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pull a stream to its end (or error) so a capture-tee sees a clean 'end' and persists. */
function drain(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    stream.resume();
    finished(stream, () => resolve());
  });
}

/** Tries each configured provider in order until one produces audio. */
export class TtsChain {
  private providers: TtsProvider[];
  /** Audio cache for the static, latency-critical lines. null when disabled/unavailable. */
  private readonly cache: TtsCache | null;
  /** Re-entrancy guard: only one prewarm loop runs at a time, so a repeated
   *  /coachadmin tts prewarm (or overlap with the startup prewarm) can't double up
   *  paid synth calls on the same not-yet-cached lines. */
  private prewarming = false;

  constructor() {
    this.providers = config.tts.order
      .map(buildProvider)
      .filter((p): p is TtsProvider => p !== null && p.available());

    if (this.providers.length === 0) {
      log.warn("tts", "No TTS providers configured — falling back to free edge-tts");
      this.providers = [new EdgeTts(config.tts.edge.voice)];
    }
    log.info("tts", `Providers: ${this.providers.map((p) => p.name).join(" → ")}`);

    // The cache is purely additive — any init failure just disables it.
    let cache: TtsCache | null = null;
    if (config.tts.cache.enabled) {
      try {
        cache = new TtsCache(config.tts.cache.dir, config.tts.cache.maxEntries, cacheableLineTexts());
      } catch (err) {
        log.warn("tts", `cache disabled — init failed (${err instanceof Error ? err.message : err})`);
      }
    }
    this.cache = cache;
  }

  get activeNames(): string[] {
    return this.providers.map((p) => p.name);
  }

  /** Audio-cache size for the owner readout, or null when the cache is disabled. */
  cacheStats(): { entries: number; bytes: number } | null {
    return this.cache?.stats() ?? null;
  }

  /** Drop every cached line (owner-only, after confirm). Returns what was removed
   *  ({0,0} when the cache is disabled). A prewarm() refills it. */
  clearCache(): { entries: number; bytes: number } {
    return this.cache?.clear() ?? { entries: 0, bytes: 0 };
  }

  async synth(text: string, opts?: SynthOptions): Promise<TtsResult> {
    // Spell out bombsite/callout letters ("A site" → "Ay site") so providers
    // don't read a lone "A" as the article. Done once here, the single point
    // every provider flows through, so logs upstream keep the readable text.
    const spoken = normalizeForSpeech(text);
    // Resolve the effective voice ONCE here so the cache key and the synthesized
    // audio can't disagree if /coach voice switches mid-call; the provider then
    // honors this exact id rather than re-reading the live selection itself.
    const sopts: SynthOptions = { ...opts, voiceId: opts?.voiceId ?? currentVoiceId() };
    const primary = this.providers[0];

    // Cache lookup: a static, whitelisted line may already be on disk under the
    // PRIMARY provider's key. Serving only the primary's audio guarantees a HIT
    // always replays the intended voice (never a stale fallback voice), and makes
    // cached lines play even through a primary-provider outage (no API call).
    if (this.cache?.has(spoken)) {
      try {
        const hit = this.cache.get(this.cache.key(primary.name, primary.cacheSignature(sopts), spoken));
        if (hit) {
          log.info("tts", `${primary.name} cache hit (~0ms): ${spoken.slice(0, 40)}`);
          return hit;
        }
      } catch (err) {
        log.warn("tts", `cache lookup failed — synthesizing (${err instanceof Error ? err.message : err})`);
      }
    }

    let lastErr: unknown;
    for (const provider of this.providers) {
      const startedAt = Date.now();
      try {
        const result = await provider.synth(spoken, sopts);
        // Providers resolve once audio starts streaming, so this is time-to-first-audio.
        log.info("tts", `${provider.name} started streaming in ${Date.now() - startedAt}ms`);
        // Capture a whitelisted line into the cache — but ONLY when the PRIMARY served
        // it, so the cache holds the intended voice's audio and never a fallback's.
        if (this.cache?.has(spoken) && provider === primary) {
          try {
            const key = this.cache.key(provider.name, provider.cacheSignature(sopts), spoken);
            result.stream = this.cache.capture(result.stream, key, result.inputType, result.voiceId);
          } catch (err) {
            log.warn("tts", `cache capture setup failed — not caching (${err instanceof Error ? err.message : err})`);
          }
        }
        return result;
      } catch (err) {
        lastErr = err;
        log.warn("tts", `${provider.name} failed after ${Date.now() - startedAt}ms (${err instanceof Error ? err.message : err}) — trying next`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("All TTS providers failed");
  }

  /**
   * Re-entrancy-guarded entry point: only one prewarm loop runs at a time, so a repeated
   * `/coachadmin tts prewarm` — or one overlapping the startup prewarm — can't spawn a
   * second loop that re-synthesizes the same not-yet-cached lines (duplicate paid calls +
   * a rate-limit burst). A duplicate request is a no-op.
   */
  async prewarm(
    voiceIds: string[],
    opts?: { delayMs?: number; busy?: () => boolean; signal?: AbortSignal },
  ): Promise<{ cached: number; skipped: number; failed: number }> {
    if (this.prewarming) {
      log.info("tts", "prewarm already in progress — ignoring the duplicate request");
      return { cached: 0, skipped: 0, failed: 0 };
    }
    this.prewarming = true;
    try {
      return await this._prewarm(voiceIds, opts);
    } finally {
      this.prewarming = false;
    }
  }

  /**
   * Pre-synthesize every cacheable static line for the given voices so the FIRST
   * live occurrence plays from cache with no delay (the user's explicit requirement).
   * Idempotent (skips lines already on disk), serial + spaced so it never bursts the
   * provider's rate limit, and it yields while a live line is being spoken. Routes
   * through synth() so its keys are identical to the live lookup's. Best run
   * fire-and-forget; non-ElevenLabs primaries collapse to one entry per line (their
   * signature ignores the voice), so the per-voice loop self-dedupes via peek().
   */
  private async _prewarm(
    voiceIds: string[],
    opts?: { delayMs?: number; busy?: () => boolean; signal?: AbortSignal },
  ): Promise<{ cached: number; skipped: number; failed: number }> {
    let cached = 0;
    let skipped = 0;
    let failed = 0;
    const cache = this.cache;
    const primary = this.providers[0];
    if (!cache || !primary) return { cached, skipped, failed };
    const texts = cacheableLineTexts();
    const delayMs = opts?.delayMs ?? 350;

    for (const voiceId of voiceIds) {
      for (const text of texts) {
        if (opts?.signal?.aborted) return { cached, skipped, failed };
        const spoken = normalizeForSpeech(text);
        // Skip if the primary already has this exact key on disk — no synth, no API.
        if (cache.peek(cache.key(primary.name, primary.cacheSignature({ voiceId }), spoken))) {
          skipped++;
          continue;
        }
        // Never compete with a live coaching line.
        while (opts?.busy?.() && !opts?.signal?.aborted) await sleep(2_000);
        try {
          const result = await this.synth(text, { voiceId });
          await drain(result.stream); // pull to a clean 'end' so capture() persists it
          cached++;
        } catch (err) {
          failed++;
          log.warn("tts", `prewarm failed for a line on voice ${voiceId} (${err instanceof Error ? err.message : err})`);
        }
        await sleep(delayMs);
      }
    }
    return { cached, skipped, failed };
  }
}
