import fs from "node:fs";
import path from "node:path";
import { log } from "./log.js";

/**
 * Session-start filename slug: an ISO-8601 timestamp with ':' replaced by '-'
 * (so it's a legal filename on every OS) and sliced to the first 19 chars
 * (date + seconds, no fractional millis). Shared by every per-session sink so
 * the gsi/decisions/coach files of one run share an identical stamp.
 */
export function tsStamp(): string {
  return new Date().toISOString().replace(/:/g, "-").slice(0, 19);
}

/**
 * A lazily-opened, append-mode NDJSON file sink. The first write() creates the
 * dir and stream; a dead stream (disk full, locked dir) disables the sink and
 * warns ONCE under `tag`, never crashing or spamming. The filename is
 * <dir>/<prefix><session start>.ndjson — one file per process start, so idle
 * sessions leave nothing behind. Callers own per-record serialization and pass
 * the already-shaped object to write(); the sink JSON-stringifies and appends a
 * newline. Backs GsiPayloadLog and DecisionLog, which differ only in prefix,
 * tag, and the records they hand in.
 */
export function createNdjsonSink({ dir, prefix, tag }: { dir: string; prefix: string; tag: string }) {
  const file = path.join(dir, `${prefix}${tsStamp()}.ndjson`);
  let stream: fs.WriteStream | null = null;
  let disabled = false;

  return {
    /** The resolved file path, so callers can mention it (none currently do). */
    get file(): string {
      return file;
    },
    /** True once a write error or close() has shut the sink down for good. */
    get disabled(): boolean {
      return disabled;
    },
    /** Serialize `record` as one NDJSON line, opening the stream on first call. */
    write(record: unknown): void {
      if (disabled) return;
      if (!stream) {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          stream = fs.createWriteStream(file, { flags: "a" });
          // A dead stream (disk full, locked dir) must never crash or spam — warn once, stop.
          stream.on("error", (err) => {
            disabled = true;
            log.warn(tag, `${prefix}log write failed (${err.message}) — logging off for this session`);
          });
          log.info(tag, `Recording to ${file}`);
        } catch (err) {
          disabled = true;
          log.warn(tag, `Could not open ${file} (${err instanceof Error ? err.message : String(err)}) — logging off`);
          return;
        }
      }
      stream.write(JSON.stringify(record) + "\n");
    },
    /** Flush and close the stream — called on shutdown so the final lines hit disk. */
    async close(): Promise<void> {
      // Lazily opened, so the stream may never have been created — nothing to flush then.
      const s = stream;
      stream = null;
      disabled = true;
      if (!s) return;
      await new Promise<void>((resolve) => {
        s.end(() => resolve());
      });
    },
  };
}
