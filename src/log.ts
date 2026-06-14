import fs from "node:fs";
import path from "node:path";
import { tsStamp } from "./ndjson-sink.js";
import { runtime } from "./runtime-overrides.js";

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
      const stamp = tsStamp();
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
  /**
   * Verbose trace line, identical shape to info() but with a DEBUG tag. Emits
   * ONLY when debug is on (COACH_DEBUG=true, or toggled live via /coachadmin set) —
   * every caller can fire freely and the gate keeps normal sessions quiet. Used for the
   * engine's silent-drop reasons (why a moment never spoke) and similar diagnostics.
   */
  debug(scope: string, msg: string): void {
    if (!runtime.debug) return;
    const line = `${ts()} [${scope}] DEBUG ${msg}`;
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

// Only our own session artifacts are eligible — never touch unrelated files
// someone dropped in logs/.
const LOG_FILE_RE = /^(coach-.*\.log|gsi-.*\.ndjson|decisions-.*\.ndjson)$/;

/**
 * Delete our log artifacts in `dir` older than `retentionDays` days, so an
 * always-on host doesn't slowly fill its disk. No-op when retentionDays <= 0
 * (keep forever). Best-effort: a missing dir or a single un-deletable file never
 * throws — per-file errors are swallowed and we log one summary line. Called once
 * at startup, before the new session's own files are opened.
 */
export function pruneOldLogs(dir = "logs", retentionDays: number): void {
  if (retentionDays <= 0) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!LOG_FILE_RE.test(name)) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch {
        // A file we can't stat/delete (locked, vanished) — skip it, keep going.
      }
    }
  } catch {
    // No logs dir yet (fresh install) or it's unreadable — nothing to prune.
    return;
  }
  if (removed > 0) {
    log.info("log", `Pruned ${removed} log file${removed === 1 ? "" : "s"} older than ${retentionDays}d from ${dir}`);
  }
}

/** Flush and close the on-disk log sink — called on shutdown so the final lines are written. */
export async function closeLog(): Promise<void> {
  const s = sink;
  sink = null;
  if (!s) return;
  await new Promise<void>((resolve) => {
    s.end(() => resolve());
  });
}
