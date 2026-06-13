/**
 * Builds the contents of cs2/gamestate_integration_coach.cfg — the one file CS2
 * needs to send its Game State Integration feed to the coach.
 *
 * Pure and side-effect-free on purpose: both the CLI (scripts/generate-gsi-cfg.ts,
 * which writes it to disk) and the `/coach setup` Discord command (which hands it
 * to a friend in-memory) import this single source of truth, so the cfg a friend
 * installs is always byte-identical to the one you'd generate locally.
 */

export interface BuildCfgOptions {
  /**
   * Where CS2 should POST. A full http(s):// URL is used verbatim (hosted
   * deployments terminate TLS on 443, so no port belongs in an https uri); a bare
   * host or IP becomes http://<host>:<port>.
   */
  host: string;
  /** Port for the bare-host form (ignored when `host` is a full URL). */
  port?: string | number;
  /** Shared GSI auth token; the auth block is omitted entirely when empty. */
  token?: string;
}

/** Resolve the `uri` line value from a host (+port) the same way for the CLI and
 *  the bot. Exported so callers can show users exactly where the cfg points. */
export function resolveUri(host: string, port: string | number = 3000): string {
  return /^https?:\/\//i.test(host) ? host.replace(/\/+$/, "") : `http://${host}:${port}`;
}

export function buildCfg({ host, port = 3000, token = "" }: BuildCfgOptions): string {
  const uri = resolveUri(host, port);

  // Valve KeyValues format — quoted strings, whitespace-separated, no commas/colons.
  // Spectator-only components are subscribed too: they cost nothing while playing
  // and make the same coach work if you ever run it on a spectating client.
  return `"CS2 Coach"
{
  "uri"        "${uri}"
  "timeout"    "5.0"
  "buffer"     "0.1"
  "throttle"   "0.1"
  "heartbeat"  "10.0"
${token ? `  "auth"\n  {\n    "token"    "${token}"\n  }\n` : ""}  "data"
  {
    "provider"               "1"
    "map"                    "1"
    "map_round_wins"         "1"
    "round"                  "1"
    "player_id"              "1"
    "player_state"           "1"
    "player_weapons"         "1"
    "player_match_stats"     "1"
    "phase_countdowns"       "1"
    "player_position"        "1"
    "allplayers_id"          "1"
    "allplayers_state"       "1"
    "allplayers_match_stats" "1"
    "allplayers_weapons"     "1"
    "allplayers_position"    "1"
    "allgrenades"            "1"
    "bomb"                   "1"
  }
}
`;
}
