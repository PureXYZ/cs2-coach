import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./log.js";

/**
 * Tiny shared persistence for the bits of state the coach remembers across
 * restarts as a small JSON file — the last-joined voice channel
 * (discord/voice-state.ts) and the picked coach voice (tts/voices.ts). Each file
 * lives under state/, a Docker volume on the hosted deploy.
 *
 * All three helpers swallow fs errors to a log.warn so a disk hiccup never
 * crashes a live match: a failed read just behaves as "nothing saved".
 */

export function saveJsonState(file: string, tag: string, data: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data), "utf8");
  } catch (err) {
    log.warn(tag, `Could not save state ${file}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Read + parse a state file. `parse` validates the raw JSON and returns the
 *  typed value (or null to reject it); a missing/corrupt file also yields null. */
export function loadJsonState<T>(file: string, tag: string, parse: (raw: unknown) => T | null): T | null {
  try {
    if (!existsSync(file)) return null;
    return parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    log.warn(tag, `Could not read state ${file}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export function clearJsonState(file: string, tag: string): void {
  try {
    rmSync(file, { force: true });
  } catch (err) {
    log.warn(tag, `Could not clear state ${file}: ${err instanceof Error ? err.message : err}`);
  }
}
