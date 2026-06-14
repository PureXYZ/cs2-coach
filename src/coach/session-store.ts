import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  /**
   * Display names of the wired FRIENDS present this match (the primary excluded).
   * Names only — never their stats — so a trend line can be tagged with WHO was
   * wired ("with Sam in, you're 3-1") while staying an assertion about the
   * primary's own results. Absent when the user played solo / unwired.
   */
  squad?: string[];
}

/**
 * Stricter than a bare object check: recentForm() does arithmetic and string
 * interpolation on ourScore/theirScore/endedAt and states the result as fact
 * (the honesty surface), so a record missing those would print NaN-flavoured
 * lies. Reject anything lacking the fields the spoken-form lines lean on.
 */
function isValidRecord(r: unknown): r is SessionMatchRecord {
  return (
    !!r &&
    typeof r === "object" &&
    typeof (r as any).endedAt === "string" &&
    typeof (r as any).ourScore === "number" &&
    typeof (r as any).theirScore === "number"
  );
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
        if (Array.isArray(parsed)) this.records = parsed.filter(isValidRecord);
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
    // Log success only when the write actually landed (the warn inside persist() covers
    // a failure) — otherwise a full/read-only disk would print a misleading "Recorded
    // match" line right after the failure warning.
    if (this.persist()) {
      log.info("sessions", `Recorded match ${rec.map ?? "?"} ${rec.ourScore}-${rec.theirScore} (${this.records.length} on file)`);
    }
  }

  /** Atomic write of the current records. A crash mid-write leaves either the old or the
   *  new complete file, never truncated JSON the constructor would discard. Returns
   *  whether the write succeeded so callers don't log a false success. */
  private persist(): boolean {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.records, null, 2), "utf8");
      renameSync(tmp, this.file);
      return true;
    } catch (err) {
      log.warn("sessions", `Could not persist session history: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  lastMatch(): SessionMatchRecord | undefined {
    return this.records[this.records.length - 1];
  }

  /** The most recent N matches, newest first — owner-only `/coachadmin sessions list`. */
  recent(n: number): SessionMatchRecord[] {
    return this.records.slice(-n).reverse();
  }

  /** Wipe ALL recorded matches (owner-only, after confirm). Returns how many were
   *  removed — for clearing a polluted history (a practice/bot match that slipped the
   *  recording guards, or a duplicate). */
  clear(): number {
    const n = this.records.length;
    if (n === 0) return 0;
    this.records = [];
    this.persist();
    log.info("sessions", `Cleared ${n} match record(s) on owner request`);
    return n;
  }

  /** Drop just the most recent match (owner-only, after confirm) — the targeted fix for
   *  one bad row without nuking the whole history. Returns the removed record, if any. */
  deleteLast(): SessionMatchRecord | undefined {
    const removed = this.records.pop();
    if (removed) {
      this.persist();
      log.info("sessions", `Deleted last match (${removed.map ?? "?"} ${removed.ourScore}-${removed.theirScore}) on owner request`);
    }
    return removed;
  }

  /** Remove the record with this exact endedAt (epoch ms). The delete-last confirm binds
   *  to a specific record's timestamp, so the click deletes the row that was PREVIEWED —
   *  never whatever is newest at click time (a match could have recorded mid-confirm).
   *  Returns the removed record, or undefined if it's no longer on file. */
  deleteByEndedAt(endedAtMs: number): SessionMatchRecord | undefined {
    const idx = this.records.findIndex((r) => Date.parse(r.endedAt) === endedAtMs);
    if (idx === -1) return undefined;
    const [removed] = this.records.splice(idx, 1);
    this.persist();
    log.info("sessions", `Deleted match (${removed.map ?? "?"} ${removed.ourScore}-${removed.theirScore}) on owner request`);
    return removed;
  }

  /**
   * Terse, real, cross-session trend lines for the LLM prompt (smart moments
   * only). Past-match facts the coach can call back to — capped at 6 lines so
   * the prompt stays lean. Returns undefined until at least one match is on file.
   *
   * `leetifyCoversForm` drops the two lines a Leetify pre-match brief also speaks —
   * the per-map W/L and the overall streak — so the coach never states recent/map
   * form from two sources (the coach's own observed history AND Leetify's broader
   * one) that could disagree. The session-only facts (pistols, K/D, habits,
   * squad-tag) always stay; they have no Leetify equivalent.
   */
  recentForm(currentMap?: string, opts?: { leetifyCoversForm?: boolean }): string[] | undefined {
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

    // Match-level streak coming into tonight (2+ of the same result). Suppressed when
    // a Leetify brief already speaks the overall direction (broader sample wins).
    if (!opts?.leetifyCoversForm) {
      let streak = 0;
      const lastResult = recent[0]?.won;
      if (lastResult !== undefined) {
        for (const r of recent) {
          if (r.won !== lastResult) break;
          streak++;
        }
        if (streak >= 2) out.push(`That's ${streak} ${lastResult ? "wins" : "losses"} in a row coming into this one.`);
      }
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
    // Suppressed when a Leetify brief covers map form (its sample sees games the coach
    // never observed, so it's the authority; this would otherwise double-speak it).
    if (currentMap && !opts?.leetifyCoversForm) {
      const onMap = this.records.slice(-15).filter((r) => r.map === currentMap && r.won !== undefined);
      if (onMap.length >= 2) {
        const w = onMap.filter((r) => r.won).length;
        out.push(`On ${mapDisplayName(currentMap)} specifically: ${w} won, ${onMap.length - w} lost in recent matches.`);
      }
    }

    // Squad-tagged form (C2): if a friend has been wired for 2+ of the recent
    // matches, note the PRIMARY's record alongside them. It's an assertion about
    // your OWN win/loss, merely tagged with who was wired — never a claim about
    // the friend's play. Phrased "with X wired in", since an unwired X is invisible.
    const tagged = recent.filter((r) => r.squad?.length && r.won !== undefined);
    if (tagged.length >= 2) {
      const counts = new Map<string, number>();
      for (const r of tagged) for (const n of r.squad!) counts.set(n, (counts.get(n) ?? 0) + 1);
      let mate: string | undefined;
      let best = 1; // need a friend present in 2+ tagged matches
      for (const [n, c] of counts) if (c > best) { mate = n; best = c; }
      if (mate) {
        const withMate = tagged.filter((r) => r.squad!.includes(mate!));
        const w = withMate.filter((r) => r.won).length;
        out.push(`With ${mate} wired in, you're ${w} and ${withMate.length - w} over your last ${withMate.length} together.`);
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
