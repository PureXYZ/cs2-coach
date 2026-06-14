import { log } from "./log.js";

/**
 * Read-only client for Leetify's public CS API — they parse the match demo
 * server-side, so this is post-match stats (ADR, K/D, Leetify rating) with
 * zero demo handling here. Works keyless (stricter rate limits); an API key
 * from leetify.com/app/developer goes in the _leetify_key header.
 *
 * Their developer guidelines (leetify.com/blog/leetify-api-developer-guidelines):
 * data must NOT be stored — everything fetched here is posted to Discord once
 * and forgotten (it never reaches the session store, and the logs carry no API
 * data) — metrics must be shown as the API provides them (no rescaling or unit
 * changes), and posts must carry "Data Provided by Leetify" attribution.
 */
const BASE = "https://api-public.cs-prod.leetify.com";

/** profile.recent_matches[] item — app-scale units (ms, percentages). */
interface RecentMatch {
  id?: string;
  finished_at?: string;
  map_name?: string;
  /** Per-match result string (e.g. "win"/"loss"/"tie") — present on every entry. */
  outcome?: string | null;
  /** Final score as [ours, theirs]-ish pair; unused by the qualitative brief. */
  score?: [number, number] | null;
  leetify_rating?: number | null;
  preaim?: number | null;
  reaction_time_ms?: number | null;
  accuracy_head?: number | null;
}

/** /v2/matches/{id} stats[] entry (trimmed to what the spoken recap uses). */
interface PlayerStats {
  steam64_id?: string;
  kd_ratio?: number | null;
  total_kills?: number | null;
  total_deaths?: number | null;
  /** Damage per round — what players call ADR. */
  dpr?: number | null;
  total_hs_kills?: number | null;
  trade_kills_succeed?: number | null;
}

/** Only what the Discord follow-up displays — fetched, posted, forgotten. */
export interface LeetifyMatchStats {
  leetifyRating?: number;
  preaim?: number;
  reactionTimeMs?: number;
  accuracyHead?: number;
  kdRatio?: number;
  totalKills?: number;
  totalDeaths?: number;
  adr?: number;
  hsKills?: number;
  tradeKills?: number;
  /**
   * QUALITATIVE multi-match direction only — no invented numbers, no altered
   * values, so this respects Leetify's verbatim/no-rescale rules: it states a
   * trend ("preaim creeping up") without ever quoting a changed figure.
   */
  trend?: string;
}

/** The wired crew's rows from ONE match — the primary's full stats plus each
 *  wired friend's match-detail subset. Fetched, spoken once, never stored. */
export interface LeetifySquadStats {
  me: LeetifyMatchStats;
  squad: Array<{ name?: string; isPrimary: boolean; stats: LeetifyMatchStats }>;
}

/**
 * A QUALITATIVE pre-match brief built from the player's Leetify profile
 * (recent_matches), fetchable the moment the map is known — NO demo-parse wait,
 * because it reads already-finished history, not the game still in Leetify's parse
 * queue. Every field is a direction/recency PHRASE with no quoted figure (the same
 * compliance basis the existing buildTrend() relies on: Leetify's verbatim/no-recompute
 * rule polices numbers, and these introduce none). Like the recap, it is fetched,
 * spoken once and never stored — it never reaches the session store or the logs.
 */
export interface LeetifyStartBrief {
  /** Recent direction on THIS map — "you've been losing on Mirage lately". */
  mapForm?: string;
  /** The last game on this map: recency + result — "you last played Mirage earlier today, and lost". */
  lastOnMap?: string;
  /** Overall recent direction coming in — "you're walking in off a losing run". */
  recentForm?: string;
  /** Aim-trend direction (reuses buildTrend) — "your reaction time is trending faster lately". */
  trend?: string;
}

/** Leetify's JSON uses null for unscored fields — normalize to undefined. */
function val<T>(v: T | null | undefined): T | undefined {
  return v ?? undefined;
}

/** Profile-level (recent_matches) stats — present for any registered account. */
function profileStats(match: RecentMatch): LeetifyMatchStats {
  return {
    leetifyRating: val(match.leetify_rating),
    preaim: val(match.preaim),
    reactionTimeMs: val(match.reaction_time_ms),
    accuracyHead: val(match.accuracy_head),
  };
}

/** Merge a /v2/matches detail row (ADR/K/D/HS/trades) onto a stats object. */
function applyDetail(stats: LeetifyMatchStats, row: PlayerStats): void {
  stats.kdRatio = val(row.kd_ratio);
  stats.totalKills = val(row.total_kills);
  stats.totalDeaths = val(row.total_deaths);
  stats.adr = val(row.dpr);
  stats.hsKills = val(row.total_hs_kills);
  stats.tradeKills = val(row.trade_kills_succeed);
}

/**
 * Match-identity window around the observed match END. The right match's
 * finished_at is within clock-skew minutes of the coach's own gameover frame,
 * while the previous and next matches are 20+ minutes away — so a two-sided
 * window can't grab a back-to-back queue's other game (a start-anchored
 * cutoff could, and a second still-running poller made it worse).
 */
const MATCH_WINDOW_MS = 10 * 60_000;

/** Mean of the present (non-null) numbers, or undefined when none qualify. */
function mean(nums: number[]): number | undefined {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : undefined;
}

/**
 * A short QUALITATIVE form clause comparing the matched game to the up-to-3
 * games that finished BEFORE it in the same recent_matches list — direction
 * only, never a number, so it adds no value Leetify would object to (and it is
 * spoken once and forgotten like the rest of the recap).
 *
 * Polarity matters: higher preaim = worse crosshair placement, lower
 * reaction_time_ms = faster, higher accuracy_head = better. We only speak a
 * metric when both the current game and the recent average for it are present.
 */
function buildTrend(match: RecentMatch, recent: RecentMatch[]): string | undefined {
  const matchedAt = match.finished_at ? Date.parse(match.finished_at) : NaN;
  if (Number.isNaN(matchedAt)) return undefined;

  // Older games only, most recent first, capped at three so a single rough
  // night doesn't get drowned out by ancient history.
  const prior = recent
    .filter((m) => {
      if (m === match || !m.finished_at) return false;
      const at = Date.parse(m.finished_at);
      return !Number.isNaN(at) && at < matchedAt;
    })
    .sort((a, b) => Date.parse(b.finished_at!) - Date.parse(a.finished_at!))
    .slice(0, 3);
  if (!prior.length) return undefined;

  const clauses: string[] = [];

  const preaimNow = val(match.preaim);
  const preaimWas = mean(prior.map((m) => val(m.preaim)).filter((n): n is number => n != null));
  if (preaimNow != null && preaimWas != null && preaimNow !== preaimWas) {
    clauses.push(
      preaimNow > preaimWas
        ? "your preaim has been creeping up the last few games"
        : "your preaim has been tightening up the last few games",
    );
  }

  const rtNow = val(match.reaction_time_ms);
  const rtWas = mean(prior.map((m) => val(m.reaction_time_ms)).filter((n): n is number => n != null));
  if (rtNow != null && rtWas != null && rtNow !== rtWas) {
    clauses.push(
      rtNow < rtWas
        ? "your reaction time is trending faster lately"
        : "your reaction time is trending slower lately",
    );
  }

  const accNow = val(match.accuracy_head);
  const accWas = mean(prior.map((m) => val(m.accuracy_head)).filter((n): n is number => n != null));
  if (accNow != null && accWas != null && accNow !== accWas) {
    clauses.push(
      accNow > accWas
        ? "your headshot accuracy has been climbing across recent games"
        : "your headshot accuracy has been slipping across recent games",
    );
  }

  if (!clauses.length) return undefined;
  // One direction is plenty to speak — most actionable (aim) first.
  return clauses[0]!.charAt(0).toUpperCase() + clauses[0]!.slice(1) + ".";
}

/** Leetify's per-match outcome string → a coarse result. Tolerant of casing/wording
 *  (win/won, loss/lost, tie/draw) since the exact tokens aren't contractual. */
function matchResult(outcome: string | null | undefined): "win" | "loss" | "tie" | undefined {
  if (!outcome) return undefined;
  const s = outcome.toLowerCase();
  if (s.startsWith("w")) return "win";
  if (s.startsWith("l")) return "loss";
  if (s.startsWith("t") || s.startsWith("d")) return "tie";
  return undefined;
}

/** A number-light "how long ago" phrase for a past match — spoken words, not digits.
 *  Time-since is derived arithmetic, not a Leetify metric, so loose wording here doesn't
 *  touch the verbatim rule; it just keeps TTS natural. undefined when the time is unusable. */
function agoPhrase(finishedAt: string | undefined, now: number): string | undefined {
  if (!finishedAt) return undefined;
  const at = Date.parse(finishedAt);
  if (Number.isNaN(at)) return undefined;
  const mins = (now - at) / 60_000;
  if (mins < 0) return undefined;
  if (mins < 75) return "in the last hour";
  if (mins < 210) return "a couple hours ago";
  if (mins < 7 * 60) return "earlier today";
  if (mins < 24 * 60) return "today";
  if (mins < 48 * 60) return "yesterday";
  if (mins < 7 * 24 * 60) return "a few days back";
  return "a while back";
}

/** Spoken map name from a GSI/Leetify token (de_mirage → "Mirage"). Local to leetify.ts
 *  to avoid a cross-module import; the coach's mapDisplayName covers workshop/alias cases
 *  the brief never needs (the brief always sees the canonical GSI token). */
function prettyMap(raw: string): string {
  const token = raw.split("/").pop() ?? raw;
  return token
    .replace(/^(de|cs|ar)_/i, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export class LeetifyClient {
  constructor(private readonly apiKey?: string) {}

  /**
   * The Leetify match that finished within ±10 min of `endedAtEpochMs`,
   * enriched with the player's per-match stats. Returns null while Leetify is
   * still parsing (no qualifying match yet), undefined when the Steam ID isn't
   * a registered Leetify user (their API 404s those since Jan 2026).
   */
  async findMatchNear(
    steam64: string,
    endedAtEpochMs: number,
    map?: string,
  ): Promise<LeetifyMatchStats | null | undefined> {
    const found = await this.findMatchEntry(steam64, endedAtEpochMs, map);
    if (!found) return found; // undefined (unregistered) or null (not parsed yet)

    const { match, recent } = found;
    const stats = profileStats(match);
    // Qualitative form-trend (direction only, no quoted figure) — Leetify's
    // no-rescale/verbatim rule is untouched and it's spoken once, never stored.
    stats.trend = buildTrend(match, recent);
    // Match detail adds ADR/K/D/trades; the lightweight entry already carries
    // the headline numbers, so a detail failure is not a deal-breaker.
    try {
      const detail = await this.get(`/v2/matches/${encodeURIComponent(match.id!)}`);
      const mine = (detail as { stats?: PlayerStats[] } | null)?.stats?.find((s) => s.steam64_id === steam64);
      if (mine) applyDetail(stats, mine);
    } catch (err) {
      log.warn("leetify", `Match detail fetch failed (${err instanceof Error ? err.message : err}) — using profile summary only`);
    }
    return stats;
  }

  /**
   * Like findMatchNear, but KEEPS the per-match rows for every wired teammate —
   * they're already in the same /v2/matches response, just discarded by the solo
   * path. The match is still identified via the PRIMARY's profile (the ±10 min
   * window), so profile-level fields (rating/preaim/reaction) exist only for the
   * primary; friends get the match-detail subset (K/D, ADR, HS, trades). A friend
   * who isn't on Leetify simply has no row and is omitted. null / undefined mean
   * exactly what they do for findMatchNear (keyed on the primary).
   */
  async findSquadMatchNear(
    squad: Array<{ steam64: string; name?: string; isPrimary: boolean }>,
    endedAtEpochMs: number,
    map?: string,
  ): Promise<LeetifySquadStats | null | undefined> {
    const primary = squad.find((m) => m.isPrimary) ?? squad[0];
    if (!primary) return null;
    const found = await this.findMatchEntry(primary.steam64, endedAtEpochMs, map);
    if (!found) return found;

    const { match, recent } = found;
    const me = profileStats(match);
    me.trend = buildTrend(match, recent); // the primary's multi-match form, spoken once
    const rows: LeetifySquadStats["squad"] = [];
    try {
      const detail = await this.get(`/v2/matches/${encodeURIComponent(match.id!)}`);
      const byId = new Map(
        ((detail as { stats?: PlayerStats[] } | null)?.stats ?? []).map((s) => [s.steam64_id, s] as const),
      );
      const mine = byId.get(primary.steam64);
      if (mine) applyDetail(me, mine);
      for (const m of squad) {
        const row = byId.get(m.steam64);
        if (!row) continue; // teammate not in Leetify's parse (unregistered / still parsing)
        const stats = m.isPrimary ? me : {};
        if (!m.isPrimary) applyDetail(stats, row);
        rows.push({ name: m.name, isPrimary: m.isPrimary, stats });
      }
    } catch (err) {
      log.warn("leetify", `Squad match detail fetch failed (${err instanceof Error ? err.message : err}) — using the primary's profile summary only`);
    }
    return { me, squad: rows };
  }

  /**
   * A QUALITATIVE pre-match brief from the player's profile, for the match-start /
   * warmup speech. ONE keyless /v3/profile GET (the same call findMatchEntry makes)
   * yields recent_matches — newest-first, each with outcome/map_name/finished_at and
   * the aim fields — so map form, "last played this map / how long ago", recent
   * direction and an aim trend all come from it with NO demo-parse latency. Every
   * field is direction/recency only (no spoken number) to stay inside Leetify's
   * verbatim/no-recompute rule, the same basis buildTrend already relies on. The
   * caller speaks it once and never stores it.
   *
   * undefined = account not on Leetify (404); null = registered but nothing usable
   * (no history / no clear signal) — both degrade cleanly to today's plain greeting.
   */
  async startBrief(steam64: string, map: string): Promise<LeetifyStartBrief | null | undefined> {
    const profile = await this.get(`/v3/profile?steam64_id=${encodeURIComponent(steam64)}`);
    if (profile === null) return undefined; // 404 — not a registered Leetify user
    const recent = (profile as { recent_matches?: RecentMatch[] }).recent_matches ?? [];
    if (!recent.length) return null;

    const now = Date.now();
    const where = prettyMap(map);
    const onMap = recent.filter((m) => m.map_name && m.map_name.toLowerCase() === map.toLowerCase());
    const brief: LeetifyStartBrief = {};

    // The last game on this map: recency + result (a single restated outcome, no tally).
    const last = onMap[0];
    if (last) {
      const res = matchResult(last.outcome);
      const ago = agoPhrase(last.finished_at, now);
      if (res && ago) {
        const verb = res === "win" ? "and took it" : res === "loss" ? "and lost" : "and drew it";
        brief.lastOnMap = `you last played ${where} ${ago}, ${verb}`;
      }
    }

    // Recent DIRECTION on this map — a plain majority over the last several games here,
    // spoken as a direction, never as an "X won Y lost" count (which would be a recompute).
    if (onMap.length >= 2) {
      let w = 0;
      let l = 0;
      for (const m of onMap.slice(0, 6)) {
        const r = matchResult(m.outcome);
        if (r === "win") w++;
        else if (r === "loss") l++;
      }
      if (l > w) brief.mapForm = `you've been losing on ${where} lately`;
      else if (w > l) brief.mapForm = `you've been winning on ${where} lately`;
    }

    // Overall streak coming in (consecutive from the newest) — direction only, no count.
    const top = matchResult(recent[0]?.outcome);
    if (top === "win" || top === "loss") {
      let streak = 0;
      for (const m of recent) {
        if (matchResult(m.outcome) !== top) break;
        streak++;
      }
      if (streak >= 2) brief.recentForm = top === "win" ? "you're walking in on a win streak" : "you're walking in off a losing run";
    }

    // Aim direction — reuse the recap's buildTrend, comparing the latest finished game
    // to the prior few. Direction only (no numbers) by construction.
    if (recent[0]) brief.trend = buildTrend(recent[0], recent);

    // Nothing usable → null so the caller degrades to the plain greeting.
    return brief.lastOnMap || brief.mapForm || brief.recentForm || brief.trend ? brief : null;
  }

  /**
   * The recent_matches entry that lines up with our observed match end (±10 min,
   * map-matched), via the given account's profile. undefined = account not on
   * Leetify (404); null = no qualifying match yet (still parsing).
   */
  private async findMatchEntry(
    steam64: string,
    endedAtEpochMs: number,
    map?: string,
  ): Promise<{ match: RecentMatch; recent: RecentMatch[] } | null | undefined> {
    const profile = await this.get(`/v3/profile?steam64_id=${encodeURIComponent(steam64)}`);
    if (profile === null) return undefined;
    const recent = (profile as { recent_matches?: RecentMatch[] }).recent_matches ?? [];

    let match: RecentMatch | undefined;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const m of recent) {
      if (!m.id || !m.finished_at) continue;
      const at = Date.parse(m.finished_at);
      if (Number.isNaN(at)) continue;
      const delta = Math.abs(at - endedAtEpochMs);
      if (delta > MATCH_WINDOW_MS) continue;
      if (map && m.map_name && m.map_name !== map) continue;
      if (delta < bestDelta) {
        match = m;
        bestDelta = delta;
      }
    }
    // Return the matched entry AND the recent array — callers build the stats
    // (profileStats + applyDetail) and the qualitative form-trend (buildTrend,
    // which needs the whole recent window) from it.
    return match ? { match, recent } : null;
  }

  private async get(path: string): Promise<unknown | null> {
    const res = await fetch(`${BASE}${path}`, {
      headers: this.apiKey ? { _leetify_key: this.apiKey } : {},
      signal: AbortSignal.timeout(15_000),
    });
    // Unregistered/unknown profiles 404 with a plain-text body — not JSON.
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Leetify HTTP ${res.status}`);
    return res.json();
  }
}

/**
 * The numbers as one comma-separated SPOKEN sentence — values verbatim per
 * Leetify's guidelines (omitting a stat is allowed, altering one is not),
 * signs and units as words so TTS reads them right. Null when nothing usable.
 */
export function spokenStatsSentence(stats: LeetifyMatchStats): string | null {
  const parts: string[] = [];
  if (stats.totalKills != null && stats.totalDeaths != null) {
    parts.push(`${stats.totalKills} kills to ${stats.totalDeaths} deaths`);
  } else if (stats.kdRatio != null) {
    // "K D ratio", not "K/D" — TTS reads the slash out loud. Label change
    // only; the value stays verbatim per Leetify's guidelines.
    parts.push(`K D ratio ${stats.kdRatio}`);
  }
  if (stats.adr != null) parts.push(`ADR ${stats.adr}`);
  if (stats.hsKills != null) parts.push(`${stats.hsKills} headshot kills`);
  if (stats.leetifyRating != null) {
    parts.push(`Leetify rating ${stats.leetifyRating < 0 ? "minus" : "plus"} ${Math.abs(stats.leetifyRating)}`);
  }
  if (stats.reactionTimeMs != null) parts.push(`time to damage ${stats.reactionTimeMs} milliseconds`);
  return parts.length ? parts.join(", ") : null;
}

/**
 * The squad comparison as ONE spoken sentence, to sit ALONGSIDE the player's own
 * stats line — every value lifted VERBATIM from the API (Leetify's verbatim rule
 * forbids a recomputed delta). "full" (default) reads a short line per wired friend
 * so the coach can roast the whole board, bottom-fraggers included; "leaders" only
 * names whoever topped each stat (gentler — for a crew that doesn't want a friend's
 * worst number aired). Null when there's no wired friend to compare against (the
 * caller then speaks the solo line alone).
 */
export function spokenSquadSentence(squad: LeetifySquadStats, mode: "leaders" | "full" = "full"): string | null {
  const named = squad.squad.filter((r) => r.name);
  const friends = named.filter((r) => !r.isPrimary);
  if (friends.length === 0) return null;

  const parts: string[] = [];
  if (mode === "full") {
    for (const r of friends) {
      const clause = friendClause(r.stats);
      if (clause) parts.push(`${r.name} ${clause}`);
    }
  } else {
    const topKills = leader(named, (r) => r.stats.totalKills);
    const topAdr = leader(named, (r) => r.stats.adr);
    if (topKills) {
      parts.push(topKills.row.isPrimary ? "you top-fragged the squad" : `${topKills.row.name} top-fragged with ${topKills.value} kills`);
    }
    if (topAdr) {
      parts.push(topAdr.row.isPrimary ? "and you led the squad on ADR" : `${topAdr.row.name} led the squad on ADR at ${topAdr.value}`);
    }
  }
  return parts.length ? parts.join(", ") : null;
}

/** A wired friend's headline numbers as a short verbatim clause ("18 to 14, ADR 70"). */
function friendClause(s: LeetifyMatchStats): string | null {
  const bits: string[] = [];
  if (s.totalKills != null && s.totalDeaths != null) bits.push(`${s.totalKills} to ${s.totalDeaths}`);
  else if (s.kdRatio != null) bits.push(`K D ${s.kdRatio}`);
  if (s.adr != null) bits.push(`ADR ${s.adr}`);
  return bits.length ? bits.join(", ") : null;
}

/** The row with the highest value for `pick` (ties → first seen), or null if none has it. */
function leader(
  rows: LeetifySquadStats["squad"],
  pick: (r: LeetifySquadStats["squad"][number]) => number | undefined,
): { row: LeetifySquadStats["squad"][number]; value: number } | null {
  let best: { row: LeetifySquadStats["squad"][number]; value: number } | null = null;
  for (const r of rows) {
    const v = pick(r);
    if (v == null) continue;
    if (!best || v > best.value) best = { row: r, value: v };
  }
  return best;
}

const FIRST_WAIT_MS = 3 * 60_000;
const POLL_INTERVAL_MS = 5 * 60_000;
const MAX_POLLS = 12; // first try at 3 min, then every 5 — gives up after ~1h

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Leetify needs the GOTV demo plus parse time — typically 5-15 minutes after
 * the match, with a long tail during peak hours. Polls gently (12 fetches max)
 * and resolves null when the match never shows up. `find` returns the stats,
 * null while still parsing, or undefined when the account isn't registered.
 */
async function pollForStats<T>(label: string, find: () => Promise<T | null | undefined>): Promise<T | null> {
  await sleep(FIRST_WAIT_MS);
  for (let attempt = 1; attempt <= MAX_POLLS; attempt++) {
    try {
      const found = await find();
      if (found === undefined) {
        log.info("leetify", "This Steam account isn't registered on Leetify — skipping post-match stats");
        return null;
      }
      if (found) {
        // No API data in the log line — the on-disk logs must stay Leetify-free.
        log.info("leetify", `${label} found after ${attempt} poll(s)`);
        return found;
      }
    } catch (err) {
      log.warn("leetify", `${label} poll ${attempt} failed: ${err instanceof Error ? err.message : err}`);
    }
    if (attempt < MAX_POLLS) await sleep(POLL_INTERVAL_MS);
  }
  log.info("leetify", `${label} never appeared on Leetify within the hour — giving up`);
  return null;
}

/** Poll for the primary player's post-match stats (solo recap). */
export function pollForLeetifyStats(
  client: LeetifyClient,
  steam64: string,
  endedAtEpochMs: number,
  map: string | undefined,
): Promise<LeetifyMatchStats | null> {
  return pollForStats("Match", () => client.findMatchNear(steam64, endedAtEpochMs, map));
}

/** Poll for the whole wired crew's post-match rows (squad recap). */
export function pollForSquadLeetifyStats(
  client: LeetifyClient,
  squad: Array<{ steam64: string; name?: string; isPrimary: boolean }>,
  endedAtEpochMs: number,
  map: string | undefined,
): Promise<LeetifySquadStats | null> {
  return pollForStats("Squad match", () => client.findSquadMatchNear(squad, endedAtEpochMs, map));
}
