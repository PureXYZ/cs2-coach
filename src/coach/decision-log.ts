import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";
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
  private stream: fs.WriteStream | null = null;
  private disabled = false;
  private readonly file: string;

  constructor(dir = "logs") {
    const stamp = new Date().toISOString().replace(/:/g, "-").slice(0, 19);
    this.file = path.join(dir, `decisions-${stamp}.ndjson`);
  }

  write(rec: DecisionRecord): void {
    if (this.disabled) return;
    if (!this.stream) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this.stream = fs.createWriteStream(this.file, { flags: "a" });
        // A dead stream (disk full, locked dir) must never crash or spam — warn once, stop.
        this.stream.on("error", (err) => {
          this.disabled = true;
          log.warn("coach", `Decision log write failed (${err.message}) — decision logging off for this session`);
        });
        log.info("coach", `Recording coaching decisions to ${this.file}`);
      } catch (err) {
        this.disabled = true;
        log.warn(
          "coach",
          `Could not open ${this.file} (${err instanceof Error ? err.message : String(err)}) — decision logging off`,
        );
        return;
      }
    }
    // Redacted lines (Leetify-derived) record their length only — never the text.
    const textField = rec.redact ? { textLen: rec.text.length } : { text: rec.text };
    this.stream.write(
      JSON.stringify({
        at: new Date().toISOString(),
        eventType: rec.event.type,
        tier: rec.tier,
        source: rec.source,
        snapshot: rec.snapshot,
        ...textField,
      }) + "\n",
    );
  }
}
