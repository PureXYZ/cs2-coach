/** Mid-stream stall watchdog window — the per-fetch abort guards only TTFB; this catches a header-then-stall. */
export const STREAM_IDLE_MS = 5_000;
/** Time-to-first-byte abort budget for the REST providers (Deepgram, ElevenLabs). Cleared once headers arrive. */
export const TTS_TTFB_MS = 10_000;
