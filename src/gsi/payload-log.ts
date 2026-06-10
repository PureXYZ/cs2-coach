import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";
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
  private stream: fs.WriteStream | null = null;
  private disabled = false;
  private readonly file: string;

  constructor(dir = "logs") {
    const stamp = new Date().toISOString().replace(/:/g, "-").slice(0, 19);
    this.file = path.join(dir, `gsi-${stamp}.ndjson`);
  }

  write(payload: GsiPayload, events: CoachEvent[]): void {
    if (this.disabled) return;
    if (!this.stream) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this.stream = fs.createWriteStream(this.file, { flags: "a" });
        // A dead stream (disk full, locked dir) must never crash or spam — warn once, stop.
        this.stream.on("error", (err) => {
          this.disabled = true;
          log.warn("gsi", `Payload log write failed (${err.message}) — raw GSI logging off for this session`);
        });
        log.info("gsi", `Recording raw GSI payloads to ${this.file}`);
      } catch (err) {
        this.disabled = true;
        log.warn(
          "gsi",
          `Could not open ${this.file} (${err instanceof Error ? err.message : String(err)}) — raw GSI logging off`,
        );
        return;
      }
    }
    this.stream.write(
      JSON.stringify({ at: new Date().toISOString(), events: events.length > 0 ? events : undefined, payload }) + "\n",
    );
  }
}
