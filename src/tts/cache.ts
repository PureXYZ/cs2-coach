import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable, Transform, finished } from "node:stream";
import type { StreamType } from "@discordjs/voice";
import { log } from "../log.js";
import { normalizeForSpeech } from "./normalize.js";
import type { TtsResult } from "./types.js";

/** Bump when the manifest shape or key scheme changes — an older index loads empty. */
const MANIFEST_VERSION = 1;
/** Oversized so a slow/prefetched reader never backpressures the source (mirrors idle.ts). */
const NO_BACKPRESSURE_HWM = 8 * 1024 * 1024;
/** Stop accumulating (but keep playing) if a whitelisted line is unexpectedly huge. */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

interface CacheEntry {
  /** Audio blob filename within the cache dir. */
  file: string;
  /** StreamType the bytes were encoded as (Ogg vs WebM/Opus) — must replay exactly. */
  inputType: StreamType;
  /** ElevenLabs voice id, for the player's per-voice volume. Unset for Deepgram/Edge. */
  voiceId?: string;
  /** Byte length, validated against the blob on load/read. */
  bytes: number;
  /** Epoch ms of the last write — the LRU eviction key. */
  lastUsedAt: number;
}

interface Manifest {
  version: number;
  entries: Record<string, CacheEntry>;
}

/**
 * Disk-backed audio cache for the static, latency-critical canned lines. A HIT
 * replays stored Opus with ~0 ms synth instead of a ~225–900 ms provider round-trip.
 *
 * WHITELIST-GATED: only lines whose normalized text is in `whitelist` (the
 * cacheableLineTexts() set) are ever cached — so interpolated/LLM lines can never
 * pollute it and the engine needs zero plumbing.
 *
 * Correctness invariants (see the design notes):
 *  - A TRUNCATED line is never persisted: capture() writes only when node:stream
 *    `finished()` reports a clean end (no error/destroy) AND a non-zero length —
 *    so a superseded/overflowed/stalled line is dropped, never cached half-spoken.
 *  - The capture is a SINGLE pass-through Transform the consumer reads from — never
 *    a second reader (a 'data' listener would flip the source to flowing and steal
 *    bytes from the audio consumer; see idle.ts).
 *  - A HIT replays the stored inputType + voiceId exactly (voiceId only when the
 *    producing provider set one), so per-voice volume still applies downstream.
 *  - Any cache error degrades to a normal synth — caching is purely additive.
 */
export class TtsCache {
  private readonly whitelist: Set<string>;
  private readonly index = new Map<string, CacheEntry>();
  private readonly manifestPath: string;
  /** Per-writer counter so two writers never share a tmp path — see write()/persist(). */
  private tmpSeq = 0;

  constructor(
    private readonly dir: string,
    private readonly maxEntries: number,
    cacheableTexts: string[],
  ) {
    // Whitelist holds NORMALIZED text; synth() passes its already-normalized
    // `spoken` to has()/key(), so the two always agree (normalize runs once).
    this.whitelist = new Set(cacheableTexts.map(normalizeForSpeech));
    this.manifestPath = join(dir, "index.json");
    this.load();
  }

  /** Whether this exact (already-normalized) line is allowed in the cache. */
  has(spoken: string): boolean {
    return this.whitelist.has(spoken);
  }

  /** Deterministic key for a (provider, signature, line). The provider name is in
   *  the key so an Ogg/Opus ElevenLabs entry and a WebM/Opus Edge entry for the same
   *  text never collide, and the per-provider lookup picks the right one. */
  key(providerName: string, signature: string, spoken: string): string {
    // Length-prefixed join so no field value (a signature or line may contain any
    // punctuation) can be misread across a boundary — and it stays printable ASCII,
    // since a raw NUL separator would make git treat this whole file as binary.
    return createHash("sha256")
      .update(`${providerName.length}:${providerName}:${signature.length}:${signature}:${spoken}`)
      .digest("hex");
  }

  /** True if this key has a usable blob on disk — a cheap skip check for prewarm. */
  peek(key: string): boolean {
    return this.index.has(key);
  }

  /** A HIT replayed as a fresh stream, or null on miss / unreadable blob. */
  get(key: string): TtsResult | null {
    const entry = this.index.get(key);
    if (!entry) return null;
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(this.dir, entry.file));
    } catch (err) {
      // Blob vanished under us — drop the dangling entry and miss cleanly.
      log.warn("tts", `cache blob unreadable, dropping entry (${err instanceof Error ? err.message : err})`);
      this.index.delete(key);
      this.persist();
      return null;
    }
    if (bytes.length !== entry.bytes) {
      log.warn("tts", "cache blob length mismatch — dropping entry");
      this.index.delete(key);
      this.persist();
      return null;
    }
    // A buffer-backed stream can't stall, so no idleGuarded. But voice.ts may
    // destroy() it (supersede/overflow), which can emit 'error' — pre-attach a
    // no-op listener so that can never become an uncaught exception (idle.ts:44).
    const stream = new Readable({ read() {} });
    stream.on("error", () => {});
    stream.push(bytes);
    stream.push(null);
    return { stream, inputType: entry.inputType, voiceId: entry.voiceId };
  }

  /**
   * Wrap a freshly-synthesized (already idleGuarded) stream so the bytes the player
   * consumes are captured and persisted under `key` — but ONLY if the stream ends
   * cleanly. Returns the single pass-through the consumer must read from.
   */
  capture(src: Readable, key: string, inputType: StreamType, voiceId: string | undefined): Readable {
    const chunks: Buffer[] = [];
    let total = 0;
    let capturing = true;
    const tee = new Transform({
      highWaterMark: NO_BACKPRESSURE_HWM,
      transform(chunk, _enc, cb) {
        if (capturing) {
          total += chunk.length;
          if (total > MAX_CAPTURE_BYTES) {
            // Unexpectedly large for a canned line — stop hoarding, keep playing.
            capturing = false;
            chunks.length = 0;
          } else {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
        }
        cb(null, chunk);
      },
    });
    // Same teardown discipline as idle.ts: never crash on a pre-handler destroy,
    // and tear the source down with the tee so a dropped line can't leak the body.
    tee.on("error", () => {});
    src.once("error", (err) => tee.destroy(err));
    tee.once("close", () => {
      if (!src.destroyed) src.destroy();
    });
    src.pipe(tee);
    // finished() is the version-robust "did this end cleanly" primitive: it calls
    // back with an error on ANY destroy/abort/premature-close (every voice.ts drop
    // path + the idle watchdog), and with no error ONLY on a genuine clean end.
    finished(tee, (err) => {
      if (err || !capturing || total === 0) return;
      try {
        this.write(key, Buffer.concat(chunks), inputType, voiceId);
      } catch (writeErr) {
        log.warn("tts", `cache write failed (${writeErr instanceof Error ? writeErr.message : writeErr})`);
      }
    });
    return tee;
  }

  // --- persistence ---------------------------------------------------------

  private load(): void {
    try {
      if (!existsSync(this.manifestPath)) return;
      const parsed = JSON.parse(readFileSync(this.manifestPath, "utf8")) as Manifest;
      if (!parsed || parsed.version !== MANIFEST_VERSION || typeof parsed.entries !== "object") return;
      for (const [key, entry] of Object.entries(parsed.entries)) {
        // Drop any entry whose blob is gone (a crash between blob+manifest writes,
        // or a manual cleanup) so get() never serves a dangling reference.
        if (entry && typeof entry.file === "string" && existsSync(join(this.dir, entry.file))) {
          this.index.set(key, entry);
        }
      }
      if (this.index.size > 0) log.info("tts", `cache: ${this.index.size} line(s) loaded from ${this.dir}`);
    } catch (err) {
      // Corrupt manifest → start empty and re-warm; never crash on a bad file.
      log.warn("tts", `cache manifest unreadable — starting empty (${err instanceof Error ? err.message : err})`);
      this.index.clear();
    }
  }

  private write(key: string, buf: Buffer, inputType: StreamType, voiceId: string | undefined): void {
    if (buf.length === 0) return;
    mkdirSync(this.dir, { recursive: true });
    const file = `${key}.bin`;
    const blobPath = join(this.dir, file);
    // Blob first (tmp+rename), THEN the manifest entry — so a crash between the two
    // leaves an orphan blob (harmless, GC'd on the next load) but never a manifest
    // row pointing at a half-written file. The tmp name is unique per writer
    // (pid + a private counter) so a concurrent `npm run prewarm` and the app's own
    // background prewarm — which share this dir and key scheme — never collide on the
    // same tmp and rename a half-written file over a good blob; the only cross-process
    // effect is a benign last-writer-wins of two complete, byte-valid blobs.
    const tmp = `${blobPath}.${process.pid}.${this.tmpSeq++}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, blobPath);
    this.index.set(key, { file, inputType, voiceId, bytes: buf.length, lastUsedAt: Date.now() });
    this.evict();
    this.persist();
  }

  /** Evict the oldest-written entries past the cap (a safety net; the live set is tiny). */
  private evict(): void {
    if (this.maxEntries <= 0 || this.index.size <= this.maxEntries) return;
    const ordered = [...this.index.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [key, entry] of ordered) {
      if (this.index.size <= this.maxEntries) break;
      this.index.delete(key);
      try {
        unlinkSync(join(this.dir, entry.file));
      } catch {
        // Blob already gone — fine.
      }
    }
  }

  private persist(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const manifest: Manifest = { version: MANIFEST_VERSION, entries: Object.fromEntries(this.index) };
      // Unique tmp per writer (see write()) so a concurrent CLI prewarm + the app
      // can't rename a half-written manifest over the live one — atomic rename then
      // means last-writer-wins of two complete manifests, never a torn file.
      const tmp = `${this.manifestPath}.${process.pid}.${this.tmpSeq++}.tmp`;
      writeFileSync(tmp, JSON.stringify(manifest), "utf8");
      renameSync(tmp, this.manifestPath);
    } catch (err) {
      log.warn("tts", `cache manifest write failed (${err instanceof Error ? err.message : err})`);
    }
  }
}
