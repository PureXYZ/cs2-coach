import fs from "node:fs";
import path from "node:path";

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

/** Optional mirror of every line to disk (lazily opened by log.toFile). */
let sink: fs.WriteStream | null = null;

function emit(line: string): void {
  sink?.write(line + "\n");
}

export const log = {
  /**
   * Mirror all log lines to logs/coach-<session start>.log — the on-disk record
   * of what was spoken, dropped, and how slow LLM/TTS were, so a session can be
   * investigated after the fact (the GSI ndjson only covers detection). Called
   * once at app startup; sim/replay scripts never call it and stay file-free.
   * A dead sink (disk full, locked dir) silently reverts to console-only.
   */
  toFile(dir = "logs"): void {
    if (sink) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/:/g, "-").slice(0, 19);
      const stream = fs.createWriteStream(path.join(dir, `coach-${stamp}.log`), { flags: "a" });
      stream.on("error", () => {
        sink = null;
      });
      sink = stream;
    } catch {
      sink = null;
    }
  },
  info(scope: string, msg: string): void {
    const line = `${ts()} [${scope}] ${msg}`;
    console.log(line);
    emit(line);
  },
  warn(scope: string, msg: string): void {
    const line = `${ts()} [${scope}] WARN ${msg}`;
    console.warn(line);
    emit(line);
  },
  error(scope: string, msg: string, err?: unknown): void {
    const detail = err instanceof Error ? ` — ${err.message}` : err ? ` — ${String(err)}` : "";
    const line = `${ts()} [${scope}] ERROR ${msg}${detail}`;
    console.error(line);
    emit(line);
  },
};
