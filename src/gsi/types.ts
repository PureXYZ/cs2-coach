// CS2 Game State Integration payload shapes — only the components the game sends
// while PLAYING (not spectating). Spectator-only components (allplayers_*, bomb,
// player_position, phase_countdowns, allgrenades) never arrive in Premier/Competitive
// play and are deliberately not modeled here.
//
// Field inventory cross-checked against CounterStrike2GSI (C#), LukeyR/CS2-GameStateIntegration
// (Go) and lupusbytes/cs2mqtt (.NET), June 2026.

export type Team = "T" | "CT";

export interface GsiProvider {
  name: string;
  appid: number;
  version: number;
  /** SteamID64 of the LOCAL player — the user. Never changes mid-match. */
  steamid: string;
  timestamp: number;
}

export interface GsiTeamState {
  score: number;
  consecutive_round_losses: number;
  timeouts_remaining: number;
  matches_won_this_series: number;
  name?: string;
  flag?: string;
}

export interface GsiMap {
  /** casual | competitive | scrimcomp2v2 | deathmatch | ... (Premier reports "competitive") */
  mode?: string;
  name?: string;
  /** timeout_ct / timeout_t appear while a team's tactical timeout runs. */
  phase?: "warmup" | "live" | "intermission" | "gameover" | "timeout_ct" | "timeout_t";
  /** Current round number (increments at round end). */
  round?: number;
  team_ct?: GsiTeamState;
  team_t?: GsiTeamState;
  num_matches_to_win_series?: number;
  /** Round history: { "1": "t_win_bomb", "2": "ct_win_elimination", ... } */
  round_wins?: Record<string, string>;
}

export interface GsiRound {
  phase?: "freezetime" | "live" | "over";
  /** Only present in bomb-defusal modes, only after relevant events. */
  bomb?: "planted" | "exploded" | "defused";
  win_team?: Team;
}

export interface GsiPlayerState {
  health: number;
  armor: number;
  helmet: boolean;
  flashed: number;
  smoked: number;
  burning: number;
  money: number;
  round_kills: number;
  round_killhs: number;
  // round_totaldmg is observer-only: requested in the cfg but never sent to a
  // playing client (confirmed across a full captured session) — not modeled.
  equip_value: number;
  defusekit?: boolean;
}

export interface GsiWeapon {
  name: string;
  paintkit?: string;
  type?: string;
  ammo_clip?: number;
  ammo_clip_max?: number;
  ammo_reserve?: number;
  state?: "active" | "holstered" | "reloading";
}

export interface GsiMatchStats {
  kills: number;
  assists: number;
  deaths: number;
  mvps: number;
  score: number;
}

export interface GsiPlayer {
  /**
   * CAUTION: when the local player dies and auto-spectates a teammate, this whole
   * block switches to the SPECTATED teammate. Always compare player.steamid against
   * provider.steamid before treating this as the user's own state.
   */
  steamid?: string;
  name?: string;
  clan?: string;
  observer_slot?: number;
  team?: Team;
  activity?: "playing" | "menu" | "textinput";
  state?: GsiPlayerState;
  weapons?: Record<string, GsiWeapon>;
  match_stats?: GsiMatchStats;
}

export interface GsiPayload {
  provider?: GsiProvider;
  map?: GsiMap;
  round?: GsiRound;
  player?: GsiPlayer;
  auth?: Record<string, string>;
  /** Delta block: prior values of fields that changed in this update. */
  previously?: unknown;
  /** Delta block: fields that newly appeared in this update. */
  added?: unknown;
}

// --- multi-feed team coaching ------------------------------------------------
// When several friends each run the coach's GSI cfg, every CS2 client POSTs its
// OWN-player feed to the same server. The RosterManager demuxes by
// provider.steamid and fuses the feeds; these shapes describe what it can
// honestly see — only the teammates actually running the coach, never the whole
// team unless the squad is fully wired (see TeamContext.rosterComplete).

/**
 * A teammate whose CS2 client is POSTing GSI to the coach ("wired"). Built
 * strictly from that feed's OWN-player block — never from spectated/observer
 * data — so the name is always safe to speak and the liveness is never guessed.
 */
export interface TeamMember {
  /** Steam name from the feed's own player block (persists across the player's death). */
  name?: string;
  /** True for the configured primary user (the one who owns session memory/Leetify). */
  isPrimary: boolean;
  /**
   * Own health > 0 on a FRESH self-frame (true), known dead (false), or unknown
   * because the feed is stale or currently spectating (undefined). Never guessed —
   * a stalled feed showing stale health is "unknown", not "alive".
   */
  alive?: boolean;
  /** Own money this feed last reported while alive (the buy-time read for drop calls). */
  money?: number;
  /**
   * Freshness tier of THIS feed's present-tense reads. "fresh" (staleMs <=
   * feedStaleMs/2) — money/alive are current enough to act on; "lagging" — still
   * connected (within feedStaleMs) but its money is a "last I saw" read, never the
   * basis for a live drop call. A confirmed death (alive===false) stays trustworthy
   * regardless — it doesn't un-happen with age.
   */
  tier: "fresh" | "lagging";
  /** ms since this feed's last payload — the freshness the honesty gates key on. */
  staleMs: number;
}

/**
 * What the coach can see of the squad: ONLY teammates running the coach. A
 * partial and possibly-stale view, never a whole-team truth unless rosterComplete
 * is set. Attached to the primary's MatchContext by the RosterManager when two or
 * more feeds are live; absent for a solo player (behaviour is then single-player).
 */
export interface TeamContext {
  /** Wired feeds currently fresh — drives every "of the players I can see" hedge. */
  wiredCount: number;
  /**
   * True ONLY when COACH_SQUAD_SIZE is set AND that many feeds are currently
   * fresh. The single thing that licenses whole-team assertions ("you're the last
   * one alive", "everyone's broke"). Defaults false → the coach always hedges.
   */
  rosterComplete: boolean;
  /** Configured squad size, when set — lets the prompt say "3 of 5". */
  squadSize?: number;
  /** One entry per wired feed; names are safe to speak (own-block only). */
  members: TeamMember[];
  /**
   * Wired feeds last seen alive THIS round on a fresh frame. ALWAYS surfaced to
   * the LLM as "of the players I can see", never as a whole-team count unless
   * rosterComplete.
   */
  aliveWired?: number;
  /** Which wired teammate is personally carrying the C4 right now (always safe). */
  bombCarrierName?: string;
  /**
   * Buy-money across wired feeds for the freezetime call — names + amounts plus
   * gear and alive, so the coach can tell a kitted $5k from a force-buy $5k and
   * never name a drop to a dead teammate. equipValue is present only for the
   * primary's own feed (the only feed whose own gear we read); alive mirrors the
   * member's. Present only when team tactics are enabled; covers only the wired subset.
   */
  econ?: { name?: string; money: number; isPrimary: boolean; equipValue?: number; alive?: boolean }[];
  /**
   * Cross-round buy-sync read for a coordinating squad — e.g. "Andy full-bought
   * while Mouse and Cadian saved". Present whenever 2+ wired buyers are visible at
   * freezetime — it speaks only about the wired crew (never the whole team), so it
   * needs no rosterComplete license. The freezetime/halftime line may fold it in.
   * No cooldown of its own.
   */
  buySyncNote?: string;
  /**
   * A one-line honesty verdict the LLM is told to FOLLOW LITERALLY: how much of
   * the squad is actually wired and therefore how freely whole-team facts may be
   * stated. Derived in buildTeam from wiredCount/rosterComplete/squadSize. REQUIRED
   * (always set when a team block exists; buildTeam returns undefined for a solo
   * player). The single string the SYSTEM_CORE honesty rule keys on.
   */
  visibility: string;
}
