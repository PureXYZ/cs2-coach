/**
 * Generates cs2/gamestate_integration_coach.cfg from your .env (GSI_PORT, GSI_TOKEN)
 * and this machine's LAN IP.
 *
 *   npm run cfg                  -> auto-detects this machine's LAN IPv4
 *   npm run cfg -- --host <ip>   -> use an explicit IP (run this when generating the
 *                                   cfg on a machine other than the one running the coach)
 *   npm run cfg -- --host <url>  -> a full http(s):// URL is used verbatim (hosted
 *                                   deployments, e.g. https://coach.ondigitalocean.app)
 *
 * Copy the generated file to the GAMING PC at:
 *   <Steam>\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg\
 * then restart CS2 (the cfg is only read at launch).
 *
 * PLAYING WITH FRIENDS: the coach reads multiple players at once. Every friend
 * uses the SAME generated cfg (same host, same token) — each CS2 client tags its
 * own SteamID64 in the payload, so the coach demuxes the feeds automatically.
 * There is nothing per-friend to customize: just share this one file, they drop
 * it in their csgo\cfg\ folder and restart CS2. (Set COACH_PRIMARY_STEAM64 in the
 * coach's .env to YOUR SteamID64 so session memory + the Leetify recap stay yours.)
 */
import "dotenv/config";
import { networkInterfaces } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function detectLanIp(): string | null {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

const args = process.argv.slice(2);
const hostFlag = args.indexOf("--host");
const host = hostFlag !== -1 ? args[hostFlag + 1] : detectLanIp();

if (!host) {
  console.error("Could not detect a LAN IP. Pass one explicitly: npm run cfg -- --host 192.168.1.50");
  process.exit(1);
}

const port = process.env.GSI_PORT ?? "3000";
const token = process.env.GSI_TOKEN ?? "";

// A full URL is taken verbatim — hosted platforms terminate TLS on 443, so no port
// belongs in the uri. A bare host/IP keeps the classic http://host:port form.
const uri = /^https?:\/\//i.test(host)
  ? host.replace(/\/+$/, "")
  : `http://${host}:${port}`;

// Valve KeyValues format — quoted strings, whitespace-separated, no commas/colons.
// Spectator-only components are subscribed too: they cost nothing while playing
// and make the same coach work if you ever run it on a spectating client.
const cfg = `"CS2 Coach"
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

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "cs2", "gamestate_integration_coach.cfg");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, cfg, "utf8");

console.log(`Wrote ${outPath}`);
console.log(`GSI endpoint: ${uri}${token ? " (auth token included)" : " (no auth token — set GSI_TOKEN in .env!)"}`);
console.log("");
console.log("Next: copy the file to the gaming PC at");
console.log("  C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo\\cfg\\");
console.log("and restart CS2.");
console.log("");
console.log("Playing with friends? Send them this exact same file — they drop it in the");
console.log("same cfg folder and restart CS2. The coach reads everyone at once (each client");
console.log("identifies itself by Steam ID). No per-friend setup.");
