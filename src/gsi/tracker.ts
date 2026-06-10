import type { GsiPayload, GsiPlayer, Team } from "./types.js";

// Events the rule engine and LLM coach react to. GSI gives players no kill feed,
// no positions and no clock — every event here is derivable from own-player state,
// round phase transitions and team scores only.
export type CoachEvent =
  | { type: "matchStart"; map: string; mode: string }
  | { type: "freezetime"; round: number }
  | { type: "roundLive"; round: number }
  | { type: "bombPlanted"; ourSide: Team | undefined }
  | { type: "bombDefused"; ourSide: Team | undefined }
  | { type: "bombExploded"; ourSide: Team | undefined }
  | { type: "roundEnd"; won: boolean | undefined; method: string; ourScore: number; theirScore: number }
  | { type: "halftime" }
  | { type: "matchPoint"; forUs: boolean }
  | { type: "matchEnd"; won: boolean | undefined; ourScore: number; theirScore: number }
  | { type: "kill"; roundKills: number; headshot: boolean }
  | { type: "death" }
  | { type: "mvp" };

/** Snapshot of everything we know, used by rules and serialized for the LLM. */
export interface MatchContext {
  map?: string;
  mode?: string;
  round?: number;
  roundPhase?: string;
  bomb?: string;
  ourSide?: Team;
  ourScore?: number;
  theirScore?: number;
  /** Consecutive losses for our team — drives loss-bonus economy advice. */
  ourLossStreak?: number;
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
  /** Last few rounds' outcomes, e.g. ["t_win_bomb", "ct_win_elimination"]. */
  recentRoundWins?: string[];
  /** True while the player-block describes the user (false = dead, spectating a teammate). */
  playerIsSelf: boolean;
}

interface PrevSelf {
  health: number;
  roundKills: number;
  roundKillHs: number;
  mvps: number;
}

/**
 * Rounds needed to win given the current scores: 13 in regulation (MR12), then
 * 16, 19, ... through MR3 overtime blocks (each tied block pushes the target +3).
 */
function winTarget(ourScore: number, theirScore: number): number {
  let target = 13;
  while (ourScore >= target || theirScore >= target || (ourScore === target - 1 && theirScore === target - 1)) {
    target += 3;
  }
  return target;
}

export class GsiTracker {
  private prev: GsiPayload | null = null;
  private prevSelf: PrevSelf | null = null;
  private inMatch = false;
  private announcedMatchPointAt: string | null = null;
  /**
   * The user's side survives death here: once dead, the player block describes a
   * spectated teammate, but competitive auto-spectate only targets teammates, so
   * player.team stays valid as a fallback when we have nothing better.
   */
  private lastKnownSide: Team | undefined;

  /** Feed one GSI payload; returns the events it implies, in priority order. */
  update(payload: GsiPayload): CoachEvent[] {
    const events: CoachEvent[] = [];
    const prev = this.prev;

    const map = payload.map;
    const round = payload.round;
    const isSelf = this.isSelf(payload);

    if (isSelf && payload.player?.team) {
      this.lastKnownSide = payload.player.team;
    } else if (!this.lastKnownSide && payload.player?.team) {
      this.lastKnownSide = payload.player.team; // started while dead: teammate's side = ours
    }
    const ourSide = this.lastKnownSide;

    // --- match lifecycle ---------------------------------------------------
    const prevMapPhase = prev?.map?.phase;
    const mapPhase = map?.phase;

    if (map && mapPhase === "live" && prevMapPhase !== "live" && prevMapPhase !== "intermission") {
      this.inMatch = true;
      this.announcedMatchPointAt = null;
      events.push({ type: "matchStart", map: map.name ?? "unknown", mode: map.mode ?? "unknown" });
    }

    if (mapPhase === "intermission" && prevMapPhase === "live") {
      events.push({ type: "halftime" });
    }

    if (mapPhase === "gameover" && prevMapPhase !== "gameover") {
      const { ourScore, theirScore } = this.scores(payload, ourSide);
      events.push({
        type: "matchEnd",
        won: ourScore !== undefined && theirScore !== undefined ? ourScore > theirScore : undefined,
        ourScore: ourScore ?? 0,
        theirScore: theirScore ?? 0,
      });
      this.inMatch = false;
      this.lastKnownSide = undefined;
    }

    // --- round phase transitions -------------------------------------------
    const prevRoundPhase = prev?.round?.phase;
    const roundPhase = round?.phase;
    const roundNum = (map?.round ?? 0) + 1; // map.round is the count of completed rounds

    if (roundPhase === "freezetime" && prevRoundPhase !== "freezetime") {
      events.push({ type: "freezetime", round: roundNum });

      // Match point check at buy time (MR12 regulation + MR3 overtime blocks).
      const { ourScore, theirScore } = this.scores(payload, ourSide);
      if (ourScore !== undefined && theirScore !== undefined) {
        const target = winTarget(ourScore, theirScore);
        const key = `${ourScore}-${theirScore}`;
        if (this.announcedMatchPointAt !== key) {
          if (ourScore === target - 1) {
            events.push({ type: "matchPoint", forUs: true });
            this.announcedMatchPointAt = key;
          } else if (theirScore === target - 1) {
            events.push({ type: "matchPoint", forUs: false });
            this.announcedMatchPointAt = key;
          }
        }
      }
    }

    if (roundPhase === "live" && prevRoundPhase === "freezetime") {
      events.push({ type: "roundLive", round: roundNum });
    }

    if (roundPhase === "over" && prevRoundPhase !== "over" && round?.win_team) {
      const { ourScore, theirScore } = this.scores(payload, ourSide);
      events.push({
        type: "roundEnd",
        won: ourSide ? round.win_team === ourSide : undefined,
        method: this.lastRoundMethod(payload) ?? "unknown",
        ourScore: ourScore ?? 0,
        theirScore: theirScore ?? 0,
      });
    }

    // --- bomb (note: plant signal is delayed ~1-2s by Valve, by design) -----
    const prevBomb = prev?.round?.bomb;
    const bomb = round?.bomb;
    if (bomb && bomb !== prevBomb) {
      if (bomb === "planted") events.push({ type: "bombPlanted", ourSide });
      if (bomb === "defused") events.push({ type: "bombDefused", ourSide });
      if (bomb === "exploded") events.push({ type: "bombExploded", ourSide });
    }

    // --- own-player deltas (only valid while the player block is the user, and
    // only during live play: warmup has respawn kills/deaths the coach must ignore) --
    if (mapPhase !== "live") {
      this.prevSelf = null;
    } else if (isSelf && payload.player?.state) {
      const s = payload.player.state;
      const cur: PrevSelf = {
        health: s.health,
        roundKills: s.round_kills,
        roundKillHs: s.round_killhs,
        mvps: payload.player.match_stats?.mvps ?? this.prevSelf?.mvps ?? 0,
      };

      if (this.prevSelf) {
        if (cur.roundKills > this.prevSelf.roundKills && roundPhase !== "freezetime") {
          events.push({
            type: "kill",
            roundKills: cur.roundKills,
            headshot: cur.roundKillHs > this.prevSelf.roundKillHs,
          });
        }
        if (cur.health === 0 && this.prevSelf.health > 0) {
          events.push({ type: "death" });
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
    }

    if (roundPhase === "freezetime" && prevRoundPhase !== "freezetime") {
      this.prevSelf = null; // round_kills resets each round
    }

    this.prev = payload;
    return events;
  }

  /** Compact snapshot for rules + the LLM prompt. */
  context(): MatchContext {
    const p = this.prev;
    const isSelf = p ? this.isSelf(p) : false;
    // Side, scores and loss streak stay meaningful while dead via lastKnownSide.
    const ourSide = this.lastKnownSide;
    const { ourScore, theirScore } = p ? this.scores(p, ourSide) : { ourScore: undefined, theirScore: undefined };
    const team = ourSide === "CT" ? p?.map?.team_ct : ourSide === "T" ? p?.map?.team_t : undefined;

    const roundWins = p?.map?.round_wins
      ? Object.entries(p.map.round_wins)
          .sort(([a], [b]) => Number(a) - Number(b))
          .slice(-5)
          .map(([, v]) => v)
      : undefined;

    return {
      map: p?.map?.name,
      mode: p?.map?.mode,
      round: (p?.map?.round ?? 0) + 1,
      roundPhase: p?.round?.phase,
      bomb: p?.round?.bomb,
      ourSide,
      ourScore,
      theirScore,
      ourLossStreak: team?.consecutive_round_losses,
      playerName: isSelf ? p?.player?.name : undefined,
      health: isSelf ? p?.player?.state?.health : undefined,
      armor: isSelf ? p?.player?.state?.armor : undefined,
      helmet: isSelf ? p?.player?.state?.helmet : undefined,
      money: isSelf ? p?.player?.state?.money : undefined,
      equipValue: isSelf ? p?.player?.state?.equip_value : undefined,
      defuseKit: isSelf ? p?.player?.state?.defusekit : undefined,
      weapons: isSelf ? this.weaponNames(p?.player) : undefined,
      kills: isSelf ? p?.player?.match_stats?.kills : undefined,
      assists: isSelf ? p?.player?.match_stats?.assists : undefined,
      deaths: isSelf ? p?.player?.match_stats?.deaths : undefined,
      mvps: isSelf ? p?.player?.match_stats?.mvps : undefined,
      recentRoundWins: roundWins,
      playerIsSelf: isSelf,
    };
  }

  isInMatch(): boolean {
    return this.inMatch;
  }

  private isSelf(payload: GsiPayload): boolean {
    const provider = payload.provider?.steamid;
    const player = payload.player?.steamid;
    return !!provider && !!player && provider === player;
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
