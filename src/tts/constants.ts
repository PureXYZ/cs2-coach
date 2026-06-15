/** Mid-stream stall watchdog window — the per-fetch abort guards only TTFB; this catches a header-then-stall. */
export const STREAM_IDLE_MS = 5_000;
/** Time-to-first-byte abort budget for the REST providers (Deepgram, ElevenLabs). Cleared once headers arrive. */
export const TTS_TTFB_MS = 10_000;
/** Big enough to hold any single coach line's Opus audio (a 40s line at 64 kbps
 *  is ~320 KB) so a slow/prefetched reader never backpressures the source. Used by
 *  both the idle watchdog Transform (idle.ts) and the cache capture-tee (cache.ts). */
export const NO_BACKPRESSURE_HWM = 8 * 1024 * 1024;
