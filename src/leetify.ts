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

/** Leetify's JSON uses null for unscored fields — normalize to undefined. */
function val<T>(v: T | null | undefined): T | undefined {
  return v ?? undefined;
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
    if (!match) return null;

    const stats: LeetifyMatchStats = {
      leetifyRating: val(match.leetify_rating),
      preaim: val(match.preaim),
      reactionTimeMs: val(match.reaction_time_ms),
      accuracyHead: val(match.accuracy_head),
    };

    // Match detail adds ADR/K/D/trades; the lightweight entry already carries
    // the headline numbers, so a detail failure is not a deal-breaker.
    try {
      const detail = await this.get(`/v2/matches/${encodeURIComponent(match.id!)}`);
      const mine = (detail as { stats?: PlayerStats[] } | null)?.stats?.find((s) => s.steam64_id === steam64);
      if (mine) {
        stats.kdRatio = val(mine.kd_ratio);
        stats.totalKills = val(mine.total_kills);
        stats.totalDeaths = val(mine.total_deaths);
        stats.adr = val(mine.dpr);
        stats.hsKills = val(mine.total_hs_kills);
        stats.tradeKills = val(mine.trade_kills_succeed);
      }
    } catch (err) {
      log.warn("leetify", `Match detail fetch failed (${err instanceof Error ? err.message : err}) — using profile summary only`);
    }
    return stats;
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

const FIRST_WAIT_MS = 3 * 60_000;
const POLL_INTERVAL_MS = 5 * 60_000;
const MAX_POLLS = 12; // first try at 3 min, then every 5 — gives up after ~1h

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Leetify needs the GOTV demo plus parse time — typically 5-15 minutes after
 * the match, with a long tail during peak hours. Polls gently (12 profile
 * fetches max) and resolves null when the match never shows up.
 */
export async function pollForLeetifyStats(
  client: LeetifyClient,
  steam64: string,
  endedAtEpochMs: number,
  map: string | undefined,
): Promise<LeetifyMatchStats | null> {
  await sleep(FIRST_WAIT_MS);
  for (let attempt = 1; attempt <= MAX_POLLS; attempt++) {
    try {
      const found = await client.findMatchNear(steam64, endedAtEpochMs, map);
      if (found === undefined) {
        log.info("leetify", "This Steam account isn't registered on Leetify — skipping post-match stats");
        return null;
      }
      if (found) {
        // No API data in the log line — the on-disk logs must stay Leetify-free.
        log.info("leetify", `Match found after ${attempt} poll(s)`);
        return found;
      }
    } catch (err) {
      log.warn("leetify", `Poll ${attempt} failed: ${err instanceof Error ? err.message : err}`);
    }
    if (attempt < MAX_POLLS) await sleep(POLL_INTERVAL_MS);
  }
  log.info("leetify", "Match never appeared on Leetify within the hour — giving up");
  return null;
}
