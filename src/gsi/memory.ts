import type { Team } from "./types.js";

/** Own-buy classification, derived from the user's equipment value when the round goes live. */
export type BuyType = "pistol" | "eco" | "force" | "full";

export interface RoundRecord {
  round: number;
  side?: Team;
  buy?: BuyType;
  /** Own equipment value when the round went live. */
  equipStart?: number;
  result?: "won" | "lost";
  /** GSI round-win token, e.g. "t_win_bomb", "ct_win_elimination". */
  how?: string;
  myKills: number;
  myDeath: boolean;
  bombPlanted: boolean;
  /** Memorable moments, e.g. "knife kill", "ace", "teamkilled someone". */
  notable: string[];
}

/** Pretty token for the LLM out of GSI's "t_win_bomb" style win conditions. */
function winMethod(how: string | undefined): string {
  if (!how) return "";
  if (how.includes("bomb")) return "bomb";
  if (how.includes("defuse")) return "defuse";
  if (how.includes("elimination")) return "elim";
  if (how.includes("time")) return "time";
  return how;
}

/**
 * Round-by-round memory for the whole match, built only from signals GSI
 * actually provides while playing (own state, scores, round outcomes). The
 * tracker feeds it; its summaries give the LLM the story of the game so
 * advice can reference momentum, pistol results and earlier highlights.
 */
export class MatchMemory {
  private rounds: RoundRecord[] = [];
  private current: RoundRecord | null = null;
  /**
   * The record endRound just pushed. Kills/deaths landing in the ~7s after-round
   * window (exit frags, post-explosion fights) still belong to that round —
   * without this, ensure() would open a phantom duplicate record for it.
   */
  private lastClosed: RoundRecord | null = null;
  /** Own deaths inside the first ~20s of a round — a repeatable habit, counted
   *  rather than spammed into notables (the LLM sees the count in the snapshot). */
  private earlyDeathCount = 0;

  reset(): void {
    this.rounds = [];
    this.current = null;
    this.lastClosed = null;
    this.earlyDeathCount = 0;
  }

  /** Freezetime: open the record for the upcoming round. */
  startRound(round: number, side: Team | undefined): void {
    // Re-entering freezetime for the same round (timeout, reconnect) keeps the record.
    if (this.current?.round === round) {
      this.current.side = this.current.side ?? side;
      return;
    }
    // A round-end we never saw (payload gap): keep the stale record with an
    // unknown result rather than silently losing what happened in it.
    if (this.current) this.endRound(undefined, undefined);
    this.current = {
      round,
      side,
      myKills: 0,
      myDeath: false,
      bombPlanted: false,
      notable: [],
    };
  }

  /** Round went live: classify the buy from the user's own equipment. */
  roundLive(round: number, equipValue: number | undefined): void {
    const cur = this.ensure(round);
    if (equipValue === undefined) return;
    cur.equipStart = equipValue;
    if (round === 1 || round === 13) cur.buy = "pistol";
    else if (equipValue < 1500) cur.buy = "eco";
    else if (equipValue < 3400) cur.buy = "force";
    else cur.buy = "full";
  }

  recordKill(round: number): void {
    this.ensure(round).myKills++;
  }

  recordDeath(round: number): void {
    this.ensure(round).myDeath = true;
  }

  recordEarlyDeath(): void {
    this.earlyDeathCount++;
  }

  /** Deaths inside the first ~20s of a round, across the match so far. */
  earlyDeaths(): number {
    return this.earlyDeathCount;
  }

  recordBombPlanted(round: number): void {
    this.ensure(round).bombPlanted = true;
  }

  /** Anything worth calling back to later ("knife kill", "ace", "teamkill"). */
  recordNotable(round: number, text: string): void {
    const cur = this.ensure(round);
    if (!cur.notable.includes(text)) cur.notable.push(text);
  }

  /**
   * Close the open record. Takes no round number on purpose: GSI's map.round
   * increments somewhere around the live→over transition, so the only reliable
   * identity for "the round that just ended" is the record opened at its freezetime.
   */
  endRound(won: boolean | undefined, how: string | undefined): void {
    const cur = this.current;
    if (!cur) return; // joined mid-round-end / payload gap — nothing tracked to close
    cur.result = won === undefined ? undefined : won ? "won" : "lost";
    cur.how = how;
    this.rounds.push(cur);
    this.lastClosed = cur;
    this.current = null;
  }

  /**
   * Every closed round record (plus the open one, if a match ends without a
   * final round-over frame) — the raw material for the post-match scorecard
   * and the cross-session store.
   */
  allRounds(): readonly RoundRecord[] {
    return this.current ? [...this.rounds, this.current] : this.rounds;
  }

  /** Compact per-round history strings for the LLM, most recent last. */
  history(maxRounds = 8): string[] {
    return this.rounds.slice(-maxRounds).map((r) => {
      const parts = [
        `R${r.round}`,
        r.side ?? "?",
        r.buy ?? "",
        r.result ? `${r.result.toUpperCase()}${r.how ? ` (${winMethod(r.how)})` : ""}` : "?",
      ].filter(Boolean);
      if (r.myKills > 0) parts.push(`you ${r.myKills}k${r.myDeath ? "+died" : ""}`);
      else if (r.myDeath) parts.push("you died");
      if (r.notable.length > 0) parts.push(r.notable.join(", "));
      return parts.join(" ");
    });
  }

  /** "won" | "lost" for the two pistol rounds, once known. */
  pistolResults(): { first?: "won" | "lost"; second?: "won" | "lost" } {
    const first = this.rounds.find((r) => r.round === 1)?.result;
    const second = this.rounds.find((r) => r.round === 13)?.result;
    return { first, second };
  }

  /** Current win/loss streak as a spoken-friendly token, e.g. "won last 3". */
  streak(): string | undefined {
    const withResult = this.rounds.filter((r) => r.result);
    if (withResult.length === 0) return undefined;
    const last = withResult[withResult.length - 1].result;
    let n = 0;
    for (let i = withResult.length - 1; i >= 0 && withResult[i].result === last; i--) n++;
    if (n < 2) return undefined;
    return `${last} last ${n}`;
  }

  /** Highlights from the whole match, capped, for banter callbacks. */
  notables(max = 6): string[] {
    const all = this.rounds.flatMap((r) => r.notable.map((n) => `R${r.round}: ${n}`));
    const cur = this.current ? this.current.notable.map((n) => `R${this.current!.round}: ${n}`) : [];
    return [...all, ...cur].slice(-max);
  }

  private ensure(round: number): RoundRecord {
    if (this.current?.round === round) return this.current;
    // After-round events (the round was just closed): merge into the pushed
    // record by reference instead of opening a phantom duplicate.
    if (this.lastClosed?.round === round) return this.lastClosed;
    // Missed the freezetime transition (mid-round join / payload gap) — open late.
    this.current = {
      round,
      myKills: 0,
      myDeath: false,
      bombPlanted: false,
      notable: [],
    };
    return this.current;
  }
}
