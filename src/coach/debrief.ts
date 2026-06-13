import type { MatchContext, CoachEvent } from "../gsi/tracker.js";
import type { RoundRecord } from "../gsi/memory.js";
import type { SessionMatchRecord } from "./session-store.js";
import { mapDisplayName } from "./lines.js";

type MatchEndEvent = Extract<CoachEvent, { type: "matchEnd" }>;

export interface MatchReport {
  rounds: readonly RoundRecord[];
  pistols: { first?: "won" | "lost"; second?: "won" | "lost" };
  earlyDeaths: number;
  notables: string[];
  /** Own K/A/D/MVPs from the last self frame — the gameover context fields are
   *  empty whenever the player died in the final round (spectate switch). */
  stats?: { kills: number; assists: number; deaths: number; mvps: number };
}

/** Everything the Discord embed needs, renderer-agnostic (bot.ts builds the embed). */
export interface DebriefData {
  title: string;
  won?: boolean;
  scoreline: string;
  /** "14/4/19 · 2 MVPs" — undefined only when the coach never saw an own frame
   *  (joined after the match, or GSI never flowed). */
  playerLine?: string;
  pistolsLine?: string;
  buysLine?: string;
  highlights: string[];
  /** The Opus-written paragraph; absent when the LLM is off or errored. */
  coachNotes?: string;
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

/** Compact plain-text scorecard — both the embed's body and the LLM's input. */
export function buildDebriefData(rec: SessionMatchRecord): DebriefData {
  const map = rec.map ? mapDisplayName(rec.map) : "Unknown map";
  const result = rec.won === undefined ? "" : rec.won ? " — W" : " — L";
  const pistolWord = (p?: string) => (p === "won" ? "✅" : p === "lost" ? "❌" : "—");

  const playerLine =
    rec.kills !== undefined
      ? `${rec.kills}/${rec.assists ?? 0}/${rec.deaths ?? 0}${rec.mvps ? ` · ${rec.mvps} MVP${rec.mvps > 1 ? "s" : ""}` : ""}`
      : undefined;

  const habits: string[] = [];
  if (rec.earlyDeaths) habits.push(`${rec.earlyDeaths} opening-seconds death${rec.earlyDeaths > 1 ? "s" : ""}`);
  if (rec.diedBlind) habits.push(`died flashed ×${rec.diedBlind}`);
  if (rec.diedBurning) habits.push(`died burning ×${rec.diedBurning}`);
  if (rec.diedWithNades) habits.push(`died holding nades ×${rec.diedWithNades}`);

  return {
    title: `Match debrief — ${map} ${rec.ourScore}-${rec.theirScore}${result}`,
    won: rec.won,
    scoreline: `${rec.ourScore}-${rec.theirScore}${rec.roundsPlayed ? ` over ${rec.roundsPlayed} rounds` : ""}`,
    playerLine,
    pistolsLine:
      rec.pistols?.first || rec.pistols?.second
        ? `1st ${pistolWord(rec.pistols?.first)} · 2nd ${pistolWord(rec.pistols?.second)}`
        : undefined,
    buysLine: rec.buys ? `${rec.buys.full} full · ${rec.buys.force} force · ${rec.buys.eco} eco` : undefined,
    highlights: [...(rec.notables ?? []), ...(habits.length ? [`Habits: ${habits.join(", ")}`] : [])],
  };
}

/** The same scorecard flattened for the LLM's debrief prompt. */
export function scorecardText(data: DebriefData): string {
  return [
    data.title,
    data.playerLine ? `Player K/A/D: ${data.playerLine}` : "",
    data.pistolsLine ? `Pistol rounds: ${data.pistolsLine}` : "",
    data.buysLine ? `Buys: ${data.buysLine}` : "",
    data.highlights.length ? `Highlights: ${data.highlights.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
