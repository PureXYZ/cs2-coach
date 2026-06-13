import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../log.js";
import { mapDisplayName } from "./lines.js";

/**
 * One finished match, recorded from the coach's own GSI-derived match memory.
 * Everything here is data the coach observed itself — third-party stats
 * (Leetify) are read-and-spoken at debrief time and deliberately never stored.
 */
export interface SessionMatchRecord {
  /** ISO timestamp of the matchEnd event. */
  endedAt: string;
  /** Raw GSI map token, e.g. "de_mirage". */
  map?: string;
  mode?: string;
  /** undefined when the coach (re)connected too late to know our side. */
  won?: boolean;
  ourScore: number;
  theirScore: number;
  kills?: number;
  assists?: number;
  deaths?: number;
  mvps?: number;
  pistols?: { first?: "won" | "lost"; second?: "won" | "lost" };
  /** Own-buy counts across the match (pistol rounds excluded). */
  buys?: { eco: number; force: number; full: number };
  /** Own deaths inside the first 20 seconds of a round. */
  earlyDeaths?: number;
  /** Death-forensics tallies (died blind / burning / with unthrown nades). */
  diedBlind?: number;
  diedBurning?: number;
  diedWithNades?: number;
  /** Match highlights, e.g. "R7: knife kill". */
  notables?: string[];
  roundsPlayed?: number;
}

/** Keep the file small and the trends honest — old matches stop being "form". */
const MAX_RECORDS = 50;
/** How many recent matches the spoken-form lines aggregate over. */
const FORM_WINDOW = 5;

const STORE_FILE = process.env.SESSION_STORE_FILE ?? "state/sessions.json";

function dayLabel(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  // Round, not floor: a DST shift makes midnight-to-midnight 23 or 25 hours.
  const days = Math.round((now.setHours(0, 0, 0, 0), now.getTime() - new Date(then).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * Cross-session match history, persisted to state/ (a Docker volume on the
 * hosted deploy) so the coach remembers past nights across restarts. Its
 * recentForm() lines feed the LLM's smart-tier prompts — that's what lets the
 * coach say "third night in a row you've thrown the pistol round" and mean it.
 */
export class SessionStore {
  private records: SessionMatchRecord[] = [];

  constructor(private readonly file = STORE_FILE) {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8"));
        if (Array.isArray(parsed)) this.records = parsed.filter((r) => r && typeof r === "object");
      }
    } catch (err) {
      log.warn("sessions", `Could not read ${this.file} — starting fresh (${err instanceof Error ? err.message : err})`);
      this.records = [];
    }
  }

  get count(): number {
    return this.records.length;
  }

  record(rec: SessionMatchRecord): void {
    this.records.push(rec);
    if (this.records.length > MAX_RECORDS) this.records = this.records.slice(-MAX_RECORDS);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.records, null, 2), "utf8");
      log.info("sessions", `Recorded match ${rec.map ?? "?"} ${rec.ourScore}-${rec.theirScore} (${this.records.length} on file)`);
    } catch (err) {
      log.warn("sessions", `Could not persist session history: ${err instanceof Error ? err.message : err}`);
    }
  }

  lastMatch(): SessionMatchRecord | undefined {
    return this.records[this.records.length - 1];
  }

  /**
   * Terse, real, cross-session trend lines for the LLM prompt (smart moments
   * only). Past-match facts the coach can call back to — capped at 6 lines so
   * the prompt stays lean. Returns undefined until at least one match is on file.
   */
  recentForm(currentMap?: string): string[] | undefined {
    if (this.records.length === 0) return undefined;
    const now = new Date();
    const recent = this.records.slice(-FORM_WINDOW).reverse(); // newest first
    const out: string[] = [];

    out.push(
      "Past matches, newest first: " +
        recent
          .map((r) => {
            const res = r.won === undefined ? "?" : r.won ? "won" : "lost";
            const map = r.map ? ` on ${mapDisplayName(r.map)}` : "";
            const when = dayLabel(r.endedAt, new Date(now));
            return `${res} ${r.ourScore}-${r.theirScore}${map}${when ? ` (${when})` : ""}`;
          })
          .join("; ") +
        ".",
    );

    // Match-level streak coming into tonight (2+ of the same result).
    let streak = 0;
    const lastResult = recent[0]?.won;
    if (lastResult !== undefined) {
      for (const r of recent) {
        if (r.won !== lastResult) break;
        streak++;
      }
      if (streak >= 2) out.push(`That's ${streak} ${lastResult ? "wins" : "losses"} in a row coming into this one.`);
    }

    // Pistol-round record across the window.
    const pistols = recent.flatMap((r) => [r.pistols?.first, r.pistols?.second]).filter(Boolean);
    if (pistols.length >= 4) {
      const won = pistols.filter((p) => p === "won").length;
      out.push(`Pistol rounds across those: won ${won} of ${pistols.length}.`);
    }

    // Combined K/D across the window.
    const k = recent.reduce((s, r) => s + (r.kills ?? 0), 0);
    const d = recent.reduce((s, r) => s + (r.deaths ?? 0), 0);
    if (d > 0 && recent.some((r) => r.kills !== undefined)) {
      out.push(`Combined K/D across those: ${(k / d).toFixed(2)} (${k} kills, ${d} deaths).`);
    }

    // Record on tonight's map, over a longer window — map form moves slowly.
    if (currentMap) {
      const onMap = this.records.slice(-15).filter((r) => r.map === currentMap && r.won !== undefined);
      if (onMap.length >= 2) {
        const w = onMap.filter((r) => r.won).length;
        out.push(`On ${mapDisplayName(currentMap)} specifically: ${w} won, ${onMap.length - w} lost in recent matches.`);
      }
    }

    // One recurring-bad-habit line, worst first — the roast material.
    const last3 = this.records.slice(-3);
    const early = last3.reduce((s, r) => s + (r.earlyDeaths ?? 0), 0);
    const pocket = last3.reduce((s, r) => s + (r.diedWithNades ?? 0), 0);
    const blind = last3.reduce((s, r) => s + (r.diedBlind ?? 0), 0);
    if (early >= 6) out.push(`${early} opening-seconds deaths over the last ${last3.length} matches — a pattern, not luck.`);
    else if (pocket >= 4) out.push(`Died holding unthrown grenades ${pocket} times over the last ${last3.length} matches.`);
    else if (blind >= 3) out.push(`Died flashed ${blind} times over the last ${last3.length} matches.`);

    return out.slice(0, 6);
  }
}
