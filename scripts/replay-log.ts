/**
 * Replays a captured GSI payload log (logs/gsi-*.ndjson, written by
 * GsiPayloadLog) through the current GsiTracker and diffs the events it
 * derives NOW against the events the live session derived THEN — the
 * regression harness for detection changes: after editing tracker logic,
 * every diff this prints is either the intended fix or an unintended change.
 *
 * Date.now is stubbed to each frame's `at` stamp, so time-window heuristics
 * (nade kill windows, derived clocks) behave exactly as they did live.
 *
 * Run:  npm run replay -- logs/gsi-2026-06-10T22-01-22.ndjson
 *
 * NOTE: this replays through a SINGLE GsiTracker, so it's meaningful for a
 * single-player capture. A multi-feed log interleaves several friends' payloads
 * (distinguished by provider.steamid); feeding those through one tracker mixes
 * players, and the logged `events` are the fused RosterManager output rather than
 * one tracker's — so expect diffs. Filter a multi-feed log to one provider.steamid
 * before replaying it here, or lean on `npm run sim`'s roster scenarios instead.
 */
import fs from "node:fs";

// Must be set before config.ts loads; dotenv never overrides existing env vars.
process.env.DISCORD_TOKEN ||= "replay";

const { GsiTracker } = await import("../src/gsi/tracker.js");
import type { GsiPayload } from "../src/gsi/types.js";
import type { CoachEvent } from "../src/gsi/tracker.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: npm run replay -- <logs/gsi-*.ndjson>");
  process.exit(2);
}

interface LoggedFrame {
  at: string;
  events?: CoachEvent[];
  payload: GsiPayload;
}

const frames: LoggedFrame[] = fs
  .readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const realNow = Date.now;
let frameNow = realNow();
Date.now = () => frameNow;

const tracker = new GsiTracker();
let diffs = 0;
frames.forEach((frame, i) => {
  frameNow = Date.parse(frame.at);
  const derived = tracker.update(frame.payload);
  const logged = JSON.stringify(frame.events ?? []);
  const now = JSON.stringify(derived);
  if (logged !== now) {
    diffs++;
    console.log(`line ${i + 1} (${frame.at}):`);
    console.log(`  live session: ${logged}`);
    console.log(`  current code: ${now}`);
  }
});
Date.now = realNow;

console.log(`${frames.length} frames replayed, ${diffs} frame(s) differ from the live session.`);
