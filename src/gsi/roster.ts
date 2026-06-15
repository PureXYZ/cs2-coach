import { GsiTracker, type CoachEvent, type MatchContext } from "./tracker.js";
import type { GsiPayload, TeamContext, TeamMember } from "./types.js";
import { config, STEAMID64_RE } from "../config.js";
import { runtime } from "../runtime-overrides.js";
import { log } from "../log.js";

/**
 * Multi-feed coordinator. When several friends each run the coach's GSI cfg,
 * every CS2 client POSTs its OWN-player feed to the same server. This demuxes the
 * incoming payloads by provider.steamid into one untouched single-player
 * GsiTracker per feed — so every hard-won per-feed invariant (death-spectate
 * baseline freezing, nade/clip forensics, bot detection, the midMatchPhase guard)
 * is preserved exactly — and then FUSES the per-feed output into a single stream
 * the engine consumes with one handle() call per payload, identical to today.
 *
 * Two roles, deliberately separate:
 *   PRIMARY   — the configured user. Owns session memory, the Leetify recap, and
 *               the personal half of the coaching context (own HP/money/weapons).
 *   AUTHORITY — the single live feed whose GLOBAL events (round/bomb/match
 *               lifecycle + the locally-derived clock) reach the engine, so N
 *               feeds reporting the same round-end speak ONE line. Sticky and
 *               prefers the primary; falls to the longest-lived live TEAMMATE feed
 *               only while the primary's feed is silent.
 *
 * MEMBERSHIP / safety: a friend can queue onto the ENEMY team — or play a totally
 * different match — yet POST to the same shared token. Such feeds must never reach
 * team econ / alive counts / hype / authority. Membership is judged two ways, both
 * swap-invariant (so the halftime side flip, which reaches each feed at a slightly
 * different instant, can't momentarily mis-classify anyone):
 *   - MAP: a feed must be on the same map as the squad (different lobby = different map).
 *   - SIDE: a per-feed running tally of "same side as the primary" vs "opposite",
 *     reset each match. A real teammate is ALWAYS on the primary's side (both swap
 *     together), an enemy ALWAYS opposite. The vote is only cast while the feed and
 *     the primary are on the SAME round number — at a side-swap the two cross the
 *     round boundary a frame apart, so equal-round gating skips exactly the
 *     out-of-phase frames (within a round, sides never change). We never key
 *     membership on the instantaneous side, only on this accumulated vote.
 *
 * Honesty: the coach never asserts whole-team facts (last man, everyone's broke)
 * unless the squad is fully wired (COACH_SQUAD_SIZE met and that many CONFIRMED
 * teammate feeds fresh) — see buildTeam().
 */

/** STEAMID64_RE (imported from ../config.js) matches a real SteamID64. The local
 *  player's id (provider.steamid) is always one of these; bots only ever appear as
 *  a spectated player.steamid, never as a provider, so a non-matching provider is a
 *  malformed or stray POST — dropped. Shared with config so the startup validation
 *  of COACH_PRIMARY_STEAM64 and this feed gate agree on exactly what binds. */

/** Match-global events — every feed sees them identically, so only the AUTHORITY
 *  feed's copy is forwarded; the rest are per-player. */
const GLOBAL_EVENTS: ReadonlySet<CoachEvent["type"]> = new Set([
  // Match-lifecycle warmup signal — every feed sees it, so only the authority's copy
  // is forwarded (one scouting speech, not one per wired friend). No globalSignature
  // case needed: it falls through to the default (bare type), like matchStart/halftime.
  "mapLoading",
  "matchStart",
  "freezetime",
  "roundLive",
  "roundEnd",
  "bombPlanted",
  "bombDefused",
  "bombExploded",
  "halftime",
  "timeout",
  "matchPoint",
  "matchEnd",
]);

interface FeedState {
  tracker: GsiTracker;
  /** epoch ms of this feed's first payload — "longest-lived" authority tiebreak. */
  firstSeen: number;
  /** epoch ms of this feed's most recent payload — liveness/reaping. */
  lastSeen: number;
  /** Cached context() from this feed's latest payload (rebuilt each update); used
   *  for the per-player team roster (alive/money/bomb are payload-derived and
   *  don't drift between payloads — the time-derived clock is recomputed live in
   *  mergedCtx instead). */
  ctx: MatchContext;
  /** Swap-invariant side membership: observations this feed was on the primary's
   *  side vs the opposite side (reset each match). Majority decides teammate-vs-enemy. */
  sameSide: number;
  oppSide: number;
  /** Ops ITEM 9: last membership classification we logged — one line per
   *  confirm/quarantine TRANSITION, not per payload. undefined until first seen. */
  lastConfirmed?: boolean;
}

export interface RosterUpdate {
  events: CoachEvent[];
  ctx: MatchContext;
}

const EMPTY_CTX: MatchContext = { playerIsSelf: false };

// Econ ITEM 11 — shared fresh-read threshold (a feed's money/alive are 'now' only
// when it posted within HALF the connection window). Used by buildTeam's per-member
// tier tag AND its bomb-carrier freshness check so both move together. (deriveLastMan's
// survivor check uses the tighter config.gsi.lastManFreshMs, not this.)
const FRESH_READ_MS = config.gsi.feedStaleMs / 2;
// Connection-blip ITEM 1 — authority hysteresis. LEAVE_GRACE keeps the primary as
// authority through a brief gap; clamped STRICTLY below feedIdleMs so a reaped
// primary still releases. RECLAIM_CONFIRM makes a returned primary stay fresh ~one
// heartbeat before yanking authority back from a teammate (anti-flap).
const PRIMARY_LEAVE_GRACE_MS = Math.min(config.gsi.feedStaleMs + 5_000, config.gsi.feedIdleMs - 1);
const PRIMARY_RECLAIM_CONFIRM_MS = config.gsi.feedStaleMs - 3_000;
// Hard ceiling on concurrent feeds. The auth model is a single SHARED token echoed
// by everyone, so any token holder could POST a flood of distinct valid-format
// SteamID64s — each would otherwise spawn a GsiTracker+MatchMemory (reaped only after
// feedIdleMs) and the roster iterates ALL feeds every frame. A real game pairs at most
// ~10 players, so 16 is ample headroom; past it, new feeds are ignored (logged once).
const MAX_FEEDS = 16;

export class RosterManager {
  private feeds = new Map<string, FeedState>();
  /** Sticky authority feed (supplies global events + the clock context). */
  private authorityId: string | null = null;
  /** First feed seen, pinned as primary when none is configured (solo fallback). */
  private adoptedPrimary: string | null = null;
  /** The map the primary feed last reported a game on — the reference the delayed
   *  Leetify recap uses to decide which feeds' live games may veto it, even after
   *  the primary has returned to the menu (its own map then reads undefined). */
  private lastPrimaryMap: string | undefined;
  /** Seam de-dup: last epoch ms each global event SIGNATURE was forwarded. Keyed by
   *  type + content (score/round/side) so a re-election re-emitting the SAME logical
   *  event collapses, while a genuinely different one (new round, new score) passes. */
  private lastGlobalAt = new Map<string, number>();
  /** Round number a last-man-standing call last fired for (once per round). */
  private lastManRound: number | null = null;
  /** C3: offenders (steamids) already called out as the entry-trade weak link THIS
   *  match — a code latch so the nudge fires once per friend and never nags. */
  private weakLinkCalled = new Set<string>();
  /** Connection-blip ITEM 1: when the primary's feed first went non-fresh (null while fresh). */
  private primaryStaleSince: number | null = null;
  /** Connection-blip ITEM 1: when the primary first became continuously fresh again. */
  private primaryFreshSince: number | null = null;
  /** Connection-blip ITEM 2: per-match high-water set of CONFIRMED-teammate steamids. */
  private confirmedEver = new Set<string>();
  /** Econ ITEM 17: per-round buy snapshots (last 5) for the cross-round buy-sync read. */
  private econRing: Array<{ round: number; buys: Array<{ name?: string; klass: "full" | "force" | "eco" }> }> = [];
  /** Events ITEM 16: spectated kills narrated through a STALE teammate's feed, keyed
   *  `${steamid}:${round}:${roundKills}`, so the catch-up duplicate is dropped. */
  private specNarratedLatch = new Set<string>();
  /** Ops ITEM 14: whether the CONFIGURED primary produced a feed THIS match. */
  private primaryEverSeen = false;
  /** Log-once latch for the MAX_FEEDS ceiling (a token flood would otherwise spam). */
  private warnedFeedCap = false;

  constructor(private readonly configuredPrimary = config.coach.primarySteam64) {}

  /** Feed one GSI payload (from any friend's client); returns the fused events
   *  the engine should react to plus the merged match context. */
  update(payload: GsiPayload): RosterUpdate {
    const now = Date.now();
    const steamid = payload.provider?.steamid;
    if (!steamid || !STEAMID64_RE.test(steamid)) {
      // Not a valid local-player feed — ignore it, but hand back coherent context.
      return { events: [], ctx: this.mergedCtx(this.buildTeam(now)) };
    }

    let feed = this.feeds.get(steamid);
    if (!feed) {
      // Reap idle feeds first so legit churn (a friend left, another joined) frees a
      // slot before the cap bites; only a genuine flood of fresh feeds hits the ceiling.
      this.reap(now);
      if (this.feeds.size >= MAX_FEEDS) {
        if (!this.warnedFeedCap) {
          this.warnedFeedCap = true;
          log.warn("roster", `Feed cap (${MAX_FEEDS}) reached — ignoring new feed ${this.shortId(steamid)} (warning shown once)`);
        }
        return { events: [], ctx: this.mergedCtx(this.buildTeam(now)) };
      }
      feed = { tracker: new GsiTracker(), firstSeen: now, lastSeen: now, ctx: EMPTY_CTX, sameSide: 0, oppSide: 0, lastConfirmed: undefined };
      this.feeds.set(steamid, feed);
      log.info("roster", `Feed joined ${this.shortId(steamid)} — ${this.feeds.size} wired`);
    }
    feed.lastSeen = now;

    // Per-feed tracking is the unchanged single-player logic.
    const rawEvents = feed.tracker.update(payload);
    feed.ctx = feed.tracker.context();

    this.reap(now);
    this.adoptPrimaryIfNeeded(steamid);
    const isPrimary = this.isPrimary(steamid);

    // A genuinely NEW match for THIS feed: its tracker emitted matchStart AND the
    // scoreboard is a POSITIVELY-KNOWN 0-0 (a fresh game). Its side votes from the
    // previous match no longer apply. The score gate is what separates a real new
    // match (including an abandon→requeue whose global matchStart was suppressed)
    // from a mid-match menu/warmup/gameover blip that also re-emits matchStart but
    // resumes at the live score — wiping a confirmed teammate's tally there would
    // briefly drop them from the squad and from authority-fallback eligibility.
    // Require BOTH scores to be defined: an unknown-side frame reports them as
    // undefined, and coalescing those to 0 would read as a phantom 0-0 and wipe a
    // confirmed vote tally on a frame we actually know nothing about.
    if (
      rawEvents.some((e) => e.type === "matchStart") &&
      feed.ctx.ourScore !== undefined &&
      feed.ctx.theirScore !== undefined &&
      feed.ctx.ourScore === 0 &&
      feed.ctx.theirScore === 0
    ) {
      feed.sameSide = 0;
      feed.oppSide = 0;
      // Connection-blip ITEM 2: genuinely new match — drop the high-water set on the
      // SAME 0-0 gate, so a mid-match warmup/timeout blip (live score) never wipes it.
      this.confirmedEver.clear();
    }

    // Record this feed's side membership against the primary anchor, and remember
    // the primary's current map for the recap's quiet-moment check.
    if (isPrimary) {
      // Ops ITEM 14: the CONFIGURED primary showing up this match (clears the 'never
      // connected' warning) is set at the END of update() — Finding #21: forwardGlobal
      // resets primaryEverSeen on the primary's own matchStart frame, so a set HERE would
      // be clobbered within the same call. Setting it post-loop lets the set win.
      if (feed.ctx.map) this.lastPrimaryMap = feed.ctx.map;
    } else {
      // Vote ONLY when this feed and the primary are on the SAME round. At a
      // side-swap (half/OT boundary) the two feeds cross the round one frame apart,
      // so their sides are briefly out of phase and a naive comparison would
      // mis-classify (an enemy momentarily looks same-side, a teammate opposite).
      // Within a single round sides never change, so requiring an equal round
      // number skips exactly those transition frames — no special-casing the swap,
      // and a brand-new feed seen only during the seam casts no vote at all.
      const primary = this.primaryFeed();
      const primarySide = primary?.tracker.ownSide();
      const side = feed.tracker.ownSide();
      if (
        primary &&
        primarySide &&
        side &&
        feed.ctx.round !== undefined &&
        feed.ctx.round === primary.ctx.round
      ) {
        if (side === primarySide) feed.sameSide++;
        else feed.oppSide++;
      }
    }

    const refMap = this.refMap(now);
    this.logMembershipTransition(steamid, feed, now, refMap);
    this.electAuthority(now, refMap);
    const isAuthority = this.authorityId === steamid;

    const out: CoachEvent[] = [];
    for (const ev of rawEvents) {
      const fused = GLOBAL_EVENTS.has(ev.type)
        ? this.forwardGlobal(ev, isAuthority, now)
        : this.fusePersonal(ev, steamid, feed, isPrimary, now, refMap);
      if (fused) out.push(fused);
    }

    // Ops ITEM 14 / Finding #21: the CONFIGURED primary actually showed up this match.
    // Set AFTER the events loop so forwardGlobal's same-frame matchStart reset (which runs
    // inside the loop) can't clobber it. Keyed on the configured id, not the adopted fallback.
    if (isPrimary && this.configuredPrimary && steamid === this.configuredPrimary) {
      this.primaryEverSeen = true;
    }

    const team = this.buildTeam(now, refMap);
    const lastMan = this.deriveLastMan(team, now, refMap);
    if (lastMan) out.push(lastMan);
    const weakLink = this.deriveWeakLink(now, refMap);
    if (weakLink) out.push(weakLink);

    return { events: out, ctx: this.mergedCtx(team) };
  }

  // --- routing / identity ----------------------------------------------------

  private adoptPrimaryIfNeeded(steamid: string): void {
    if (this.configuredPrimary || this.adoptedPrimary) return;
    this.adoptedPrimary = steamid;
    log.info(
      "roster",
      `No COACH_PRIMARY_STEAM64 set — adopting ${this.shortId(steamid)} as primary for this session`,
    );
  }

  private primaryId(): string | null {
    return this.configuredPrimary ?? this.adoptedPrimary;
  }

  private isPrimary(steamid: string): boolean {
    return steamid === this.primaryId();
  }

  private primaryFeed(): FeedState | undefined {
    const id = this.primaryId();
    return id ? this.feeds.get(id) : undefined;
  }

  private authorityFeed(): FeedState | undefined {
    return this.authorityId ? this.feeds.get(this.authorityId) : undefined;
  }

  private isFresh(feed: FeedState | undefined, now: number): boolean {
    return feed !== undefined && now - feed.lastSeen <= config.gsi.feedStaleMs;
  }

  /** The map the squad is on: the primary feed's when it's live, otherwise the
   *  plurality among fresh feeds (a single different-lobby feed can't outvote the
   *  real squad). Map is side-independent, so it's safe across the halftime swap. */
  private refMap(now: number): string | undefined {
    const primary = this.primaryFeed();
    if (primary && this.isFresh(primary, now) && primary.ctx.map) return primary.ctx.map;
    const maps = new Map<string, number>();
    for (const f of this.feeds.values()) {
      if (this.isFresh(f, now) && f.ctx.map) maps.set(f.ctx.map, (maps.get(f.ctx.map) ?? 0) + 1);
    }
    return plurality(maps);
  }

  private onRefMap(feed: FeedState, refMap: string | undefined): boolean {
    return !refMap || !feed.ctx.map || feed.ctx.map === refMap;
  }

  /** A CONFIRMED member of our squad: the primary itself, or a feed whose
   *  side-membership vote leans same-side as the primary. Used for the
   *  honesty-sensitive surfaces (team block, hype, bot gate) — strict: an
   *  unconfirmed feed (no votes yet, or leaning opposite) is excluded. */
  private isTeammate(feed: FeedState, id: string, now: number, refMap: string | undefined): boolean {
    if (!this.isFresh(feed, now)) return false;
    if (!this.onRefMap(feed, refMap)) return false;
    return id === this.primaryId() || feed.sameSide > feed.oppSide;
  }

  /** Ops ITEM 9 — why a feed is NOT a confirmed member, in isTeammate's OWN order
   *  (stale -> off-map -> vote state), or null if it IS a member. */
  private membershipReason(feed: FeedState, id: string, now: number, refMap: string | undefined): string | null {
    if (!this.isFresh(feed, now)) return "stale";
    if (!this.onRefMap(feed, refMap)) return "off-map";
    if (id === this.primaryId()) return null;
    if (feed.sameSide > feed.oppSide) return null;
    if (feed.sameSide === 0 && feed.oppSide === 0) return "unconfirmed-no-votes-yet";
    return "opposite-side-vote";
  }

  /** Drop feeds that have gone silent (friend closed CS2 / disconnected). */
  private reap(now: number): void {
    for (const [id, feed] of this.feeds) {
      if (now - feed.lastSeen <= config.gsi.feedIdleMs) continue;
      this.feeds.delete(id);
      // Genuinely gone (idle-reaped, not a brief blip) — drop from the high-water set
      // too, or squadComplete would keep counting a departed teammate and fire a false
      // "last one alive" whole-team call. A blipped feed (stale but < feedIdleMs) is
      // never reaped here, so it still counts and is still appended as alive=undefined.
      this.confirmedEver.delete(id);
      if (this.authorityId === id) this.authorityId = null;
      log.info("roster", `Feed dropped ${this.shortId(id)} (idle) — ${this.feeds.size} wired`);
    }
  }

  /** Sticky-prefers-primary: the primary feed is authority whenever it's live;
   *  otherwise keep the current authority while it's still eligible, else elect the
   *  longest-lived fresh, same-map CONFIRMED teammate. Global state (round/bomb and
   *  especially side-relative scores) must come from one of OUR players, never an
   *  opponent's or an unconfirmed feed — so eligibility requires positive
   *  teammate confirmation, not merely "not a known enemy". */
  private electAuthority(now: number, refMap: string | undefined): void {
    const primary = this.primaryId();
    const primaryFeed = primary ? this.feeds.get(primary) : undefined;
    const primaryFresh = this.isFresh(primaryFeed, now);
    // ITEM 1 — track the primary's freshness edges for the two hysteresis windows.
    if (primaryFresh) {
      this.primaryStaleSince = null;
      if (this.primaryFreshSince === null) this.primaryFreshSince = now;
    } else {
      this.primaryFreshSince = null; // a lapse cancels any in-progress reclaim-confirm
      if (this.primaryStaleSince === null && primaryFeed) this.primaryStaleSince = now;
    }
    if (primary && primaryFresh) {
      // Reclaim immediately if it never lost authority, else after reclaim-confirm dwell.
      const teammateHasIt = this.authorityId !== null && this.authorityId !== primary;
      const confirmed = this.primaryFreshSince !== null && now - this.primaryFreshSince >= PRIMARY_RECLAIM_CONFIRM_MS;
      if (!teammateHasIt || confirmed) {
        this.setAuthority(primary);
        return;
      }
      // else: fresh again but inside reclaim-confirm — let the teammate keep authority.
    } else if (primary && this.authorityId === primary) {
      // leave-grace: hold the (now non-fresh) primary as authority through a sub-feedIdle gap.
      const within = this.primaryStaleSince !== null && now - this.primaryStaleSince < PRIMARY_LEAVE_GRACE_MS;
      if (within && this.feeds.has(primary)) return;
    }
    const eligible = (id: string, f: FeedState) => this.isTeammate(f, id, now, refMap);
    if (this.authorityId) {
      const cur = this.feeds.get(this.authorityId);
      if (cur && eligible(this.authorityId, cur)) return;
    }
    let pick: string | null = null;
    let pickSince = Infinity;
    for (const [id, feed] of this.feeds) {
      if (!eligible(id, feed)) continue;
      if (feed.firstSeen < pickSince) { pick = id; pickSince = feed.firstSeen; }
    }
    this.setAuthority(pick);
  }

  private setAuthority(id: string | null): void {
    if (this.authorityId === id) return;
    this.authorityId = id;
    if (id) log.info("roster", `Authority → ${this.shortId(id)}`);
  }

  /** Connection-blip ITEM 13 — the squad's furthest-along round: MAX of the
   *  authority's round and every CONFIRMED, fresh feed's round. Only ever rises, so
   *  it converts an authority lagging a faster teammate at a boundary into an honest
   *  unknown rather than a false last-man. Undefined when nothing reports a round. */
  private squadRefRound(now: number, refMap: string | undefined): number | undefined {
    let ref = this.authorityFeed()?.ctx.round;
    for (const [id, f] of this.feeds) {
      if (!this.isTeammate(f, id, now, refMap)) continue;
      const r = f.ctx.round;
      if (r !== undefined && (ref === undefined || r > ref)) ref = r;
    }
    return ref;
  }

  /** Ops ITEM 9 — log ONCE when a feed crosses confirmed<->quarantined. The primary
   *  is always confirmed and never logged as a swap. */
  private logMembershipTransition(id: string, feed: FeedState, now: number, refMap: string | undefined): void {
    const confirmed = this.isTeammate(feed, id, now, refMap);
    if (feed.lastConfirmed === confirmed) return;
    feed.lastConfirmed = confirmed;
    if (id === this.primaryId()) return;
    if (confirmed) {
      log.info("roster", `Feed confirmed ${this.shortId(id)} (${feed.tracker.ownName() ?? "?"}) — squad member`);
    } else {
      const reason = this.membershipReason(feed, id, now, refMap) ?? "unknown";
      log.info("roster", `Feed quarantined ${this.shortId(id)} (${feed.tracker.ownName() ?? "?"}) — ${reason}`);
    }
  }

  // --- event fusion ----------------------------------------------------------

  private forwardGlobal(ev: CoachEvent, isAuthority: boolean, now: number): CoachEvent | null {
    if (!isAuthority) return null; // a non-authority feed's duplicate of a global moment

    // A new match: reset the once-per-round last-man latch. (Per-feed side votes
    // are reset in update() off each feed's OWN matchStart, which is robust to an
    // abandon that suppresses this global one. matchStart/matchEnd are NOT gated on
    // a roster-level inMatch flag — the per-feed tracker already emits each exactly
    // once per match, including re-announcing a fresh match after an abandon; the
    // seam window below collapses the re-election overlap.)
    if (ev.type === "matchStart") {
      this.lastManRound = null;
      this.econRing = [];            // Econ ITEM 17: don't leak a buy pattern across games
      this.primaryEverSeen = false;  // Ops ITEM 14: re-arm 'primary never connected'
      this.weakLinkCalled.clear();   // C3: re-arm the per-friend weak-link nudge each match
      // Per-match high-water set must reset on EVERY new match, not only the 0-0 path in
      // update() — a cold start straight into a live (non-0-0) game never hits that gate,
      // and a stale teammate from the prior match would otherwise leak into squadComplete.
      this.confirmedEver.clear();
    }
    // Events ITEM 16: the spectate-narration latch is per-round — clear at every boundary.
    if (ev.type === "freezetime" || ev.type === "roundEnd" || ev.type === "matchStart") {
      this.specNarratedLatch.clear();
    }

    // Absorb the authority-re-election seam: the SAME logical transition emitted twice
    // by two feeds collapses to one. Keying on a content signature (not bare type) means
    // a re-emission of the identical event is dropped while a genuinely different one
    // (next round, new score) is forwarded immediately even inside the window.
    const sig = this.globalSignature(ev);
    const last = this.lastGlobalAt.get(sig) ?? 0;
    if (config.gsi.globalSeamMs > 0 && now - last < config.gsi.globalSeamMs) return null;
    this.lastGlobalAt.set(sig, now);
    return ev;
  }

  /** Content signature for the seam de-dup: type plus the fields that make a global
   *  event unique (score/round/side). Two feeds emitting the SAME round-end share a
   *  signature (collapsed); successive different events don't (forwarded). */
  private globalSignature(ev: CoachEvent): string {
    switch (ev.type) {
      case "roundEnd":
        return `roundEnd:${ev.ourScore}:${ev.theirScore}:${ev.method}`;
      case "matchEnd":
        return `matchEnd:${ev.ourScore}:${ev.theirScore}`;
      case "matchPoint":
        return `matchPoint:${ev.forUs}`;
      case "freezetime":
      case "roundLive":
        return `${ev.type}:${ev.round}`;
      case "bombPlanted":
      case "bombDefused":
      case "bombExploded":
        return `${ev.type}:${ev.ourSide ?? "?"}`;
      case "timeout":
        return `timeout:${ev.ours ?? "?"}`;
      default:
        return ev.type; // matchStart, halftime — no discriminating content
    }
  }

  private fusePersonal(
    ev: CoachEvent,
    steamid: string,
    feed: FeedState,
    isPrimary: boolean,
    now: number,
    refMap: string | undefined,
  ): CoachEvent | null {
    if (isPrimary) {
      // Events ITEM 16: suppress a spectate-narration of a wired teammate ONLY when
      // their feed is FRESH (their own kill is coming). If STALE, narrate now and
      // latch it so the catch-up duplicate is dropped below.
      if (ev.type === "teammateKill" && ev.spectatedSteamid) {
        const specFeed = this.feeds.get(ev.spectatedSteamid);
        if (specFeed) {
          if (this.isFresh(specFeed, now)) return null;
          // Key on the SPECTATED teammate's own round (as we last saw it), NOT the
          // primary's — if the two feeds are a round apart, the primary's round would
          // never match the key the teammate's own catch-up kill checks below.
          this.specNarratedLatch.add(`${ev.spectatedSteamid}:${specFeed.ctx.round ?? "?"}:${ev.roundKills}`);
          return ev;
        }
      }
      return ev;
    }

    // A non-primary feed: collapse to the few team-level signals, drop the rest.
    // Narrating every friend's every kill/death/MVP is exactly the N× chatter the
    // quiet persona forbids — aggregate, don't multiply. And only a CONFIRMED
    // teammate is ever hyped: an enemy friend on the shared token who triples must
    // NOT get a "teammate's doing the job" line.
    if (ev.type === "kill" && ev.roundKills >= 3 && this.isTeammate(feed, steamid, now, refMap)) {
      // Events ITEM 16: drop the catch-up duplicate the primary already narrated
      // while spectating this teammate during their stale window.
      if (this.specNarratedLatch.delete(`${steamid}:${feed.ctx.round ?? "?"}:${ev.roundKills}`)) return null;
      return { type: "teammateMultiKill", who: { steamid, name: feed.tracker.ownName() }, roundKills: ev.roundKills };
    }
    return null;
  }

  // --- team context ----------------------------------------------------------

  private buildTeam(now: number, refMap: string | undefined = this.refMap(now)): TeamContext | undefined {
    const live: Array<[string, FeedState]> = [];
    for (const [id, f] of this.feeds) if (this.isTeammate(f, id, now, refMap)) live.push([id, f]);
    // Connection-blip ITEM 2: every confirmed-fresh member raises the per-match
    // high-water mark, so a one-feed blip below still counts toward squadComplete.
    for (const [id] of live) this.confirmedEver.add(id);
    if (live.length < 2) return undefined; // solo / only-primary → no team block (single-player behaviour)

    // The squad's furthest-along round (MAX over the authority and every fresh
    // confirmed feed) — used to tell a feed that's caught up from one still showing
    // last round's (dead) state, and to convert an authority lagging a faster
    // teammate at a boundary into an honest unknown rather than a false last-man.
    const refRound = this.squadRefRound(now, refMap);
    const primaryId = this.primaryId();
    const members: TeamMember[] = live.map(([id, f]) => {
      const c = f.ctx;
      // Trust alive/dead ONLY when this feed has posted a frame for the CURRENT
      // round. A teammate who died last round but hasn't updated into this one yet
      // still has a "dead" cached frame — counting that as dead would fire a false
      // last-man at round start. Treat it as unknown instead.
      const caughtUp = c.round !== undefined && refRound !== undefined && c.round >= refRound;
      const alive = !caughtUp ? undefined : c.playerIsSelf ? (c.health ?? 0) > 0 : false;
      const staleMs = now - f.lastSeen;
      const tier: "fresh" | "lagging" = staleMs <= FRESH_READ_MS ? "fresh" : "lagging";
      return {
        name: f.tracker.ownName(),
        isPrimary: id === primaryId,
        alive,
        money: c.playerIsSelf ? c.money : undefined,
        tier,
        staleMs,
        // B1: per-friend debrief tag for the break-moment jab + wrap-up — fresh
        // members only (a lagging feed's match read is stale), synthesized number-free.
        note: tier === "fresh" ? debriefNote(f.tracker.matchReport()) : undefined,
      };
    });

    // Connection-blip ITEM 2: keep a CONFIRMED member who blipped non-fresh (still
    // in the map, not yet reaped) in the roster as an UNKNOWN — so rosterComplete /
    // aliveWired correctly drop to honest-unknown rather than the member silently
    // vanishing and a false last-man firing on the survivors.
    const liveIds = new Set(live.map(([id]) => id));
    for (const id of this.confirmedEver) {
      if (liveIds.has(id)) continue;
      // The primary is never a stale appendee: its personal state is merged separately
      // in mergedCtx (a dead/stale primary contributes nothing there, by design), and
      // listing it here with undefined money/alive would shadow that with a phantom entry.
      if (id === primaryId) continue;
      const f = this.feeds.get(id);
      if (!f) continue;                       // reaped -> genuinely gone
      if (!this.onRefMap(f, refMap)) continue; // different lobby now
      members.push({
        name: f.tracker.ownName(),
        isPrimary: id === primaryId,
        alive: undefined,
        money: undefined,
        tier: "lagging",          // REQUIRED field — a stale appendee is always lagging
        staleMs: now - f.lastSeen,
      });
    }

    const squadSize = this.squadSize();
    const rosterComplete = squadSize !== undefined && live.length >= squadSize;
    // A whole-team alive COUNT is only honest when we can see the whole team AND
    // every member's status is known. Otherwise expose per-player alive (for
    // naming) but no aggregate the LLM could misread as a whole-team fact.
    const aliveWired =
      rosterComplete && members.every((m) => m.alive !== undefined)
        ? members.filter((m) => m.alive === true).length
        : undefined;

    // The C4 carrier — only named when their feed is caught up to the squad round
    // AND tightly fresh, so a stale weapon_c4 frame never drives a late-round call.
    const carrier = live.find(([, f]) => {
      if (f.ctx.hasBomb !== true) return false;
      const caughtUp = f.ctx.round !== undefined && refRound !== undefined && f.ctx.round >= refRound;
      return caughtUp && now - f.lastSeen <= FRESH_READ_MS;
    });
    const bombCarrierName = carrier?.[1].tracker.ownName();

    let econ: TeamContext["econ"];
    if (runtime.teamTactics) {
      const econEntries = live
        .map(([id, f], i) => {
          const m = members[i]; // members[0..live.length-1] align with live by construction
          return {
            name: m.name,
            money: m.money,
            isPrimary: m.isPrimary,
            equipValue: f.ctx.playerIsSelf ? f.ctx.equipValue : undefined,
            alive: m.alive,
            keep: m.money !== undefined && m.tier === "fresh",
          };
        })
        .filter((e) => e.keep)
        .map(({ keep: _keep, ...e }) => ({ ...e, money: e.money as number }));
      if (econEntries.length > 0) econ = econEntries;
    }

    // Econ ITEM 17: snapshot this freezetime's buys (once per round) and derive the
    // cross-round buy-sync read. It's an observation about the VISIBLE wired buyers
    // (deriveBuySync names "the wired crew", never the team), so it needs only 2+
    // fresh visible buyers — NOT the whole-team rosterComplete license.
    let buySyncNote: string | undefined;
    if (refRound !== undefined && econ && econ.length >= 2) {
      const phaseIsFreeze = this.authorityFeed()?.ctx.roundPhase === "freezetime";
      if (phaseIsFreeze && this.econRing.at(-1)?.round !== refRound) {
        this.econRing.push({ round: refRound, buys: econ.map((e) => ({ name: e.name, klass: buyClass(e.money) })) });
        if (this.econRing.length > 5) this.econRing.shift();
      }
      buySyncNote = this.deriveBuySync();
    }

    // LLM-prompt ITEM 6a: the one-line honesty verdict the LLM follows literally.
    const visibility = rosterComplete
      ? `Full ${squadSize}-stack wired and fresh: you may state whole-team facts (last one alive, everyone's broke) with confidence.`
      : squadSize !== undefined
        ? `${live.length} of your ${squadSize}-stack wired: speak only about those players, BY NAME, and hedge everything about the other ${squadSize - live.length} — never a whole-team count.`
        : `${live.length} teammates wired, squad size unknown: speak only about the players you can see, BY NAME, and hedge the rest — never a whole-team fact.`;

    return { wiredCount: live.length, rosterComplete, squadSize, members, aliveWired, bombCarrierName, econ, buySyncNote, visibility };
  }

  /** "Last one alive" — only with whole-team certainty, every member's status
   *  known, and exactly one alive. In always-hedge mode (no squad size) the coach
   *  can't know un-wired teammates are dead, so it stays silent. */
  private deriveLastMan(team: TeamContext | undefined, now: number, refMap: string | undefined): CoachEvent | null {
    if (!runtime.teamTactics || !team) return null;
    // Connection-blip ITEM 2: a narrower gate than team.rosterComplete (left as-is for
    // the econ license). Armed when the high-water reached squadSize AND no member we're
    // actively hearing from is still behind the round.
    const squadSize = team.squadSize;
    const noFreshUnknown = !team.members.some((m) => m.alive === undefined && m.staleMs <= config.gsi.feedStaleMs);
    // Finding #2: count only confirmed-ever ids whose feed still exists AND is on the
    // squad's refMap — a confirmed member who requeued onto a DIFFERENT defined map but
    // keeps POSTing (never reaped, excluded from live/members as off-map) must NOT inflate
    // the count and fire a false last-man. Mirrors the reap()->confirmedEver.delete drop
    // via the off-map path, using the same refMap buildTeam/deriveLastMan compute.
    let confirmedOnMap = 0;
    for (const id of this.confirmedEver) {
      const f = this.feeds.get(id);
      if (f && this.onRefMap(f, refMap)) confirmedOnMap++;
    }
    const squadComplete = squadSize !== undefined && confirmedOnMap >= squadSize && noFreshUnknown;
    if (!squadComplete) return null;
    if (team.members.some((m) => m.alive === undefined)) return null; // a feed behind the round → unsure
    const alive = team.members.filter((m) => m.alive === true);
    if (alive.length !== 1) return null;
    // The lone survivor must be TIGHTLY fresh — an actively-clutching player posts
    // sub-second, so a feed that last reported "alive" several seconds ago (and may
    // have since died without us seeing the death frame) must not be named the last
    // man. lastManFreshMs (default 3s) is tighter than the shared FRESH_READ_MS
    // (feedStaleMs/2 ≈ 7.5s) on purpose: a last-man assertion is the most
    // honesty-sensitive call there is, and 7.5s is most of a heartbeat — long
    // enough for a "survivor" to have already died unseen. 3s is far above a live
    // player's update rate yet tight enough that a stale "alive" can't slip through.
    if (alive[0].staleMs > config.gsi.lastManFreshMs) return null;
    // Symmetrically, every OTHER member must read not-alive on a frame seen within
    // that same tight window. #19 already rejects an `alive === undefined` member,
    // but a member reading `alive === false` off a STALE frame may actually still
    // be up (we just haven't seen their newer alive frame) — asserting last-man off
    // that is a lie. Require the WHOLE team's status freshly confirmed, not just the survivor's.
    if (team.members.some((m) => m !== alive[0] && m.staleMs > config.gsi.lastManFreshMs)) return null;
    const ctx = this.mergedCtx(team);
    if (ctx.roundPhase !== "live") return null;
    // Connection-blip ITEM 13: latch on the squad-MAX round (same ref buildTeam used).
    const latchRound = this.squadRefRound(now, refMap) ?? ctx.round ?? null;
    if (this.lastManRound === latchRound) return null;
    this.lastManRound = latchRound;
    const survivor = alive[0];
    // The primary survivor is addressed in the second person ("you're the last
    // one up"); a teammate survivor is named.
    return { type: "lastManStanding", who: { name: survivor.isPrimary ? undefined : survivor.name }, rosterComplete: true };
  }

  /** C3 — the squad's entry-trade weak link: a CONFIRMED, fresh, non-primary
   *  teammate whose OWN feed shows a real opening-death habit this match (>=2),
   *  surfaced ONCE per offender per match and only at a freezetime (the calm moment
   *  to fix it). Reads each friend's own earlyDeaths (never ctx.earlyDeaths, which
   *  is undefined at 0) and never the primary (their entries are coached directly).
   *  Names the single worst offender; the anti-nag/rotation IS this code latch,
   *  never an LLM ask — this surface names a friend's bad pattern. */
  private deriveWeakLink(now: number, refMap: string | undefined): CoachEvent | null {
    if (!runtime.teamTactics) return null;
    if (this.authorityFeed()?.ctx.roundPhase !== "freezetime") return null;
    let worst: { id: string; name: string; deaths: number } | null = null;
    for (const [id, f] of this.feeds) {
      if (id === this.primaryId()) continue;
      if (this.weakLinkCalled.has(id)) continue;
      if (!this.isTeammate(f, id, now, refMap)) continue;
      const name = f.tracker.ownName();
      if (!name) continue;
      const deaths = f.tracker.matchReport().earlyDeaths;
      if (deaths < 2) continue;
      if (!worst || deaths > worst.deaths) worst = { id, name, deaths };
    }
    if (!worst) return null;
    this.weakLinkCalled.add(worst.id);
    return { type: "weakLink", who: { name: worst.name } };
  }

  /** Econ ITEM 17 — read the last few rounds' buy snapshots for a recurring out-of-sync
   *  pattern (one lone full-buyer while the rest save, or vice versa). Names the offender
   *  only when it's consistently the same player; otherwise a generic crew nudge. */
  private deriveBuySync(): string | undefined {
    if (this.econRing.length < 2) return undefined;
    const offenders: Array<string | undefined> = [];
    for (const snap of this.econRing) {
      if (snap.buys.length < 2) continue;
      const buying = snap.buys.filter((b) => b.klass === "full");
      const saving = snap.buys.filter((b) => b.klass === "eco");
      if (buying.length === 1 && saving.length >= 1) offenders.push(buying[0].name);
      else if (saving.length === 1 && buying.length >= 1) offenders.push(saving[0].name);
    }
    if (offenders.length < 2) return undefined;
    const named = offenders.filter((n): n is string => !!n);
    const allSame = named.length === offenders.length && named.every((n) => n === named[0]);
    // Worded around MONEY, not "buying": buyClass reads the unspent wallet, so a player
    // sitting on cash may be already-kitted (economizing correctly), not over-buying —
    // don't assert they spent out of sync, just flag the econ gap to coordinate.
    return allSame
      ? `${named[0]}'s money's been out of sync with the wired crew the last few rounds — get the buy calls coordinated.`
      : `The wired crew's money's been out of sync the last few rounds — one's loaded while the others are saving. Call the buy together.`;
  }

  /** Merged context for the engine and LLM: global half from the AUTHORITY feed,
   *  personal half from the PRIMARY feed (only when the primary is its own self —
   *  a dead primary contributes no gear, exactly as single-player today), plus the
   *  team block. The primary/authority tracker contexts are recomputed LIVE here
   *  so the locally-derived clock (round/bomb timers, lastKillSecondsAgo) is
   *  current even on the async getCtx() timer path, not frozen at the last payload. */
  private mergedCtx(team: TeamContext | undefined): MatchContext {
    const primary = this.primaryFeed();
    const authority = this.authorityFeed();
    const p = primary?.tracker.context();
    const a = authority ? authority.tracker.context() : p;
    if (!a) return { ...EMPTY_CTX, team };

    // Personal fields only when the primary feed is describing the user (alive,
    // own block). Otherwise they're absent and the engine treats it as "dead",
    // never borrowing a teammate's gear.
    const self = p?.playerIsSelf ? p : undefined;
    const mem = p ?? a; // match memory follows the primary; fall back to authority pre-primary

    return {
      // global (authority)
      map: a.map,
      mode: a.mode,
      round: a.round,
      roundKind: a.roundKind,
      roundPhase: a.roundPhase,
      bomb: a.bomb,
      roundTimeLeftSec: a.roundTimeLeftSec,
      bombTimeLeftSec: a.bombTimeLeftSec,
      ourSide: a.ourSide,
      ourScore: a.ourScore,
      theirScore: a.theirScore,
      ourLossStreak: a.ourLossStreak,
      theirLossStreak: a.theirLossStreak,
      ourTimeoutsLeft: a.ourTimeoutsLeft,
      matchPoint: a.matchPoint,
      moneyResetsNextRound: a.moneyResetsNextRound,
      recentRoundWins: a.recentRoundWins,
      // personal (primary, self-only)
      playerName: p?.playerName,
      health: self?.health,
      armor: self?.armor,
      helmet: self?.helmet,
      money: self?.money,
      equipValue: self?.equipValue,
      defuseKit: self?.defuseKit,
      hasBomb: self?.hasBomb,
      weapons: self?.weapons,
      kills: self?.kills,
      assists: self?.assists,
      deaths: self?.deaths,
      mvps: self?.mvps,
      lastKillSecondsAgo: p?.lastKillSecondsAgo,
      earlyDeaths: p?.earlyDeaths,
      spectating: p?.spectating,
      // match memory (primary's)
      history: mem.history,
      notables: mem.notables,
      pistolRounds: mem.pistolRounds,
      streak: mem.streak,
      playerIsSelf: p?.playerIsSelf ?? false,
      team,
    };
  }

  // --- public surface mirroring GsiTracker, for index.ts EngineDeps ----------

  /** How many CONFIRMED teammate feeds (same match + side) are currently
   *  connected — for /coach status. A stray enemy/other-lobby feed isn't counted. */
  wiredCount(): number {
    const now = Date.now();
    const refMap = this.refMap(now);
    let n = 0;
    for (const [id, f] of this.feeds) if (this.isTeammate(f, id, now, refMap)) n++;
    return n;
  }

  /** The configured squad size (COACH_SQUAD_SIZE; undefined => always hedge). */
  squadSize(): number | undefined { return config.coach.squadSize; }

  /** Ops ITEM 9: feeds currently connected but NOT confirmed members, with the reason
   *  (stale/off-map/vote state) — for /coach status. */
  quarantinedFeeds(): { name?: string; reason: string }[] {
    const now = Date.now();
    const refMap = this.refMap(now);
    const out: { name?: string; reason: string }[] = [];
    for (const [id, f] of this.feeds) {
      if (now - f.lastSeen > config.gsi.feedIdleMs) continue;
      const reason = this.membershipReason(f, id, now, refMap);
      if (reason) out.push({ name: f.tracker.ownName(), reason });
    }
    return out;
  }

  /** Ops ITEM 14: whether the CONFIGURED primary produced a feed this match. */
  primaryEverSeenThisMatch(): boolean { return this.primaryEverSeen; }

  /** Every feed POSTing right now, regardless of the same-side vote — the honest
   *  "is CS2 actually talking to the coach?" signal for /coach setup confirmation.
   *  A freshly-installed feed in warmup/menu has cast no side votes yet, so it is
   *  NOT a confirmed teammate (wiredCount excludes it) but it IS connected here —
   *  which is exactly what a friend needs to see to know their install worked. */
  connectedFeeds(): Array<{ name: string; ageMs: number }> {
    const now = Date.now();
    const out: Array<{ name: string; ageMs: number }> = [];
    for (const f of this.feeds.values()) {
      const ageMs = now - f.lastSeen;
      if (ageMs > config.gsi.feedStaleMs) continue;
      out.push({ name: f.tracker.ownName() ?? f.tracker.providerName() ?? "a player", ageMs });
    }
    return out.sort((a, b) => a.ageMs - b.ageMs);
  }

  /** Owner-only diagnostic: every feed known right now (within feedIdleMs), with its
   *  SteamID64 EXPOSED — unlike connectedFeeds()/quarantinedFeeds(), which hide ids — plus
   *  its role, freshness age, and confirmed/quarantine reason. index.ts cross-references the
   *  steam64 against the Discord link so the admin surface can answer "who is this feed?". */
  feedsDetailed(): Array<{
    steam64: string;
    name?: string;
    ageMs: number;
    confirmed: boolean;
    reason?: string;
    isPrimary: boolean;
    isAuthority: boolean;
  }> {
    const now = Date.now();
    const refMap = this.refMap(now);
    const out: Array<{
      steam64: string;
      name?: string;
      ageMs: number;
      confirmed: boolean;
      reason?: string;
      isPrimary: boolean;
      isAuthority: boolean;
    }> = [];
    for (const [id, f] of this.feeds) {
      if (now - f.lastSeen > config.gsi.feedIdleMs) continue;
      const confirmed = this.isTeammate(f, id, now, refMap);
      out.push({
        steam64: id,
        name: f.tracker.ownName() ?? f.tracker.providerName(),
        ageMs: now - f.lastSeen,
        confirmed,
        reason: confirmed ? undefined : (this.membershipReason(f, id, now, refMap) ?? undefined),
        isPrimary: id === this.primaryId(),
        isAuthority: id === this.authorityId,
      });
    }
    return out.sort((a, b) => a.ageMs - b.ageMs);
  }

  /** Merged context snapshot (timer callouts + status), recomputed live. */
  context(): MatchContext {
    return this.mergedCtx(this.buildTeam(Date.now()));
  }

  /** Freshest feed's payload age (is the game live at all?), or null if none. */
  lastUpdateAgeMs(): number | null {
    const now = Date.now();
    let min: number | null = null;
    for (const f of this.feeds.values()) {
      const age = now - f.lastSeen;
      if (min === null || age < min) min = age;
    }
    return min;
  }

  /** The primary's exact last-own-kill timestamp (kill-hype staleness checks). */
  lastOwnKillAtMs(): number | null {
    return this.primaryFeed()?.tracker.lastOwnKillAtMs() ?? null;
  }

  /** The AUTHORITY feed's round-live / bomb-plant epochs — the engine schedules its
   *  clock callouts off these (the true in-game start) rather than its own handle time,
   *  so GSI buffering / async processing / the ~1-2s Valve plant delay don't make the
   *  callout land late. Global timing belongs to the same feed that supplies the events. */
  roundLiveAtMs(): number | null {
    return this.authorityFeed()?.tracker.roundLiveAtMs() ?? null;
  }

  bombPlantedAtMs(): number | null {
    return this.authorityFeed()?.tracker.bombPlantedAtMs() ?? null;
  }

  /** The primary's current own round-kill count (null while dead/no primary). */
  ownRoundKillsNow(): number | null {
    return this.primaryFeed()?.tracker.ownRoundKillsNow() ?? null;
  }

  /** The primary's unabridged round history (storytelling moments). */
  fullHistory(): string[] {
    return this.primaryFeed()?.tracker.fullHistory() ?? [];
  }

  /** The primary's match report, with botsDetected OR'd across CONFIRMED teammate
   *  feeds in THIS match — any teammate spotting a bot marks the whole match as
   *  practice (so it isn't recorded to the user's session history or polled on
   *  Leetify). A stray feed from an unrelated lobby can't condemn the primary's game. */
  matchReport(): ReturnType<GsiTracker["matchReport"]> {
    const primary = this.primaryFeed();
    const base: ReturnType<GsiTracker["matchReport"]> = primary
      ? primary.tracker.matchReport()
      : { rounds: [], pistols: {}, earlyDeaths: 0, notables: [], stats: undefined, botsDetected: false };
    return { ...base, botsDetected: base.botsDetected || this.anyTeammateBotsDetected() };
  }

  private anyTeammateBotsDetected(): boolean {
    const now = Date.now();
    const refMap = this.refMap(now);
    for (const [id, f] of this.feeds) {
      if (!this.isTeammate(f, id, now, refMap)) continue;
      if (f.tracker.matchReport().botsDetected) return true;
    }
    return false;
  }

  /** The primary user's SteamID64 (for the Leetify lookup). undefined when the
   *  configured primary hasn't connected a feed yet — Leetify is then skipped. */
  steamId(): string | undefined {
    return this.primaryFeed()?.tracker.steamId();
  }

  /** The confirmed wired crew this match (primary first), as {steam64, name,
   *  isPrimary} — for the once-per-match squad Leetify recap and any other
   *  post-match squad surface that needs the friends' Steam IDs (TeamMember
   *  deliberately carries none). Sourced from the per-match high-water
   *  confirmedEver set, so a friend who closed CS2 right at gameover is still
   *  counted. Empty when no primary feed exists (mirrors steamId() => undefined,
   *  so the recap is skipped). MUST be read SYNCHRONOUSLY at matchEnd —
   *  confirmedEver is wiped by the next match's matchStart, the feeds idle-reaped. */
  confirmedSquad(): Array<{ steam64: string; name?: string; isPrimary: boolean }> {
    const primary = this.primaryId();
    if (!primary || !this.feeds.has(primary)) return [];
    const out: Array<{ steam64: string; name?: string; isPrimary: boolean }> = [];
    const seen = new Set<string>();
    const push = (id: string) => {
      if (seen.has(id)) return;
      const f = this.feeds.get(id);
      if (!f) return; // reaped between confirm and now — genuinely gone
      seen.add(id);
      out.push({ steam64: id, name: f.tracker.ownName(), isPrimary: id === primary });
    };
    push(primary); // primary first, even if not (re)added to confirmedEver yet
    for (const id of this.confirmedEver) push(id); // de-dup: the primary is in confirmedEver too
    return out;
  }

  /** The wired crew CONNECTED right now (primary first), as {steam64, name, isPrimary},
   *  for the match-start Leetify brief. Unlike confirmedSquad() this uses CONNECTION +
   *  same-map, NOT the same-side vote — at warmup/match start no live rounds have happened
   *  so nobody is vote-confirmed yet, and a co-queued stack is on the same map. (A friend who
   *  somehow holds the token on the ENEMY team would slip in, but that needs your GSI token
   *  and the same lobby — vanishingly rare, and the brief only states their own past form.)
   *  Empty when the primary feed isn't present (the brief is then skipped, like steamId()). */
  connectedSquad(): Array<{ steam64: string; name?: string; isPrimary: boolean }> {
    const now = Date.now();
    const primary = this.primaryId();
    const primaryFeed = primary ? this.feeds.get(primary) : undefined;
    if (!primary || !this.isFresh(primaryFeed, now)) return [];
    const refMap = this.refMap(now);
    const out: Array<{ steam64: string; name?: string; isPrimary: boolean }> = [
      { steam64: primary, name: primaryFeed!.tracker.ownName() ?? primaryFeed!.tracker.providerName(), isPrimary: true },
    ];
    for (const [id, f] of this.feeds) {
      if (id === primary) continue;
      if (!this.isFresh(f, now)) continue;
      if (!this.onRefMap(f, refMap)) continue; // a different-lobby feed isn't in this match
      out.push({ steam64: id, name: f.tracker.ownName() ?? f.tracker.providerName(), isPrimary: false });
    }
    return out;
  }

  /** Quiet unless the primary — or a teammate in the SAME match — is still
   *  mid-game. The delayed Leetify recap must not talk over anyone's live game in
   *  the shared channel, but an unrelated lobby's feed must NOT veto it. The match
   *  is identified by the primary's last-played map (lastPrimaryMap), which
   *  survives the primary returning to the menu, so a different-lobby friend never
   *  blocks the recap. Staleness is judged by each tracker's own
   *  quietMomentForSpeech (it handles the 2-min / menu / between-games logic). */
  quietMomentForSpeech(): boolean {
    const primary = this.primaryFeed();
    if (primary && !primary.tracker.quietMomentForSpeech()) return false;
    const refMap = this.lastPrimaryMap;
    if (refMap) {
      for (const [, f] of this.feeds) {
        if (f === primary) continue;
        if (f.ctx.map !== refMap) continue; // a different lobby's game must not gate our recap
        if (!f.tracker.quietMomentForSpeech()) return false;
      }
    }
    return true;
  }

  private shortId(steamid: string): string {
    return `…${steamid.slice(-5)}`;
  }
}

/** B1 — a short, NUMBER-FREE qualitative debrief tag for one wired feed's match so
 *  far, synthesized (never a raw notable, which can carry a teammate number the
 *  matchEnd K/D guardrail forbids). One phrase, most salient first: a teamkill or bad
 *  habit is roast fodder (friends are fair game), an ace or knife is grudging respect.
 *  undefined when nothing stands out. */
function debriefNote(report: { earlyDeaths: number; notables: string[] }): string | undefined {
  // Drop the spectate notable ("<name> triple while you watched") before the
  // substring scan — it's the ONE notable carrying an arbitrary OTHER player's
  // name, so a spectated "Grace"/"Ace"/"Knifer" would otherwise fabricate an
  // "ace"/"knife" tag for the friend who merely watched. Everything else is a
  // fixed marker or the player's own count.
  const own = report.notables.filter((n) => !n.includes("while you watched"));
  const tags = own.join(" ").toLowerCase();
  if (tags.includes("teamkill")) return "teamkilled one of their own";
  if (tags.includes("ace")) return "dropped an ace this match";
  if (tags.includes("knife")) return "got a cheeky knife kill in";
  if (report.earlyDeaths >= 2) return "kept dying early on the entry";
  if (tags.includes("unthrown")) return "died sitting on their utility";
  if (tags.includes("flashed")) return "kept dying flashed";
  if (tags.includes("burning")) return "cooked themselves in a molly";
  return undefined;
}

/** Econ ITEM 17 — coarse buy bucket for the cross-round buy-sync read. */
function buyClass(money: number): "full" | "force" | "eco" {
  if (money >= 4000) return "full";
  if (money >= 2000) return "force";
  return "eco";
}

/** The key with the highest count in a tally, or undefined for an empty tally or
 *  an exact tie (an arbitrary winner could endorse the wrong half). */
function plurality<K>(counts: Map<K, number>): K | undefined {
  let best: K | undefined;
  let bestN = 0;
  let tied = false;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
      tied = false;
    } else if (n === bestN) {
      tied = true;
    }
  }
  return tied ? undefined : best;
}
