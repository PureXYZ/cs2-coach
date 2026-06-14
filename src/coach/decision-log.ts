import { createNdjsonSink } from "../ndjson-sink.js";
import type { CoachEvent, MatchContext } from "../gsi/tracker.js";

/**
 * One coaching decision, captured for offline study: what the coach saw, what
 * it decided to do about it, and which tier/source produced the line. The
 * `redact` flag exists for Leetify-derived lines — those quote third-party
 * stats we are not allowed to persist, so we store only the length, never the
 * text, to keep the no-store discipline while still recording that a call fired.
 */
export interface DecisionRecord {
  snapshot: MatchContext;
  event: CoachEvent;
  tier: string;
  text: string;
  source: string;
  redact?: boolean;
}

/**
 * Appends every spoken (or fallback) coaching decision as one NDJSON line to
 * logs/decisions-<session start>.ndjson — the "why did it say that" record that
 * pairs with the raw GSI ndjson. Opened lazily, one file per process start; a
 * dead stream disables the sink and never crashes. Mirrors GsiPayloadLog.
 */
export class DecisionLog {
  private readonly sink: ReturnType<typeof createNdjsonSink>;

  constructor(dir = "logs") {
    this.sink = createNdjsonSink({ dir, prefix: "decisions-", tag: "coach" });
  }

  write(rec: DecisionRecord): void {
    if (this.sink.disabled) return;
    // Redacted lines (Leetify-derived) record their length only — never the text.
    const textField = rec.redact ? { textLen: rec.text.length } : { text: rec.text };
    this.sink.write({
      at: new Date().toISOString(),
      eventType: rec.event.type,
      tier: rec.tier,
      source: rec.source,
      snapshot: rec.snapshot,
      ...textField,
    });
  }

  /** Flush and close the stream — called on shutdown so the final decisions hit disk. */
  async close(): Promise<void> {
    await this.sink.close();
  }
}
