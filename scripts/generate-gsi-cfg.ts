/**
 * Generates cs2/gamestate_integration_coach.cfg from your .env (GSI_TOKEN, GSI_PORT)
 * and a host. Host precedence:
 *
 *   --host <ip-or-url>   explicit flag wins (run this when generating the cfg on a
 *                        machine other than the one running the coach)
 *   COACH_PUBLIC_HOST    your coach's public address from .env (the same value the
 *                        `/coach setup` Discord command uses — one source of truth)
 *   LAN IPv4             auto-detected, for same-PC dev only
 *
 *   npm run cfg                       -> COACH_PUBLIC_HOST, else this machine's LAN IP
 *   npm run cfg -- --host <ip>        -> http://<ip>:<GSI_PORT>
 *   npm run cfg -- --host <url>       -> a full http(s):// URL is used verbatim
 *
 * Copy the generated file to the GAMING PC at:
 *   <Steam>\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg\
 * then restart CS2 (the cfg is only read at launch).
 *
 * PLAYING WITH FRIENDS: each friend can just run `/coach setup` in Discord to get
 * this same file DMed to them — there's nothing per-friend to customize (every CS2
 * client tags its own SteamID64, so the coach demuxes the feeds automatically).
 * Set COACH_PRIMARY_STEAM64 in the coach's .env to YOUR SteamID64 so session memory
 * and the Leetify recap stay yours.
 */
import "dotenv/config";
import { networkInterfaces } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCfg, resolveUri } from "../src/gsi/cfg.js";

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
const port = process.env.GSI_PORT ?? "3000";
const token = process.env.GSI_TOKEN ?? "";

let host: string | null;
let source: string;
if (hostFlag !== -1) {
  host = args[hostFlag + 1];
  source = "--host flag";
} else if (process.env.COACH_PUBLIC_HOST) {
  host = process.env.COACH_PUBLIC_HOST;
  source = "COACH_PUBLIC_HOST";
} else {
  host = detectLanIp();
  source = "auto-detected LAN IP";
}

if (!host) {
  console.error(
    "No host to point CS2 at. Set COACH_PUBLIC_HOST in .env, or pass one: npm run cfg -- --host 192.168.1.50",
  );
  process.exit(1);
}

const uri = resolveUri(host, port);
const cfg = buildCfg({ host, port, token });

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "cs2", "gamestate_integration_coach.cfg");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, cfg, "utf8");

console.log(`Wrote ${outPath}`);
console.log(`Host source: ${source}`);
console.log(`GSI endpoint: ${uri}${token ? " (auth token included)" : " (no auth token — set GSI_TOKEN in .env!)"}`);
console.log("");
console.log("Next: copy the file to the gaming PC at");
console.log("  C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo\\cfg\\");
console.log("and restart CS2.");
console.log("");
console.log("Playing with friends? They can just run /coach setup in Discord to get this");
console.log("same file DMed to them — they drop it in the same cfg folder and restart CS2.");
console.log("The coach reads everyone at once (each client identifies itself by Steam ID).");
