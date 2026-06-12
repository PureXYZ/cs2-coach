import { log } from "./log.js";

/**
 * Read-only client for Leetify's public CS API — they parse the match demo
 * server-side, so this is post-match stats (ADR, K/D, Leetify rating) with
 * zero demo handling here. Works keyless (stricter rate limits); an API key
 * from leetify.com/app/developer goes in the _leetify_key header.
 *
 * Their developer guidelines (leetify.com/blog/leetify-api-developer-guidelines):
 * data must NOT be stored — everything fetched here is posted to Discord once
 * and forgotten — metrics must be shown as the API provides them (no rescaling
 * or unit changes), and posts must carry "Data Provided by Leetify" attribution.
 */
const BASE = "https://api-public.cs-prod.leetify.com";

/** profile.recent_matches[] item — app-scale units (ms, percentages). */
interface RecentMatch {
  id?: string;
  finished_at?: string;
  map_name?: string;
  outcome?: string;
  leetify_rating?: number;
  preaim?: number;
  reaction_time_ms?: number;
  accuracy_head?: number;
}

/** /v2/matches/{id} stats[] entry (trimmed to what the debrief shows). */
interface PlayerStats {
  steam64_id?: string;
  kd_ratio?: number;
  total_kills?: number;
  total_deaths?: number;
  /** Damage per round — what players call ADR. */
  dpr?: number;
  total_hs_kills?: number;
  trade_kills_succeed?: number;
}

export interface LeetifyMatchStats {
  matchId: string;
  finishedAt: string;
  mapName?: string;
  outcome?: string;
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

export class LeetifyClient {
  constructor(private readonly apiKey?: string) {}

  /**
   * The newest Leetify match that finished after `sinceEpochMs`, enriched with
   * the player's per-match stats. Returns null while Leetify is still parsing
   * (no qualifying match yet), undefined when the Steam ID isn't a registered
   * Leetify user (their API 404s those since Jan 2026).
   */
  async findMatchSince(
    steam64: string,
    sinceEpochMs: number,
    map?: string,
  ): Promise<LeetifyMatchStats | null | undefined> {
    const profile = await this.get(`/v3/profile?steam64_id=${encodeURIComponent(steam64)}`);
    if (profile === null) return undefined;
    const recent = (profile as { recent_matches?: RecentMatch[] }).recent_matches ?? [];

    // 5 min of slack: Leetify's finished_at is the server's clock, not ours.
    const cutoff = sinceEpochMs - 5 * 60_000;
    const match = recent.find((m) => {
      if (!m.id || !m.finished_at) return false;
      const at = Date.parse(m.finished_at);
      if (Number.isNaN(at) || at < cutoff) return false;
      return !map || !m.map_name || m.map_name === map;
    });
    if (!match) return null;

    const stats: LeetifyMatchStats = {
      matchId: match.id!,
      finishedAt: match.finished_at!,
      mapName: match.map_name,
      outcome: match.outcome,
      leetifyRating: match.leetify_rating,
      preaim: match.preaim,
      reactionTimeMs: match.reaction_time_ms,
      accuracyHead: match.accuracy_head,
    };

    // Match detail adds ADR/K/D/trades; the lightweight entry already carries
    // the headline numbers, so a detail failure is not a deal-breaker.
    try {
      const detail = await this.get(`/v2/matches/${encodeURIComponent(match.id!)}`);
      const mine = (detail as { stats?: PlayerStats[] } | null)?.stats?.find((s) => s.steam64_id === steam64);
      if (mine) {
        stats.kdRatio = mine.kd_ratio;
        stats.totalKills = mine.total_kills;
        stats.totalDeaths = mine.total_deaths;
        stats.adr = mine.dpr;
        stats.hsKills = mine.total_hs_kills;
        stats.tradeKills = mine.trade_kills_succeed;
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
  sinceEpochMs: number,
  map: string | undefined,
): Promise<LeetifyMatchStats | null> {
  await sleep(FIRST_WAIT_MS);
  for (let attempt = 1; attempt <= MAX_POLLS; attempt++) {
    try {
      const found = await client.findMatchSince(steam64, sinceEpochMs, map);
      if (found === undefined) {
        log.info("leetify", "This Steam account isn't registered on Leetify — skipping post-match stats");
        return null;
      }
      if (found) {
        log.info("leetify", `Match ${found.matchId} found after ${attempt} poll(s)`);
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
