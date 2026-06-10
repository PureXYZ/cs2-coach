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
  phase?: "warmup" | "live" | "intermission" | "gameover";
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
