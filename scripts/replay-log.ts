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
 * For a multi-feed capture, pass a provider.steamid as the second arg to keep
 * only that player's frames before replaying:
 *   npm run replay -- logs/gsi-....ndjson 7656119xxxxxxxxxx
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
  console.error("usage: npm run replay -- <logs/gsi-*.ndjson> [provider.steamid]");
  process.exit(2);
}
// Optional: keep only one player's frames out of a multi-feed capture.
const providerFilter = process.argv[3];

interface LoggedFrame {
  at: string;
  events?: CoachEvent[];
  payload: GsiPayload;
}

let frames: LoggedFrame[] = [];
fs.readFileSync(file, "utf8")
  .split("\n")
  .forEach((line, i) => {
    if (!line) return; // blank line (e.g. the trailing newline) — not malformed, just skip
    try {
      frames.push(JSON.parse(line));
    } catch {
      // A truncated tail (e.g. the process crashed mid-write) leaves one bad line — skip it
      // but report the PHYSICAL line number (i is the real index now, pre-filter) so the
      // operator can find it and knows the replay was partial.
      console.error(`skipping malformed line ${i + 1}`);
    }
  });

// A single GsiTracker can only honestly replay ONE player's feed. Multi-feed
// logs interleave several friends' payloads (one provider.steamid each); pushed
// through one tracker they mix players, and the logged events are the fused
// RosterManager output — so the diff is noise, not regression signal. Detect
// that up front and either filter to a chosen provider or warn loudly.
const providers = [...new Set(frames.map((f) => f.payload.provider?.steamid).filter(Boolean))];
if (providerFilter) {
  frames = frames.filter((f) => f.payload.provider?.steamid === providerFilter);
  console.log(`Filtered to provider ${providerFilter}: ${frames.length} frame(s) kept.`);
  if (frames.length === 0) {
    console.error(`No frames matched provider ${providerFilter}. Present providers: ${providers.join(", ")}`);
    process.exit(2);
  }
} else if (providers.length > 1) {
  console.warn(
    `WARNING: this log mixes ${providers.length} provider feeds (${providers.join(", ")}).\n` +
      "  Replaying a multi-feed capture through a single tracker mixes players and the\n" +
      "  logged events are the fused roster output, so every diff below will mislead.\n" +
      "  Re-run with one of those ids as the second arg to filter, e.g.\n" +
      `    npm run replay -- ${file} ${providers[0]}`,
  );
}

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
