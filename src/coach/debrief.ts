import type { MatchContext, CoachEvent } from "../gsi/tracker.js";
import type { RoundRecord } from "../gsi/memory.js";
import type { SessionMatchRecord } from "./session-store.js";

type MatchEndEvent = Extract<CoachEvent, { type: "matchEnd" }>;

export interface MatchReport {
  rounds: readonly RoundRecord[];
  pistols: { first?: "won" | "lost"; second?: "won" | "lost" };
  earlyDeaths: number;
  notables: string[];
  /** Own K/A/D/MVPs from the last self frame — the gameover context fields are
   *  empty whenever the player died in the final round (spectate switch). */
  stats?: { kills: number; assists: number; deaths: number; mvps: number };
  /** A spectated teammate had a bot steamid — practice match, don't persist. */
  botsDetected: boolean;
}

// Forensic notable markers — must match the strings tracker.ts records.
// "died burning" is a prefix of the own-molly variant, so one marker counts both.
const MARK_FLASHED = "died while flashed";
const MARK_BURNING = "died burning";
const MARK_POCKET_NADES = "unthrown grenades";

function countNotable(rounds: readonly RoundRecord[], marker: string): number {
  return rounds.reduce((n, r) => n + r.notable.filter((s) => s.includes(marker)).length, 0);
}

/** The match as a SessionMatchRecord — own GSI-derived data only, safe to persist. */
export function buildMatchRecord(event: MatchEndEvent, ctx: MatchContext, report: MatchReport): SessionMatchRecord {
  const buys = { eco: 0, force: 0, full: 0 };
  for (const r of report.rounds) {
    if (r.buy === "eco" || r.buy === "force" || r.buy === "full") buys[r.buy]++;
  }
  return {
    endedAt: new Date().toISOString(),
    map: ctx.map,
    mode: ctx.mode,
    won: event.won,
    ourScore: event.ourScore,
    theirScore: event.theirScore,
    // ctx fields are empty when the player died in the final round (the
    // gameover player block is a spectated teammate) — fall back to the
    // tracker's last-own-frame cache.
    kills: ctx.kills ?? report.stats?.kills,
    assists: ctx.assists ?? report.stats?.assists,
    deaths: ctx.deaths ?? report.stats?.deaths,
    mvps: ctx.mvps ?? report.stats?.mvps,
    pistols: report.pistols,
    buys,
    earlyDeaths: report.earlyDeaths || undefined,
    diedBlind: countNotable(report.rounds, MARK_FLASHED) || undefined,
    diedBurning: countNotable(report.rounds, MARK_BURNING) || undefined,
    diedWithNades: countNotable(report.rounds, MARK_POCKET_NADES) || undefined,
    notables: report.notables.slice(0, 8),
    roundsPlayed: report.rounds.length,
  };
}
