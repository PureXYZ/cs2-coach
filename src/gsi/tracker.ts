import type { GsiPayload, GsiPlayer, GsiWeapon, Team, TeamContext } from "./types.js";
import { MatchMemory, type RoundRecord } from "./memory.js";
import { config } from "../config.js";

// Events the rule engine and LLM coach react to. GSI gives players no kill feed,
// no positions and no clock — every event here is derivable from own-player state,
// round phase transitions and team scores only. The one exception: while the user
// is dead, the player block describes the spectated TEAMMATE, which legitimately
// lets us see (only) that teammate's kills and health.
export type CoachEvent =
  | { type: "matchStart"; map: string; mode: string }
  | { type: "freezetime"; round: number }
  | { type: "roundLive"; round: number }
  | { type: "bombPlanted"; ourSide: Team | undefined }
  | { type: "bombDefused"; ourSide: Team | undefined }
  | { type: "bombExploded"; ourSide: Team | undefined }
  // mvp is filled in by the engine when the MVP event landed in the same payload
  // batch — the round-end line then covers it instead of a separate MVP line.
  | { type: "roundEnd"; won: boolean | undefined; method: string; ourScore: number; theirScore: number; mvp?: boolean }
  | { type: "halftime" }
  // A tactical timeout started — 30 seconds of dead air, the one mid-match
  // moment with room for an actual speech. ours is undefined when the side
  // is unknown (the engine stays silent then).
  | { type: "timeout"; ours?: boolean }
  | { type: "matchPoint"; forUs: boolean }
  | { type: "matchEnd"; won: boolean | undefined; ourScore: number; theirScore: number }
  | { type: "kill"; roundKills: number; headshot: boolean }
  // Own kill with a story: knife/zeus/grenade attribution from the active weapon
  // + recent-throw/gunfire/kill-cash heuristics, or a clutch frag on low HP.
  // kills = how many bodies this one event accounts for (a molly burning two
  // lands as a single increment of 2) — lets the line call a multi-kill.
  | { type: "specialKill"; kind: "knife" | "zeus" | "grenade" | "lowhp"; nade?: "he" | "fire"; hp?: number; kills?: number }
  // Own scoreboard kill counter went DOWN while alive — only a teamkill does that.
  | { type: "teamkill" }
  // The teammate the dead user is spectating got a kill (the only friend-play GSI
  // shows us). spectatedSteamid identifies that teammate so the multi-feed
  // RosterManager can drop this when the same teammate is a wired feed reporting
  // the kill first-hand (it would otherwise double-count).
  | { type: "teammateKill"; name?: string; roundKills: number; health?: number; spectatedSteamid?: string }
  // cause is filled in when the dying frame's intensities prove how they went —
  // burning (molotov) or fully flashed (blind) — so the roast can name it.
  | { type: "death"; cause?: "fire" | "blind" }
  | { type: "mvp" }
  // --- roster-derived (multi-feed): emitted by the RosterManager, not the
  // per-feed tracker, once friends are also POSTing their own GSI. ---
  // A WIRED teammate (their own feed) racked up 3+ kills this round — named,
  // live hype, distinct from the grave-spectator teammateKill above.
  | { type: "teammateMultiKill"; who: { steamid: string; name?: string }; roundKills: number }
  // Down to one alive among the squad. Only emitted with whole-team certainty
  // (rosterComplete) — in always-hedge mode the coach can't know un-wired
  // teammates are dead, so it stays silent.
  | { type: "lastManStanding"; who: { name?: string }; rosterComplete: boolean }
  | { type: "weakLink"; who: { name: string } };

/** Snapshot of everything we know, used by rules and serialized for the LLM. */
export interface MatchContext {
  map?: string;
  mode?: string;
  round?: number;
  /** "pistol" on rounds 1 and 13 — the rounds where buy advice changes completely. */
  roundKind?: "pistol";
  roundPhase?: string;
  bomb?: string;
  /** Locally derived clock (GSI sends none): seconds left in a live round, pre-plant. */
  roundTimeLeftSec?: number;
  /** Locally derived: seconds left on a planted bomb. */
  bombTimeLeftSec?: number;
  ourSide?: Team;
  ourScore?: number;
  theirScore?: number;
  /** Our team's loss counter (GSI decays it on a win rather than zeroing it —
   *  treat it as the loss-bonus level, not a literal in-a-row count). */
  ourLossStreak?: number;
  /** THEIR loss counter, same decaying semantics — the only enemy-economy
   *  signal GSI gives. */
  theirLossStreak?: number;
  /** Tactical timeouts our team still has available. */
  ourTimeoutsLeft?: number;
  /** True while the player personally carries the C4 — planting is their job. */
  hasBomb?: true;
  /** Own deaths inside the first ~20s of a round this match (present when > 0). */
  earlyDeaths?: number;
  /** Consecutive most-recent rounds the player died in the opening seconds —
   *  the tilt/over-peek spiral. Present ONLY when >= 2 (a single open death is
   *  not a pattern), so the engine can treat its mere presence as the signal. */
  earlyDeathStreak?: number;
  /** Short spoken-register own-data patterns this match (cold force buys, opening
   *  deaths, headshot rate). Present ONLY when non-empty — derived from records,
   *  never fabricated, so the coach can state them as fact. */
  habits?: string[];
  /** Own loadout when alive: the primary gun + ammo + carried nades, so the LLM
   *  can make AWP-specific / dry-gun / use-your-util calls. Self+alive only. */
  loadout?: { primary?: string; primaryType?: string; clip?: number; reserve?: number; nades?: string[] };
  /** Cross-session trend lines from past matches — attached by the engine at
   *  the storytelling moments only (match start, halftime, match end). */
  recentForm?: string[];
  /** One-shot engine flag: this freezetime's line should call the tactical
   *  timeout (set at most once per cooldown window, so the LLM can't nag). */
  suggestTimeout?: true;
  /** Someone is one round from taking the match — saving is pointless, say so. */
  matchPoint?: "us" | "them";
  /** Last round before a half/OT money reset (MR12 round 12/24, then every 3rd) — saving is pointless. */
  moneyResetsNextRound?: true;
  /**
   * Seconds since the player's own most recent kill this round (alive only).
   * Small values mean they're mid-fight — "save"/"disengage" calls are tone-deaf.
   */
  lastKillSecondsAgo?: number;
  playerName?: string;
  health?: number;
  armor?: number;
  helmet?: boolean;
  money?: number;
  equipValue?: number;
  defuseKit?: boolean;
  weapons?: string[];
  kills?: number;
  assists?: number;
  deaths?: number;
  mvps?: number;
  /** While dead: the teammate currently spectated (name + their state). */
  spectating?: { name?: string; health?: number; weapons?: string[] };
  /** Last few rounds' outcomes, e.g. ["t_win_bomb", "ct_win_elimination"]. */
  recentRoundWins?: string[];
  /** Compact per-round story, oldest first, e.g. "R5 T full WON (bomb) you 2k". */
  history?: string[];
  pistolRounds?: { first?: "won" | "lost"; second?: "won" | "lost" };
  /** e.g. "won last 3" / "lost last 2". */
  streak?: string;
  /** Match highlights for banter callbacks, e.g. "R7: knife kill". */
  notables?: string[];
  /** True while the player-block describes the user (false = dead, spectating a teammate). */
  playerIsSelf: boolean;
  /** What the coach can see of the squad — only the teammates also running the
   *  coach. Attached by the RosterManager to the primary's context when 2+ feeds
   *  are live; undefined for a solo player (single-feed = single-player coach). */
  team?: TeamContext;
}

interface PrevSelf {
  health: number;
  roundKills: number;
  roundKillHs: number;
  matchKills: number;
  mvps: number;
  money: number;
  /** Last alive-frame flash/burn intensity — the dying frame's own state can
   *  already be wiped, so death forensics fall back to these. */
  flashed: number;
  burning: number;
  /** Every grenade carried (all kinds), for the died-with-full-pockets check. */
  nadesCarried: number;
}

/** Kill-capable grenades we attribute kills to (flash/smoke/decoy kills are too rare to chase). */
const NADE_KINDS: Record<string, "he" | "fire"> = {
  weapon_hegrenade: "he",
  weapon_molotov: "fire",
  weapon_incgrenade: "fire",
};

// How long after a throw a kill may still be that grenade's doing, measured
// from the inventory-shrink frame (~0.5s after release). The HE fuse is ~1.6s
// from release regardless of flight; a molly flies ~1s and burns ~7s.
const NADE_KILL_WINDOW_MS: Record<"he" | "fire", number> = { he: 3_000, fire: 9_000 };

/** Competitive knife-kill cash — lands in state.money on the same GSI tick as the kill. */
const KNIFE_KILL_REWARD = 1_500;
/** A gun clip going down this recently before a kill means the gun got it — the
 *  knife being "active" on the kill frame is just a quick-switch for movement
 *  (CS players swap to the knife to run faster right after fragging). */
const GUN_KILL_RECENT_MS = 2_000;

// Death forensics: facts go into match memory as notables; the LLM does the roasting.
/** state.flashed is a 0-255 whiteout intensity; above this the player was effectively blind. */
const FLASHED_BLIND_MIN = 160;
/** state.burning is 0-255 too and decays — a residual tail from clipping a fire
 *  edge shouldn't read as burning to death, so require real intensity. */
const BURNING_DEATH_MIN = 150;
/** A molly flies ~1s and burns ~7s, so ~8s is the longest our own fire could still
 *  be burning after we threw it. Fire deaths inside this window get hedged as
 *  possibly-own (no enemy-fire claim); BEYOND it the own molly is provably out, so
 *  a fire death is enemy fire and earns the roast. Sized to the burn, not padded. */
const OWN_MOLLY_BLAME_MS = 8_000;
/** Dying inside this window after the round goes live is an "opening seconds" death. */
const EARLY_DEATH_WINDOW_MS = 20_000;

/**
 * Rounds needed to win given the current scores: 13 in regulation (MR12), then
 * 16, 19, ... through MR3 overtime blocks (each tied block pushes the target +3).
 * Exported for the LLM prompt's "now on match point" round-end framing.
 */
export function winTarget(ourScore: number, theirScore: number): number {
  let target = 13;
  while (ourScore >= target || theirScore >= target || (ourScore === target - 1 && theirScore === target - 1)) {
    target += 3;
  }
  return target;
}

/** Raw match-memory snapshot returned by GsiTracker.matchReport(). */
export interface MatchReportData {
  rounds: readonly RoundRecord[];
  pistols: { first?: "won" | "lost"; second?: "won" | "lost" };
  earlyDeaths: number;
  notables: string[];
  /** Own K/A/D/MVPs from the last self frame — present even when the player
   *  died in the final round (the gameover context fields would be empty). */
  stats?: { kills: number; assists: number; deaths: number; mvps: number };
  /** A spectated teammate had a bot steamid — practice match, don't persist. */
  botsDetected: boolean;
}

export class GsiTracker {
  private prev: GsiPayload | null = null;
  private prevSelf: PrevSelf | null = null;
  /** Own grenade inventory (units by weapon name) — diffed to detect throws. */
  private prevNades: Record<string, number> | null = null;
  /** Last throw time per nade kind — a molly can still be burning when a later HE expires. */
  private lastNadeThrows: Partial<Record<"he" | "fire", number>> = {};
  /** Own gun clips (rounds by weapon name) — a decrease means the player fired. */
  private prevGunClips: Record<string, number> | null = null;
  private lastGunfireAt: number | null = null;
  /** When the player's own round_kills last ticked up — "mid-fight" signal for save-call suppression. */
  private lastOwnKillAt: number | null = null;
  /** Spectated-teammate baseline while the user is dead. */
  private prevSpec: { steamid: string; roundKills: number } | null = null;
  private inMatch = false;
  /** A spectated teammate carried a fake steamid — this is a bot match. */
  private botsSeen = false;
  private announcedMatchPointAt: string | null = null;
  /** Round number as of its freezetime — map.round's increment timing at round end is unreliable. */
  private liveRound = 0;
  private roundLiveAt: number | null = null;
  private bombPlantedAt: number | null = null;
  private lastUpdateAt: number | null = null;
  /** Last own match_stats seen on any self frame — survives the death-cam
   *  spectate switch and the gameover baseline wipe, so the post-match record
   *  keeps the K/D even when the player died in the final round. */
  private lastOwnStats: { kills: number; assists: number; deaths: number; mvps: number } | null = null;
  /** matchReport() memo, invalidated each update() — the report is immutable
   *  between payloads but read often (per fresh member in buildTeam + deriveWeakLink). */
  private reportCache: MatchReportData | null = null;
  private readonly memory = new MatchMemory();
  /**
   * The user's side survives death here: once dead, the player block describes a
   * spectated teammate, but competitive auto-spectate only targets teammates, so
   * player.team stays valid as a fallback when we have nothing better.
   */
  private lastKnownSide: Team | undefined;
  /** Own Steam name from the last self frame — persists across death so the
   *  multi-feed roster can still name this player while they're spectating. */
  private ownNameSeen: string | undefined;

  /** Feed one GSI payload; returns the events it implies, in priority order. */
  update(payload: GsiPayload): CoachEvent[] {
    const events: CoachEvent[] = [];
    const prev = this.prev;
    const now = Date.now();
    this.lastUpdateAt = now;
    this.reportCache = null; // this payload may change the match memory — recompute on next read

    const map = payload.map;
    const round = payload.round;
    const isSelf = this.isSelf(payload);

    if (isSelf && payload.player?.team) {
      this.lastKnownSide = payload.player.team;
    } else if (!this.lastKnownSide && payload.player?.team) {
      this.lastKnownSide = payload.player.team; // started while dead: teammate's side = ours
    }
    if (isSelf && payload.player?.name) this.ownNameSeen = payload.player.name;
    const ourSide = this.lastKnownSide;

    // --- match lifecycle ---------------------------------------------------
    const prevMapPhase = prev?.map?.phase;
    const mapPhase = map?.phase;

    // Hard continuations of the SAME match: a tactical timeout (timeout_ct/
    // timeout_t) resuming, halftime (intermission), or just play continuing
    // (live → live). None of these is a fresh match even at a 0-0 scoreboard — a
    // round-1 timeout is still 0-0 — so they suppress the match-start reset
    // regardless of score. Gated on inMatch so a COLD start during a timeout/
    // halftime still adopts the match properly.
    const hardContinuation =
      this.inMatch &&
      (prevMapPhase === "live" ||
        prevMapPhase === "intermission" ||
        prevMapPhase === "timeout_ct" ||
        prevMapPhase === "timeout_t");
    // prevMapPhase === undefined while in a match is a menu/no-map blip (a
    // reconnect flicker that dropped the map block). Normally treated as
    // mid-match so the re-fired "live" can't wipe round-by-round memory — UNLESS
    // the scoreboard is positively 0-0, which means the prior match was abandoned
    // and a genuinely new one has started (then we DO want to adopt + reset). A
    // missing score can't prove a new match, so it stays suppressed.
    const ctScore = map?.team_ct?.score;
    const tScore = map?.team_t?.score;
    const freshScore = ctScore === 0 && tScore === 0;
    const blipContinuation = this.inMatch && prevMapPhase === undefined && !freshScore;
    const midMatchPhase = hardContinuation || blipContinuation;
    if (map && mapPhase === "live" && !midMatchPhase) {
      this.inMatch = true;
      this.botsSeen = false;
      this.announcedMatchPointAt = null;
      this.liveRound = 0;
      this.lastOwnStats = null;
      this.memory.reset();
      events.push({ type: "matchStart", map: map.name ?? "unknown", mode: map.mode ?? "unknown" });
    }

    if (mapPhase === "intermission" && prevMapPhase === "live") {
      events.push({ type: "halftime" });
    }

    // Tactical timeout started. prev must be an IN-MATCH frame: both a cold
    // start and a reconnect (where only menu payloads preceded — those carry
    // no map block) land mid-pause, and a speech into a half-finished
    // timeout helps nobody.
    const inTimeout = mapPhase === "timeout_ct" || mapPhase === "timeout_t";
    const wasTimeout = prevMapPhase === "timeout_ct" || prevMapPhase === "timeout_t";
    if (prev?.map && inTimeout && !wasTimeout) {
      const ours = ourSide ? (mapPhase === "timeout_ct") === (ourSide === "CT") : undefined;
      events.push({ type: "timeout", ours });
    }

    // prev must be an in-match frame: a process restart during the post-match
    // scoreboard (prev null) or a rejoin from the menu (prev has no map block)
    // would otherwise re-fire matchEnd for a match this process never saw —
    // and persist a junk session record and re-run the wrap-up speech.
    if (prev?.map && mapPhase === "gameover" && prevMapPhase !== "gameover") {
      const { ourScore, theirScore } = this.scores(payload, ourSide);
      events.push({
        type: "matchEnd",
        // A tie (overtime exhausted, or a draw mode) must NOT read as a loss:
        // equal scores resolve to undefined ("no winner"), not false.
        won:
          ourScore !== undefined && theirScore !== undefined
            ? ourScore === theirScore
              ? undefined
              : ourScore > theirScore
            : undefined,
        ourScore: ourScore ?? 0,
        theirScore: theirScore ?? 0,
      });
      this.inMatch = false;
      this.lastKnownSide = undefined;
      this.liveRound = 0; // a stale round number must not leak into the next match's context
      // Cleared on gameover too: if the next match's "live" transition is missed
      // (payload gap), a stale us@13/them@13 key would mute its first match point.
      this.announcedMatchPointAt = null;
    }

    // --- round phase transitions -------------------------------------------
    const prevRoundPhase = prev?.round?.phase;
    const roundPhase = round?.phase;
    const roundNum = (map?.round ?? 0) + 1; // map.round is the count of completed rounds

    // Adopt/advance the live round from map.round during live & freezetime. This
    // covers a mid-round join (no freezetime transition seen) AND a MISSED
    // freezetime payload (a packet gap spanning the freeze window) that would
    // otherwise latch liveRound a round behind for the whole next round — which
    // the multi-feed roster's equal-round vote gate relies on being tight.
    // Monotonic catch-up only (never backwards), and NOT during 'over': map.round
    // increments early there, so a round-end snapshot would wrongly claim the next
    // round (context() prefers liveRound for exactly that reason).
    if (mapPhase === "live" && (roundPhase === "live" || roundPhase === "freezetime") && roundNum > this.liveRound) {
      this.liveRound = roundNum;
    }

    if (roundPhase === "freezetime" && prevRoundPhase !== "freezetime") {
      events.push({ type: "freezetime", round: roundNum });
      this.liveRound = roundNum;
      this.roundLiveAt = null;
      this.bombPlantedAt = null;
      this.memory.startRound(roundNum, ourSide);

      // Match point check at buy time (MR12 regulation + MR3 overtime blocks).
      const { ourScore, theirScore } = this.scores(payload, ourSide);
      if (ourScore !== undefined && theirScore !== undefined) {
        const target = winTarget(ourScore, theirScore);
        const forUs = ourScore === target - 1 ? true : theirScore === target - 1 ? false : undefined;
        if (forUs !== undefined) {
          // Key on side+target, not exact score: a team can sit at match point for
          // many rounds while the other score creeps up, and that stretch should
          // be announced once, not at every freezetime.
          const key = `${forUs ? "us" : "them"}@${target}`;
          if (this.announcedMatchPointAt !== key) {
            events.push({ type: "matchPoint", forUs });
            this.announcedMatchPointAt = key;
          }
        }
      }
    }

    if (roundPhase === "live" && prevRoundPhase === "freezetime") {
      events.push({ type: "roundLive", round: roundNum });
      this.roundLiveAt = now;
      this.memory.roundLive(this.liveRound || roundNum, isSelf ? payload.player?.state?.equip_value : undefined);
    }

    if (roundPhase === "over" && prevRoundPhase !== "over" && round?.win_team) {
      const { ourScore, theirScore } = this.scores(payload, ourSide);
      const won = ourSide ? round.win_team === ourSide : undefined;
      const method = this.lastRoundMethod(payload) ?? "unknown";
      events.push({ type: "roundEnd", won, method, ourScore: ourScore ?? 0, theirScore: theirScore ?? 0 });
      this.memory.endRound(won, method);
      this.roundLiveAt = null;
      this.bombPlantedAt = null;
    }

    // --- bomb (note: plant signal is delayed ~1-2s by Valve, by design) -----
    // prev must be an in-game frame: a cold start — or a reconnect, where only
    // menu payloads preceded — mid-post-plant is a baseline sync, not a fresh
    // plant. Announcing it would also start a wrong 40s bomb clock.
    const prevBomb = prev?.round?.bomb;
    const bomb = round?.bomb;
    if (prev?.round && bomb && bomb !== prevBomb) {
      if (bomb === "planted") {
        events.push({ type: "bombPlanted", ourSide });
        this.bombPlantedAt = now;
        this.memory.recordBombPlanted(this.liveRound);
      }
      if (bomb === "defused") {
        events.push({ type: "bombDefused", ourSide });
        this.bombPlantedAt = null;
      }
      if (bomb === "exploded") {
        events.push({ type: "bombExploded", ourSide });
        this.bombPlantedAt = null;
      }
    }

    // --- own-player deltas (only valid while the player block is the user, and
    // only during live play: warmup has respawn kills/deaths the coach must ignore) --
    if (mapPhase !== "live") {
      this.prevSelf = null;
      this.prevNades = null;
      this.prevGunClips = null;
      this.prevSpec = null;
      this.lastOwnKillAt = null;
    } else if (isSelf && payload.player?.state) {
      const s = payload.player.state;
      this.prevSpec = null; // alive and self again — spectate baseline is stale
      const cur: PrevSelf = {
        health: s.health,
        roundKills: s.round_kills,
        roundKillHs: s.round_killhs,
        matchKills: payload.player.match_stats?.kills ?? this.prevSelf?.matchKills ?? 0,
        mvps: payload.player.match_stats?.mvps ?? this.prevSelf?.mvps ?? 0,
        money: s.money,
        flashed: s.flashed,
        burning: s.burning,
        nadesCarried: this.allNadeCount(payload.player),
      };
      // Cached past death/spectate/gameover for the post-match record — the
      // gameover-frame player block usually describes a spectated teammate.
      const ms = payload.player.match_stats;
      if (ms) this.lastOwnStats = { kills: ms.kills, assists: ms.assists, deaths: ms.deaths, mvps: ms.mvps };

      // Grenade throws first: the inventory shrinks seconds before the kill lands,
      // so by the time round_kills ticks up the throw is already on record.
      // 'over' is included because exit frags still get classified (only
      // freezetime is excluded below), so throws and gunfire after the round is
      // decided must stay on the books — otherwise an exit frag's own shots go
      // untracked and a molly thrown before round end soaks up the credit.
      // Known limitation: dropping a grenade to a teammate (rare mid-live) also
      // shrinks the inventory and could mis-credit a knife kill to "the nade" —
      // GSI can't tell a drop from a throw, and the wrong call is harmless hype.
      // Alive only: the death frame EMPTIES the weapons list, and diffing it
      // would register every carried nade as a phantom "throw" — which the
      // death forensics below would then read as dying in your own molly.
      if ((roundPhase === "live" || roundPhase === "over") && s.health > 0) {
        const nades = this.nadeUnits(payload.player);
        if (this.prevNades) {
          for (const [name, units] of Object.entries(this.prevNades)) {
            if ((nades[name] ?? 0) < units) {
              this.lastNadeThrows[NADE_KINDS[name]] = now;
            }
          }
        }
        this.prevNades = nades;

        // Gunfire tracking: a clip going down means the player fired. CS2 swaps
        // back to the best weapon after a throw, so "holding a gun" when the nade
        // kill lands proves nothing — "hasn't fired since the throw" is the signal
        // that lets classifyKill credit the nade with a rifle back in hand.
        const clips = this.gunClips(payload.player);
        if (this.prevGunClips) {
          for (const [name, clip] of Object.entries(clips)) {
            const prevClip = this.prevGunClips[name];
            if (prevClip !== undefined && clip < prevClip) this.lastGunfireAt = now;
          }
        }
        this.prevGunClips = clips;
      }

      if (this.prevSelf) {
        if (cur.roundKills > this.prevSelf.roundKills && roundPhase !== "freezetime") {
          // A collateral or nade double can land inside one buffered frame —
          // count every increment, not every frame.
          const killsDelta = cur.roundKills - this.prevSelf.roundKills;
          this.lastOwnKillAt = now;
          // Distribute the headshot count across this frame's kills: the same frame
          // can carry several frags, but only round_killhs tells us how many were
          // heads — flag the first hsDelta of them so the headshot-rate habit is fed.
          const hsDelta = cur.roundKillHs - this.prevSelf.roundKillHs;
          for (let i = 0; i < killsDelta; i++) this.memory.recordKill(this.liveRound, i < hsDelta);
          if (cur.roundKills >= 5) this.memory.recordNotable(this.liveRound, "ACE");
          else if (cur.roundKills === 4) this.memory.recordNotable(this.liveRound, "4k");

          // Kill cash is only readable mid-round: round-end income (win/loss
          // bonus, observed +$3550) lands on the same 'over'-phase frame as an
          // exit frag and would fake a knife-sized reward.
          const cashDelta = roundPhase === "live" ? cur.money - this.prevSelf.money : undefined;
          const special = this.classifyKill(payload.player, s.health, now, killsDelta, cashDelta);
          if (special && special.kind !== "lowhp") {
            const label =
              special.kind === "grenade"
                ? special.nade === "fire"
                  ? "molotov kill"
                  : "HE grenade kill"
                : `${special.kind} kill`;
            this.memory.recordNotable(this.liveRound, label);
          }
          // One spoken story per kill: the weapon story REPLACES the generic
          // kill event below the triple, and multikill hype (triple and up)
          // outranks it — "TRIPLE KILL" speaks uncontested.
          if (special && cur.roundKills < 3) {
            events.push({ type: "specialKill", ...special, kills: killsDelta });
          } else {
            events.push({
              type: "kill",
              roundKills: cur.roundKills,
              headshot: cur.roundKillHs > this.prevSelf.roundKillHs,
            });
          }
        }

        // Scoreboard kills only go DOWN for teamkills (and suicides, which also
        // zero our health in the same breath — skip those). Live-phase only:
        // freezetime is damage-proof, and a freezetime payload still compares
        // against last round's baseline, which must never produce an event.
        if (cur.matchKills < this.prevSelf.matchKills && cur.health > 0 && roundPhase === "live") {
          events.push({ type: "teamkill" });
          this.memory.recordNotable(this.liveRound, "teamkilled a teammate");
        }

        if (cur.health === 0 && this.prevSelf.health > 0) {
          // Death forensics — factual notables; the LLM turns them into roasts.
          // The dying frame's state can already be partially wiped, so each
          // signal also reads the last alive frame's value.
          const flashed = Math.max(s.flashed, this.prevSelf.flashed);
          const burning = Math.max(s.burning, this.prevSelf.burning);
          const ownFire =
            this.lastNadeThrows.fire !== undefined && now - this.lastNadeThrows.fire <= OWN_MOLLY_BLAME_MS;
          // How they went, when the intensities prove it — burned to death in a
          // molotov, or dropped fully flashed (fire wins ties, it's the more
          // roastable end). The "fire" cause is ENEMY fire only: if the player's
          // OWN molly is the likely culprit, don't let the spoken line claim an
          // enemy cooked them — fall back to a generic death; the notable below
          // still records the own-molly death for the wrap-up.
          const cause =
            burning >= BURNING_DEATH_MIN && !ownFire ? "fire" : flashed >= FLASHED_BLIND_MIN ? "blind" : undefined;
          events.push({ type: "death", cause });
          this.memory.recordDeath(this.liveRound);
          if (flashed >= FLASHED_BLIND_MIN) {
            this.memory.recordNotable(this.liveRound, "died while flashed");
          }
          if (burning >= BURNING_DEATH_MIN) {
            // The own-molly variant states only what's knowable: the player's
            // own fire nade went out seconds before they burned down. GSI has
            // no damage attribution, so the string must not over-claim.
            this.memory.recordNotable(
              this.liveRound,
              ownFire ? "died burning seconds after throwing their own molly" : "died burning",
            );
          }
          if (this.prevSelf.nadesCarried >= 2) {
            this.memory.recordNotable(this.liveRound, `died with ${this.prevSelf.nadesCarried} unthrown grenades`);
          }
          if (roundPhase === "live" && this.roundLiveAt !== null && now - this.roundLiveAt <= EARLY_DEATH_WINDOW_MS) {
            this.memory.recordEarlyDeath(this.liveRound);
          }
        }
        if (cur.mvps > this.prevSelf.mvps) {
          events.push({ type: "mvp" });
        }
      }
      this.prevSelf = cur;
    } else if (!isSelf) {
      // Player block is a spectated teammate — freeze our own-state baseline so
      // teammate kills/health never register as the user's.
      if (this.prevSelf && roundPhase === "freezetime") this.prevSelf = null;
      this.prevNades = null;
      this.prevGunClips = null;

      // ...but the spectated teammate's kills are real information: cheer them on.
      const p = payload.player;
      // Bots carry fake short steamids (observed: "822") instead of a real
      // 17-digit Steam64 — spectating one proves this is a bot match. CS2
      // never backfills leavers with bots in competitive/Premier, so a single
      // sighting is conclusive, and "competitive with bots" reports the same
      // map.mode as the real thing — this flag is the only separator.
      if (this.inMatch && p?.steamid && !/^7656\d{13}$/.test(p.steamid)) {
        this.botsSeen = true;
      }
      if (roundPhase === "live" && p?.steamid && p.state) {
        if (this.prevSpec?.steamid === p.steamid) {
          const prevKills = this.prevSpec.roundKills;
          if (p.state.round_kills > prevKills) {
            events.push({
              type: "teammateKill",
              name: p.name,
              roundKills: p.state.round_kills,
              health: p.state.health,
              spectatedSteamid: p.steamid,
            });
            // Fire on CROSSING 3: a buffered frame jumping 2->4 skips an exact
            // ===3 hit, so gate on the baseline having been below 3.
            if (prevKills < 3 && p.state.round_kills >= 3 && p.name) {
              this.memory.recordNotable(this.liveRound, `${p.name} triple while you watched`);
            }
          }
          this.prevSpec.roundKills = p.state.round_kills;
        } else {
          // New spectate target: their current round_kills are the baseline,
          // only increments from here are kills we actually "saw".
          this.prevSpec = { steamid: p.steamid, roundKills: p.state.round_kills };
        }
      }
    }

    if (roundPhase === "freezetime" && prevRoundPhase !== "freezetime") {
      this.prevSelf = null; // round_kills resets each round
      this.prevNades = null;
      this.prevGunClips = null;
      this.lastNadeThrows = {};
      this.lastGunfireAt = null;
      this.lastOwnKillAt = null; // new round, new fights — last round's kill isn't "mid-fight"
      this.prevSpec = null;
    }

    this.prev = payload;
    return events;
  }

  /** Compact snapshot for rules + the LLM prompt. */
  context(): MatchContext {
    const p = this.prev;
    const now = Date.now();
    const isSelf = p ? this.isSelf(p) : false;
    // Side, scores and loss streak stay meaningful while dead via lastKnownSide.
    const ourSide = this.lastKnownSide;
    const { ourScore, theirScore } = p ? this.scores(p, ourSide) : { ourScore: undefined, theirScore: undefined };
    const team = ourSide === "CT" ? p?.map?.team_ct : ourSide === "T" ? p?.map?.team_t : undefined;
    const theirTeam = ourSide === "CT" ? p?.map?.team_t : ourSide === "T" ? p?.map?.team_ct : undefined;

    const roundWins = p?.map?.round_wins
      ? Object.entries(p.map.round_wins)
          .sort(([a], [b]) => Number(a) - Number(b))
          .slice(-5)
          .map(([, v]) => v)
      : undefined;

    // liveRound (set at freezetime) over raw map.round+1: during the "over"
    // phase map.round may already have incremented, and a roundEnd snapshot
    // claiming "round 13, pistol" while reacting to round 12 misleads the LLM.
    const roundNum = this.liveRound > 0 ? this.liveRound : (p?.map?.round ?? 0) + 1;
    const roundPhase = p?.round?.phase;
    const bomb = p?.round?.bomb;
    // Pistol rounds at 1/13 are an MR12 (competitive/Premier) fact; wingman etc. differ.
    const isPistol = p?.map?.mode === "competitive" && (roundNum === 1 || roundNum === 13);

    const roundTimeLeftSec =
      roundPhase === "live" && bomb !== "planted" && this.roundLiveAt !== null
        ? Math.max(0, Math.round(config.timings.roundSeconds - (now - this.roundLiveAt) / 1000))
        : undefined;
    const bombTimeLeftSec =
      bomb === "planted" && this.bombPlantedAt !== null
        ? Math.max(0, Math.round(config.timings.bombSeconds - (now - this.bombPlantedAt) / 1000))
        : undefined;

    const pistols = this.memory.pistolResults();

    // Own loadout — built only when the player block is the live user (alive),
    // so a spectated teammate's gun never reads as ours. Omitted otherwise.
    const loadout = isSelf && (p?.player?.state?.health ?? 0) > 0 ? this.buildLoadout(p?.player) : undefined;
    // Tilt spiral + own-data patterns — surfaced ONLY when they cross the
    // threshold (streak >= 2, habits non-empty) so a bare field IS the signal.
    const earlyDeathStreak = this.memory.earlyDeathStreak();
    const habits = this.memory.habits();

    // Match point from the live scores (the freezetime event only fires once per
    // stretch; mid-round consumers like the retake call need it every frame).
    const target = ourScore !== undefined && theirScore !== undefined ? winTarget(ourScore, theirScore) : undefined;
    const matchPoint =
      target === undefined ? undefined : ourScore === target - 1 ? "us" : theirScore === target - 1 ? "them" : undefined;
    // MR12: money resets at the half (after round 12), going into OT (after 24)
    // and between OT halves (every 3 rounds) — saving into a reset burns the gear.
    const moneyResetsNextRound =
      p?.map?.mode === "competitive" && (roundNum === 12 || roundNum === 24 || (roundNum > 24 && (roundNum - 24) % 3 === 0));

    return {
      map: p?.map?.name,
      mode: p?.map?.mode,
      round: roundNum,
      roundKind: isPistol ? "pistol" : undefined,
      roundPhase,
      bomb,
      roundTimeLeftSec,
      bombTimeLeftSec,
      ourSide,
      ourScore,
      theirScore,
      ourLossStreak: team?.consecutive_round_losses,
      theirLossStreak: theirTeam?.consecutive_round_losses,
      ourTimeoutsLeft: team?.timeouts_remaining,
      matchPoint,
      moneyResetsNextRound: moneyResetsNextRound || undefined,
      // Alive only: GSI keeps describing the dead self for the death-cam seconds
      // before auto-spectate switches — "mid-fight" must never describe a corpse.
      lastKillSecondsAgo:
        isSelf && (p?.player?.state?.health ?? 0) > 0 && this.lastOwnKillAt !== null
          ? Math.round((now - this.lastOwnKillAt) / 1000)
          : undefined,
      playerName: isSelf ? p?.player?.name : undefined,
      health: isSelf ? p?.player?.state?.health : undefined,
      armor: isSelf ? p?.player?.state?.armor : undefined,
      helmet: isSelf ? p?.player?.state?.helmet : undefined,
      money: isSelf ? p?.player?.state?.money : undefined,
      equipValue: isSelf ? p?.player?.state?.equip_value : undefined,
      defuseKit: isSelf ? p?.player?.state?.defusekit : undefined,
      hasBomb: isSelf && this.carriesBomb(p?.player) ? true : undefined,
      weapons: isSelf ? this.weaponNames(p?.player) : undefined,
      kills: isSelf ? p?.player?.match_stats?.kills : undefined,
      assists: isSelf ? p?.player?.match_stats?.assists : undefined,
      deaths: isSelf ? p?.player?.match_stats?.deaths : undefined,
      mvps: isSelf ? p?.player?.match_stats?.mvps : undefined,
      spectating:
        !isSelf && p?.player && p.map?.phase === "live"
          ? { name: p.player.name, health: p.player.state?.health, weapons: this.weaponNames(p.player) }
          : undefined,
      recentRoundWins: roundWins,
      history: this.memory.history(),
      pistolRounds: pistols.first || pistols.second ? pistols : undefined,
      streak: this.memory.streak(),
      notables: this.memory.notables(),
      earlyDeaths: this.memory.earlyDeaths() > 0 ? this.memory.earlyDeaths() : undefined,
      earlyDeathStreak: earlyDeathStreak >= 2 ? earlyDeathStreak : undefined,
      habits: habits.length > 0 ? habits : undefined,
      loadout,
      playerIsSelf: isSelf,
    };
  }

  /**
   * Unabridged per-round history for the storytelling moments (halftime, match
   * end, the wrap-up speech) — context() keeps the default 8-round window so
   * mid-round prompts stay lean.
   */
  fullHistory(): string[] {
    return this.memory.history(Number.MAX_SAFE_INTEGER);
  }

  /** Raw match-memory data for the spoken match wrap-up and the session store.
   *  Memoized per update(): immutable between payloads, but read often (per fresh
   *  member in buildTeam + per non-primary feed in deriveWeakLink), so the
   *  flatMap/spread allocations must not run on every heartbeat frame. */
  matchReport(): MatchReportData {
    if (this.reportCache) return this.reportCache;
    this.reportCache = {
      rounds: this.memory.allRounds(),
      pistols: this.memory.pistolResults(),
      earlyDeaths: this.memory.earlyDeaths(),
      notables: this.memory.notables(12),
      stats: this.lastOwnStats ?? undefined,
      botsDetected: this.botsSeen,
    };
    return this.reportCache;
  }

  /** SteamID64 of the local player (from the GSI provider block), once seen. */
  steamId(): string | undefined {
    return this.prev?.provider?.steamid;
  }

  /** This feed's own Steam name, persisted across death (the player block becomes
   *  a spectated teammate when dead, so the live name would otherwise vanish).
   *  Used by the multi-feed RosterManager to name a player even mid-spectate. */
  ownName(): string | undefined {
    return this.ownNameSeen;
  }

  /** Steam persona from the provider block — present in every payload including
   *  the main menu, before any in-game self frame has set ownName. A fallback name
   *  for the roster's "feeds connected" readout so a friend who just launched CS2
   *  (and is still in the menu) still sees their name in /coach status. */
  providerName(): string | undefined {
    return this.prev?.provider?.name;
  }

  /** This feed's side, surviving death via lastKnownSide (auto-spectate only ever
   *  targets teammates, so the spectated player's side is still ours). */
  ownSide(): Team | undefined {
    return this.lastKnownSide;
  }

  isInMatch(): boolean {
    return this.inMatch;
  }

  /** True when a delayed line (the Leetify recap) can speak without talking
   *  over play: no live match, GSI silent for 2+ minutes (game closed), or
   *  the latest payload is a menu frame (no map block — the player left or
   *  abandoned, which never delivers the gameover that clears inMatch). */
  quietMomentForSpeech(): boolean {
    const age = this.lastUpdateAgeMs();
    if (age === null || age > 120_000) return true;
    if (!this.prev?.map) return true;
    return !this.inMatch;
  }

  /** ms since the last GSI payload, or null before the first one — timer callbacks
   *  use this so clock callouts never speak into a crashed/closed game. */
  lastUpdateAgeMs(): number | null {
    return this.lastUpdateAt === null ? null : Date.now() - this.lastUpdateAt;
  }

  /** Raw epoch ms of the player's own latest kill this round (null if none).
   *  The engine compares this against the plant timestamp without the ±0.5s
   *  error the rounded context field would introduce. */
  lastOwnKillAtMs(): number | null {
    return this.lastOwnKillAt;
  }

  /** The player's own round_kills as of the latest payload (null while dead/
   *  spectating — the player block describes a teammate then). A queued
   *  "TRIPLE KILL" line checks this right before speaking: if the count moved
   *  on, the line is stale news and the fresher line is already behind it. */
  ownRoundKillsNow(): number | null {
    const p = this.prev;
    if (!p || !this.isSelf(p)) return null;
    return p.player?.state?.round_kills ?? null;
  }

  private isSelf(payload: GsiPayload): boolean {
    const provider = payload.provider?.steamid;
    const player = payload.player?.steamid;
    return !!provider && !!player && provider === player;
  }

  /**
   * Attribute a fresh kill from the active weapon + recent throws. Heuristics,
   * honest ones: after a throw CS2 auto-swaps back to the best weapon, so a nade
   * kill usually lands with a rifle already in hand — the giveaway is that no
   * shot was fired between the throw and the kill. The Zeus in hand is
   * unambiguous; a knife in hand while a nade window is open is resolved by the
   * same-frame kill cash (knife pays $1500, nade $300); otherwise knife-out
   * means knifed. Known limitation: spraying at one enemy while the nade kills
   * another forfeits the nade attribution — when gun and grenade are both
   * plausible, crediting the gun is the safe call.
   */
  private classifyKill(
    player: GsiPlayer,
    health: number,
    now: number,
    killsDelta: number,
    /** Same-frame money change, or undefined when cash is unreadable (round over). */
    cashDelta: number | undefined,
  ): { kind: "knife" | "zeus" | "grenade" | "lowhp"; nade?: "he" | "fire"; hp?: number } | null {
    const active = this.activeWeapon(player);

    if (active?.name === "weapon_taser") return { kind: "zeus" };

    // Which throws still have an open kill window.
    const heAt = this.lastNadeThrows.he;
    const fireAt = this.lastNadeThrows.fire;
    const openHe = heAt !== undefined && now - heAt <= NADE_KILL_WINDOW_MS.he;
    const openFire = fireAt !== undefined && now - fireAt <= NADE_KILL_WINDOW_MS.fire;
    let throwKind: "he" | "fire" | undefined;
    let throwAt = 0;
    if (openHe && openFire && killsDelta >= 2) {
      // A MULTI-kill with both a frag and a fire nade in flight is almost always
      // the molotov burning a clustered group — a single HE rarely doubles, fire
      // routinely does (a live session mis-called exactly this molly double as an
      // HE because the frag was thrown a beat later). Credit the fire.
      throwKind = "fire";
      throwAt = fireAt!;
    } else {
      // Otherwise the most recent open throw wins — a molly can still be burning
      // after a follow-up HE's window has already expired.
      if (openHe && heAt! > throwAt) {
        throwKind = "he";
        throwAt = heAt!;
      }
      if (openFire && fireAt! > throwAt) {
        throwKind = "fire";
        throwAt = fireAt!;
      }
    }

    // Did a gun actually fire right before this kill? A clip dropping within ~2s
    // means the GUN got the kill and the knife is just out for movement — that
    // recent gunfire is the SOLE suppressor of a knife verdict. Cash can only
    // CONFIRM a knife (+$1500/kill), never veto one: a real knife kill at the
    // $16k cap (or any frame GSI sends no money for) reads a ~$0 delta, and
    // letting a small delta force a gun verdict would lose genuine knife kills —
    // the same "when cash can't prove it, keep the visible-weapon call" logic the
    // nade branch above already uses.
    const cashSaysKnife = cashDelta !== undefined && cashDelta >= killsDelta * KNIFE_KILL_REWARD;
    const gunFiredJustNow = this.lastGunfireAt !== null && now - this.lastGunfireAt <= GUN_KILL_RECENT_MS;

    // Knife in hand while a nade still cooks is genuinely ambiguous — both are
    // plausible. Cash settles it: +$1500/kill proves the knife. When it can't
    // (truncated near the $16k cap, a same-frame buy, an unreadable over-phase
    // frame), the nade keeps the credit — the safer thing to be wrong about.
    if (throwKind && active?.type === "Knife") {
      if (cashSaysKnife) return { kind: "knife" };
      return { kind: "grenade", nade: throwKind };
    }

    const holdingNoGun = !active || active.type === "Grenade" || active.type === "C4";
    const firedSinceThrow = this.lastGunfireAt !== null && this.lastGunfireAt >= throwAt;
    if (throwKind && (holdingNoGun || !firedSinceThrow)) return { kind: "grenade", nade: throwKind };
    // A bare knife in hand is a knife kill UNLESS a gun fired in the last couple
    // seconds — then the gun got it and the knife is just out for movement (the
    // cause of a live false "knife kill" on a plain AK frag). A readable +$1500
    // cash still confirms it outright even if a stray shot was fired nearby.
    if (active?.type === "Knife" && (cashSaysKnife || !gunFiredJustNow)) return { kind: "knife" };
    if (health > 0 && health <= 20) return { kind: "lowhp", hp: health };
    return null;
  }

  private activeWeapon(player: GsiPlayer | undefined): GsiWeapon | undefined {
    if (!player?.weapons) return undefined;
    return Object.values(player.weapons).find((w) => w.state === "active" || w.state === "reloading");
  }

  /**
   * The player's own loadout for the LLM prompt: the primary gun (with ammo) plus
   * the grenades carried. Lets the coach make AWP-specific, dry-gun and
   * use-your-util calls. Prefers the active/reloading weapon when it's a real gun,
   * otherwise the best gun by type — a held knife or nade isn't the "primary".
   * Returns undefined when there are no weapons (warmup/spectate baseline).
   */
  private buildLoadout(player: GsiPlayer | undefined): MatchContext["loadout"] {
    if (!player?.weapons) return undefined;
    // Guns only — knife/nade/C4 are never the primary. Rank by type so the active
    // weapon is preferred only when it IS a gun (a quick-switched knife isn't).
    const GUN_TYPES = ["Rifle", "SniperRifle", "Machine Gun", "Shotgun", "SubMachineGun", "Pistol"];
    const guns = Object.values(player.weapons).filter((w) => w.type !== undefined && GUN_TYPES.includes(w.type));
    if (guns.length === 0) return undefined;
    const active = this.activeWeapon(player);
    const activeGun = active && active.type !== undefined && GUN_TYPES.includes(active.type) ? active : undefined;
    // Active/reloading gun first; otherwise the best by the GUN_TYPES priority order.
    const primary =
      activeGun ?? guns.slice().sort((a, b) => GUN_TYPES.indexOf(a.type!) - GUN_TYPES.indexOf(b.type!))[0];

    // One nade name per carried unit (CS2 stacks via the ammo fields), min 1 each.
    const nades: string[] = [];
    for (const w of Object.values(player.weapons)) {
      if (w.type !== "Grenade") continue;
      const units = Math.max(1, (w.ammo_clip ?? 0) + (w.ammo_reserve ?? 0));
      const name = w.name.replace(/^weapon_/, "");
      for (let i = 0; i < units; i++) nades.push(name);
    }

    return {
      primary: primary.name.replace(/^weapon_/, ""),
      primaryType: primary.type,
      clip: primary.ammo_clip,
      reserve: primary.ammo_reserve,
      nades: nades.length > 0 ? nades : undefined,
    };
  }

  /** Clip rounds for everything that shoots — knives, grenades and the C4 never "fire" this way. */
  private gunClips(player: GsiPlayer | undefined): Record<string, number> {
    const out: Record<string, number> = {};
    for (const w of Object.values(player?.weapons ?? {})) {
      if (w.type === "Knife" || w.type === "Grenade" || w.type === "C4" || NADE_KINDS[w.name]) continue;
      if (w.ammo_clip === undefined) continue;
      out[w.name] = w.ammo_clip;
    }
    return out;
  }

  /** Every grenade carried, all kinds — for the died-with-full-pockets forensic. */
  private allNadeCount(player: GsiPlayer | undefined): number {
    let n = 0;
    for (const w of Object.values(player?.weapons ?? {})) {
      if (w.type !== "Grenade") continue;
      n += Math.max(1, (w.ammo_clip ?? 0) + (w.ammo_reserve ?? 0));
    }
    return n;
  }

  /** The C4 ships as name "weapon_c4" (type "C4") in the carrier's weapon list. */
  private carriesBomb(player: GsiPlayer | undefined): boolean {
    return Object.values(player?.weapons ?? {}).some((w) => w.name === "weapon_c4");
  }

  /** Carried units of each kill-capable grenade (CS2 GSI counts stacks via ammo fields). */
  private nadeUnits(player: GsiPlayer | undefined): Record<string, number> {
    const out: Record<string, number> = {};
    for (const w of Object.values(player?.weapons ?? {})) {
      if (!NADE_KINDS[w.name]) continue;
      const units = (w.ammo_clip ?? 0) + (w.ammo_reserve ?? 0);
      out[w.name] = (out[w.name] ?? 0) + Math.max(1, units);
    }
    return out;
  }

  private scores(
    payload: GsiPayload,
    ourSide: Team | undefined,
  ): { ourScore?: number; theirScore?: number } {
    const ct = payload.map?.team_ct?.score;
    const t = payload.map?.team_t?.score;
    if (ourSide === "CT") return { ourScore: ct, theirScore: t };
    if (ourSide === "T") return { ourScore: t, theirScore: ct };
    return {};
  }

  private lastRoundMethod(payload: GsiPayload): string | undefined {
    const wins = payload.map?.round_wins;
    if (!wins) return undefined;
    const keys = Object.keys(wins).map(Number).filter(Number.isFinite);
    if (keys.length === 0) return undefined;
    return wins[String(Math.max(...keys))];
  }

  private weaponNames(player: GsiPlayer | undefined): string[] | undefined {
    if (!player?.weapons) return undefined;
    return Object.values(player.weapons)
      .filter((w) => w.type !== "Knife" && w.name !== "weapon_knife")
      .map((w) => w.name.replace(/^weapon_/, ""));
  }
}
