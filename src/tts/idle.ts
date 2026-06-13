import { Transform, type Readable } from "node:stream";

/** Big enough to hold any single coach line's Opus audio (a 40s line at 64 kbps
 *  is ~320 KB) so the reader never backpressures the source — see below. */
const NO_BACKPRESSURE_HWM = 8 * 1024 * 1024;

/**
 * Wrap an audio stream so it self-destructs if the PROVIDER stalls mid-stream —
 * headers received, then the body stops arriving. The provider fetches now clear
 * their abort timer once headers land (so a long line's body can stream as long
 * as the audio needs), which removed the only upper bound on a header-then-stall;
 * without this the Discord player would sit Buffering forever and wedge the voice
 * queue (pump() only re-runs on the player going Idle/error). The guard's error
 * is caught by the voice queue's stream 'error' handler, which advances pump().
 *
 * Two subtleties make this correct rather than a footgun:
 *  - A pass-through Transform observes throughput WITHOUT consuming it (a `data`
 *    listener on the source would flip it to flowing mode and steal bytes from
 *    the audio consumer).
 *  - The idle timer is armed on each chunk and CLEARED when the source ENDS, and
 *    the Transform is given an oversized highWaterMark so a slow/idle reader (a
 *    line waiting in the prefetch slot behind a long line) never backpressures
 *    the source. Result: bytes flow source->guard as fast as the source delivers
 *    regardless of when playback starts, the timer tracks the SOURCE's delivery
 *    gaps only, and once the source has fully delivered the line the timer is off
 *    for good — so a prefetched line can wait indefinitely without being killed.
 */
export function idleGuarded(src: Readable, ms: number): Readable {
  let timer: NodeJS.Timeout | undefined;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const guard = new Transform({
    highWaterMark: NO_BACKPRESSURE_HWM,
    transform(chunk, _enc, cb) {
      clear();
      timer = setTimeout(() => guard.destroy(new Error(`TTS stream idle for ${ms}ms`)), ms);
      cb(null, chunk);
    },
  });
  // Guarantee the guard always has an error listener so a destroy(err) before the
  // consumer attaches its own handler can never become an uncaught exception.
  guard.on("error", () => {});
  timer = setTimeout(() => guard.destroy(new Error(`TTS stream idle for ${ms}ms`)), ms);
  // Source done sending: the line arrived in full, no stall is possible anymore —
  // disarm so a slow reader (prefetch hold) can never trip the watchdog.
  src.once("end", clear);
  src.once("error", (err) => guard.destroy(err));
  // Tear the source down with the guard so a destroyed guard never leaves the
  // fetch body dangling. Guard against re-destroying an already-finished source.
  guard.once("close", () => {
    clear();
    if (!src.destroyed) src.destroy();
  });
  src.pipe(guard);
  return guard;
}
