/**
 * Pre-build the TTS audio cache for every static, latency-critical canned line
 * (the 10s bomb-timer, late-round, zeus, bomb plant/defuse/explode, match-point)
 * across all configured voices, so the FIRST live occurrence plays instantly:
 *
 *   npm run prewarm
 *
 * No Discord, no GSI server, no voice connection — it only needs the provider API
 * keys (from .env) and writes to the same state/tts-cache dir the running app reads,
 * so a deploy-time or post-voice-change warm carries straight over. Idempotent:
 * already-cached lines are skipped, so re-running is nearly free.
 */
import { config } from "../src/config.js";
import { log } from "../src/log.js";
import { cacheableLineTexts } from "../src/coach/lines.js";
import { TtsChain } from "../src/tts/index.js";
import { voices } from "../src/tts/voices.js";

async function main(): Promise<void> {
  if (!config.tts.cache.enabled) {
    log.warn("prewarm", "TTS cache is disabled (TTS_CACHE_ENABLED=false) — nothing to do.");
    return;
  }
  const tts = new TtsChain();
  const ids = voices().map((v) => v.voiceId);
  const lines = cacheableLineTexts().length;
  log.info("prewarm", `Warming ${lines} line(s) × ${ids.length} voice(s) → ${config.tts.cache.dir} …`);
  const r = await tts.prewarm(ids);
  log.info("prewarm", `Done: ${r.cached} synthesized, ${r.skipped} already cached, ${r.failed} failed.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error("prewarm", "failed", err);
    process.exit(1);
  });
