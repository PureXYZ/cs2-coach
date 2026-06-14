import { TTS_TTFB_MS } from "./constants.js";

/**
 * Shared time-to-first-byte fetch for the REST TTS providers (Deepgram, ElevenLabs).
 *
 * Guards only time-to-first-byte: the body is an audio stream consumed lazily DURING
 * playback, so a fixed AbortSignal on the whole fetch would tear the connection down
 * mid-stream and cut a long line off mid-sentence. The abort timer fires only until
 * the headers land — a genuinely stalled request (no headers) still fails fast and
 * falls through to the next provider; once streaming starts it runs as long as the
 * audio needs. Tradeoff: a rarer headers-then-no-audio stall no longer fails over —
 * it's caught downstream by the idleGuarded watchdog / the synth deadline, which
 * drop the line and advance rather than retrying the next provider.
 *
 * On a non-OK status or a missing body it reads (a slice of) the error body and
 * throws with `providerName` in the message — so the chain logs which provider
 * failed and falls through. The caller owns `idleGuarded(Readable.fromWeb(res.body))`
 * and result shaping; this returns a Response guaranteed to have a usable `body`.
 */
export async function ttfbFetch(
  url: URL | string,
  init: RequestInit,
  providerName: string,
): Promise<Response> {
  const controller = new AbortController();
  const ttfbTimer = setTimeout(() => controller.abort(), TTS_TTFB_MS);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(ttfbTimer);
  }

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${providerName} TTS HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }

  return res;
}
