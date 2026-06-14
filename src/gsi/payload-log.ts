import { createNdjsonSink } from "../ndjson-sink.js";
import type { CoachEvent } from "./tracker.js";
import type { GsiPayload } from "./types.js";

/**
 * Appends every authenticated GSI payload — plus the coach events the tracker
 * derived from it — as one NDJSON line to logs/gsi-<session start>.ndjson.
 * The point is offline analysis: when a detection misfires (a missed nade kill,
 * a phantom event), the exact frames CS2 sent are on disk to replay and study,
 * and the `previously`/`added` delta blocks show what changed in each frame.
 * One file per process start; opened lazily so idle sessions leave nothing.
 */
export class GsiPayloadLog {
  private readonly sink: ReturnType<typeof createNdjsonSink>;

  constructor(dir = "logs") {
    this.sink = createNdjsonSink({ dir, prefix: "gsi-", tag: "gsi", what: "raw GSI payloads" });
  }

  write(payload: GsiPayload, events: CoachEvent[]): void {
    if (this.sink.disabled) return;
    // Drop the auth block — it carries the shared GSI secret, which must never reach disk.
    // CS2's `previously`/`added` delta blocks can mirror that auth block too, so strip it
    // from those nested copies as well — but without mutating the original payload, which the
    // tracker still holds a reference to.
    const stripAuth = (v: unknown): unknown => {
      if (v && typeof v === "object" && !Array.isArray(v) && "auth" in (v as Record<string, unknown>)) {
        const c = { ...(v as Record<string, unknown>) };
        delete c.auth;
        return c;
      }
      return v;
    };
    const safe: GsiPayload = { ...payload };
    delete safe.auth;
    if (safe.previously !== undefined) safe.previously = stripAuth(safe.previously);
    if (safe.added !== undefined) safe.added = stripAuth(safe.added);
    this.sink.write({ at: new Date().toISOString(), events: events.length > 0 ? events : undefined, payload: safe });
  }

  /** Flush and close the stream — called on shutdown so the final frames hit disk. */
  async close(): Promise<void> {
    await this.sink.close();
  }
}
