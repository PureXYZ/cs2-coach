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
}

/** The wired crew's rows from ONE match — the primary's full stats plus each
 *  wired friend's match-detail subset. Fetched, spoken once, never stored. */
export interface LeetifySquadStats {
  me: LeetifyMatchStats;
  squad: Array<{ name?: string; isPrimary: boolean; stats: LeetifyMatchStats }>;
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
    const match = await this.findMatchEntry(steam64, endedAtEpochMs, map);
    if (!match) return match; // undefined (unregistered) or null (not parsed yet)

    const stats = profileStats(match);
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
    const match = await this.findMatchEntry(primary.steam64, endedAtEpochMs, map);
    if (!match) return match;

    const me = profileStats(match);
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
   * The recent_matches entry that lines up with our observed match end (±10 min,
   * map-matched), via the given account's profile. undefined = account not on
   * Leetify (404); null = no qualifying match yet (still parsing).
   */
  private async findMatchEntry(
    steam64: string,
    endedAtEpochMs: number,
    map?: string,
  ): Promise<RecentMatch | null | undefined> {
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
    return match ?? null;
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
 * forbids a recomputed delta, so we only name leaders and read their given value).
 * "leaders" (default) names just whoever topped each stat — never a friend's WORST
 * number; "full" reads a short line per wired friend. Null when there's no wired
 * friend to compare against (the caller then speaks the solo line alone).
 */
export function spokenSquadSentence(squad: LeetifySquadStats, mode: "leaders" | "full" = "leaders"): string | null {
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
