/**
 * Offline simulator: feeds synthetic GSI payload sequences through the real
 * GsiTracker + CoachEngine (LLM disabled → rule lines) and asserts the event
 * detection works — knife/zeus/nade kills, teamkills, spectated-teammate kills,
 * clock callouts, match memory. Run with:  npm run sim
 *
 * No network, no Discord, no Claude — pure logic verification. Spoken-line
 * assertions are used only where category cooldowns can't interfere; detection
 * assertions inspect the emitted events directly.
 */

// Must be set before config.ts loads; dotenv never overrides existing env vars.
process.env.DISCORD_TOKEN ||= "simulator";
process.env.ROUND_SECONDS = "2"; // shrink the clocks so timer callouts fire in ms
process.env.BOMB_SECONDS = "13";
process.env.FREEZETIME_SECONDS = "1";

const { GsiTracker } = await import("../src/gsi/tracker.js");
const { CoachEngine } = await import("../src/coach/engine.js");
const { config } = await import("../src/config.js");
const { retakeDecisionLine, economyLine, lateRoundLine } = await import("../src/coach/lines.js");
import os from "node:os";
import path from "node:path";
import type { CoachEvent, MatchContext } from "../src/gsi/tracker.js";
import type { GsiPayload, GsiWeapon } from "../src/gsi/types.js";
import type { SpeakRequest } from "../src/coach/engine.js";
import type { LlmCoach } from "../src/coach/llm.js";

const ME = "765611980000001";
const MATE = "765611980000002";

interface PlayerState {
  health?: number;
  money?: number;
  round_kills?: number;
  round_killhs?: number;
  equip_value?: number;
  armor?: number;
  flashed?: number;
  burning?: number;
}

function payload(opts: {
  mapPhase?: "warmup" | "live" | "intermission" | "gameover" | "timeout_ct" | "timeout_t";
  roundPhase?: "freezetime" | "live" | "over";
  round?: number;
  bomb?: "planted" | "exploded" | "defused";
  winTeam?: "T" | "CT";
  roundWins?: Record<string, string>;
  ctScore?: number;
  tScore?: number;
  ctLosses?: number;
  tLosses?: number;
  steamid?: string;
  team?: "T" | "CT";
  state?: PlayerState;
  kills?: number;
  mvps?: number;
  weapons?: Record<string, Partial<GsiWeapon>>;
}): GsiPayload {
  return {
    provider: { name: "cs2", appid: 730, version: 1, steamid: ME, timestamp: 0 },
    map: {
      mode: "competitive",
      name: "de_mirage",
      phase: opts.mapPhase ?? "live",
      round: opts.round ?? 0,
      team_ct: { score: opts.ctScore ?? 0, consecutive_round_losses: opts.ctLosses ?? 0, timeouts_remaining: 1, matches_won_this_series: 0 },
      team_t: { score: opts.tScore ?? 0, consecutive_round_losses: opts.tLosses ?? 0, timeouts_remaining: 1, matches_won_this_series: 0 },
      round_wins: opts.roundWins,
    },
    round: opts.roundPhase ? { phase: opts.roundPhase, bomb: opts.bomb, win_team: opts.winTeam } : undefined,
    player: {
      steamid: opts.steamid ?? ME,
      name: opts.steamid === MATE ? "BobTheFriend" : "Andy",
      team: opts.team ?? "CT",
      state: {
        health: 100,
        armor: 100,
        helmet: true,
        flashed: 0,
        smoked: 0,
        burning: 0,
        money: 4000,
        round_kills: 0,
        round_killhs: 0,
        equip_value: 4000,
        ...opts.state,
      },
      match_stats: { kills: opts.kills ?? 0, assists: 0, deaths: 0, mvps: opts.mvps ?? 0, score: 0 },
      weapons: Object.fromEntries(
        Object.entries(
          opts.weapons ?? { w0: { name: "weapon_ak47", type: "Rifle", state: "active" } },
        ).map(([k, w]) => [k, { name: "weapon_x", ...w } as GsiWeapon]),
      ),
    },
  };
}

const spoken: SpeakRequest[] = [];
const tracker = new GsiTracker();
const engine = new CoachEngine(
  (req) => {
    spoken.push(req);
    console.log(`  [say:${req.category}] ${req.text}`);
  },
  null,
  { getCtx: () => tracker.context() },
);

const seen: CoachEvent[] = [];
function feed(label: string, p: GsiPayload): void {
  const events = tracker.update(p);
  if (events.length > 0) {
    console.log(`${label}: ${events.map((e) => e.type).join(", ")}`);
    seen.push(...events);
    engine.handle(events, tracker.context());
  }
}

let failures = 0;
function expect(cond: boolean, what: string): void {
  if (cond) console.log(`  ✔ ${what}`);
  else {
    failures++;
    console.error(`  ✘ FAILED: ${what}`);
  }
}
const has = (type: CoachEvent["type"]) => seen.some((e) => e.type === type);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
console.log("\n=== scenario: match start, pistol round, knife kill ===");
feed("warmup", payload({ mapPhase: "warmup" }));
feed("r1 freeze", payload({ roundPhase: "freezetime", round: 0, state: { money: 800, equip_value: 200 } }));
expect(has("matchStart"), "matchStart detected");
expect(has("freezetime"), "freezetime detected");
expect(tracker.context().roundKind === "pistol", "round 1 flagged as pistol round");

feed("r1 live", payload({ roundPhase: "live", round: 0, state: { equip_value: 850 } }));
const knife = { w0: { name: "weapon_knife", type: "Knife", state: "active" } } as const;
feed("knife kill", payload({ roundPhase: "live", round: 0, weapons: knife, state: { round_kills: 1 }, kills: 1 }));
expect(
  seen.some((e) => e.type === "specialKill" && e.kind === "knife"),
  "knife kill detected as specialKill(knife)",
);
expect(spoken.some((s) => s.category === "specialKill"), "knife-kill hype line spoken");

// round_kills persists through the 'over' phase in real GSI (it resets at freezetime).
feed("r1 over", payload({ roundPhase: "over", round: 1, winTeam: "CT", ctScore: 1, state: { round_kills: 1 }, kills: 1, roundWins: { "1": "ct_win_elimination" } }));
expect(has("roundEnd"), "roundEnd detected");
// Exit frag in the ~7s after-round window: must merge into the closed R1 record,
// not open a phantom duplicate round.
feed("exit frag during over", payload({ roundPhase: "over", round: 1, winTeam: "CT", ctScore: 1, state: { round_kills: 2 }, kills: 2, roundWins: { "1": "ct_win_elimination" } }));

// ---------------------------------------------------------------------------
console.log("\n=== scenario: HE throw, auto-switch to knife, then the nade kills ===");
const knifeKillsBefore = seen.filter((e) => e.type === "specialKill" && e.kind === "knife").length;
feed("r2 freeze", payload({ roundPhase: "freezetime", round: 1, ctScore: 1 }));
const rifleHe = {
  w0: { name: "weapon_ak47", type: "Rifle", state: "holstered" },
  w1: { name: "weapon_hegrenade", type: "Grenade", state: "active", ammo_reserve: 1 },
} as const;
feed("r2 live, HE in hand", payload({ roundPhase: "live", round: 1, ctScore: 1, weapons: rifleHe, kills: 1 }));
const knifeNoHe = { w0: { name: "weapon_knife", type: "Knife", state: "active" } } as const;
feed("HE thrown (left inventory)", payload({ roundPhase: "live", round: 1, ctScore: 1, weapons: knifeNoHe, kills: 1 }));
feed("HE kill lands, knife out", payload({ roundPhase: "live", round: 1, ctScore: 1, weapons: knifeNoHe, state: { round_kills: 1 }, kills: 2 }));
expect(
  seen.some((e) => e.type === "specialKill" && e.kind === "grenade" && e.nade === "he"),
  "kill after HE throw attributed to the grenade, NOT a knife kill",
);
expect(
  seen.filter((e) => e.type === "specialKill" && e.kind === "knife").length === knifeKillsBefore,
  "no false knife-kill after the throw",
);

// ---------------------------------------------------------------------------
console.log("\n=== scenario: teamkill (scoreboard kills drop while alive) ===");
feed("teamkill", payload({ roundPhase: "live", round: 1, ctScore: 1, weapons: knifeNoHe, state: { round_kills: 1 }, kills: 1 }));
expect(has("teamkill"), "teamkill detected from kills decrement");

feed("r2 over", payload({ roundPhase: "over", round: 2, winTeam: "T", ctScore: 1, tScore: 1, roundWins: { "1": "ct_win_elimination", "2": "t_win_bomb" } }));

// ---------------------------------------------------------------------------
console.log("\n=== scenario: death → spectate teammate's triple kill ===");
feed("r3 freeze", payload({ roundPhase: "freezetime", round: 2, ctScore: 1, tScore: 1 }));
feed("r3 live", payload({ roundPhase: "live", round: 2, ctScore: 1, tScore: 1, kills: 1 }));
// Real GSI empties the weapons list on the death frame — model that.
feed("death", payload({ roundPhase: "live", round: 2, ctScore: 1, tScore: 1, state: { health: 0 }, kills: 1, weapons: {} }));
expect(has("death"), "own death detected");
feed("spectating mate (their 1k = baseline)", payload({ roundPhase: "live", round: 2, ctScore: 1, tScore: 1, steamid: MATE, state: { round_kills: 1 }, kills: 3 }));
feed("mate 2nd kill", payload({ roundPhase: "live", round: 2, ctScore: 1, tScore: 1, steamid: MATE, state: { round_kills: 2 }, kills: 3 }));
feed("mate triple", payload({ roundPhase: "live", round: 2, ctScore: 1, tScore: 1, steamid: MATE, state: { round_kills: 3 }, kills: 3 }));
expect(seen.filter((e) => e.type === "teammateKill").length === 2, "spectated teammate kills detected (2 increments; baseline ignored)");
expect(spoken.some((s) => s.text.includes("BobTheFriend")), "teammate praised by name on the triple");
expect(
  seen.filter((e) => e.type === "kill" || e.type === "specialKill").length === 3,
  "teammate kills never counted as the user's own",
);
feed("r3 over", payload({ roundPhase: "over", round: 3, winTeam: "T", ctScore: 1, tScore: 2, steamid: MATE, state: { round_kills: 3 }, kills: 3, roundWins: { "1": "ct_win_elimination", "2": "t_win_bomb", "3": "t_win_elimination" } }));

// ---------------------------------------------------------------------------
console.log("\n=== scenario: bomb plant on CT → retake call + ten-second callout ===");
feed("r4 freeze", payload({ roundPhase: "freezetime", round: 3, ctScore: 1, tScore: 2, kills: 1 }));
feed("r4 live", payload({ roundPhase: "live", round: 3, ctScore: 1, tScore: 2, kills: 1 }));
feed("bomb planted", payload({ roundPhase: "live", round: 3, bomb: "planted", ctScore: 1, tScore: 2, kills: 1 }));
expect(has("bombPlanted"), "bombPlanted detected");
expect(seen.filter((e) => e.type === "teamkill").length === 1, "exactly one teamkill across the whole match");
expect(spoken.some((s) => s.category === "retake"), "CT retake/save line spoken");
const ctxPlanted = tracker.context();
expect(typeof ctxPlanted.bombTimeLeftSec === "number" && ctxPlanted.bombTimeLeftSec <= 13, `bomb clock derived (${ctxPlanted.bombTimeLeftSec}s left)`);
await sleep((13 - 12) * 1000 + 400); // BOMB_SECONDS=13 → callout scheduled at 1s
expect(spoken.some((s) => s.category === "clock"), "ten-seconds-on-the-bomb callout fired");
feed("bomb exploded", payload({ roundPhase: "live", round: 3, bomb: "exploded", ctScore: 1, tScore: 2, kills: 1 }));
feed("r4 over", payload({ roundPhase: "over", round: 4, winTeam: "T", ctScore: 1, tScore: 3, kills: 1, roundWins: { "1": "ct_win_elimination", "2": "t_win_bomb", "3": "t_win_elimination", "4": "t_win_bomb" } }));

// ---------------------------------------------------------------------------
console.log("\n=== scenario: match memory accumulated the story ===");
const ctx = tracker.context();
console.log("  history:", JSON.stringify(ctx.history));
console.log("  notables:", JSON.stringify(ctx.notables));
expect((ctx.history?.length ?? 0) === 4, `4 rounds in history (got ${ctx.history?.length})`);
expect(ctx.history?.[0]?.includes("R1") === true, "history starts at round 1");
expect(ctx.history?.filter((h) => h.includes("R1 ")).length === 1, "exit frag did NOT create a phantom duplicate R1 record");
expect(ctx.history?.[0]?.includes("2k") === true, "exit frag merged into the closed R1 record");
expect(ctx.notables?.some((n) => n.includes("knife")) === true, "knife kill remembered as notable");
expect(ctx.notables?.some((n) => n.includes("teamkill")) === true, "teamkill remembered as notable");
expect(ctx.pistolRounds?.first === "won", "pistol round result remembered");
expect(ctx.streak !== undefined && ctx.streak.includes("lost"), `loss streak derived ("${ctx.streak}")`);

// ---------------------------------------------------------------------------
console.log("\n=== scenario: HE thrown, rifle back in hand, no shots — still the nade's kill ===");
const rifleAndHe = {
  w0: { name: "weapon_ak47", type: "Rifle", state: "holstered", ammo_clip: 30, ammo_reserve: 90 },
  w1: { name: "weapon_hegrenade", type: "Grenade", state: "active", ammo_reserve: 1 },
} as const;
const rifleActive = { w0: { name: "weapon_ak47", type: "Rifle", state: "active", ammo_clip: 30, ammo_reserve: 90 } } as const;
feed("r5 freeze", payload({ roundPhase: "freezetime", round: 4, ctScore: 1, tScore: 3, kills: 1 }));
feed("r5 live, HE in hand", payload({ roundPhase: "live", round: 4, ctScore: 1, tScore: 3, weapons: rifleAndHe, kills: 1 }));
feed("HE thrown, auto-swap to rifle", payload({ roundPhase: "live", round: 4, ctScore: 1, tScore: 3, weapons: rifleActive, kills: 1 }));
feed("HE kill lands, rifle out, clip untouched", payload({ roundPhase: "live", round: 4, ctScore: 1, tScore: 3, weapons: rifleActive, state: { round_kills: 1 }, kills: 2 }));
expect(
  seen.filter((e) => e.type === "specialKill" && e.kind === "grenade" && e.nade === "he").length === 2,
  "HE kill with the rifle back in hand (unfired) attributed to the grenade",
);
feed("r5 over", payload({ roundPhase: "over", round: 5, winTeam: "CT", ctScore: 2, tScore: 3, kills: 2, roundWins: { "1": "ct_win_elimination", "2": "t_win_bomb", "3": "t_win_elimination", "4": "t_win_bomb", "5": "ct_win_elimination" } }));

// ---------------------------------------------------------------------------
console.log("\n=== scenario: molly burning — kill before firing is the molly's, kill after firing is the rifle's ===");
const rifleAndMolly = {
  w0: { name: "weapon_ak47", type: "Rifle", state: "holstered", ammo_clip: 30, ammo_reserve: 90 },
  w1: { name: "weapon_molotov", type: "Grenade", state: "active", ammo_reserve: 1 },
} as const;
const rifleFired = { w0: { name: "weapon_ak47", type: "Rifle", state: "active", ammo_clip: 26, ammo_reserve: 90 } } as const;
const genericKillsBefore = seen.filter((e) => e.type === "kill").length;
feed("r6 freeze", payload({ roundPhase: "freezetime", round: 5, ctScore: 2, tScore: 3, kills: 2 }));
feed("r6 live, molly in hand", payload({ roundPhase: "live", round: 5, ctScore: 2, tScore: 3, weapons: rifleAndMolly, kills: 2 }));
feed("molly thrown, rifle out", payload({ roundPhase: "live", round: 5, ctScore: 2, tScore: 3, weapons: rifleActive, kills: 2 }));
feed("molly kill, no shots fired", payload({ roundPhase: "live", round: 5, ctScore: 2, tScore: 3, weapons: rifleActive, state: { round_kills: 1 }, kills: 3 }));
expect(
  seen.filter((e) => e.type === "specialKill" && e.kind === "grenade" && e.nade === "fire").length === 1,
  "molly kill with the rifle in hand (unfired) attributed to the fire",
);
feed("rifle sprays", payload({ roundPhase: "live", round: 5, ctScore: 2, tScore: 3, weapons: rifleFired, state: { round_kills: 1 }, kills: 3 }));
feed("kill after firing", payload({ roundPhase: "live", round: 5, ctScore: 2, tScore: 3, weapons: rifleFired, state: { round_kills: 2 }, kills: 4 }));
expect(
  seen.filter((e) => e.type === "specialKill" && e.kind === "grenade").length === 3,
  "kill after gunfire NOT credited to the still-burning molly",
);
expect(
  seen.filter((e) => e.type === "kill").length === genericKillsBefore + 1,
  "kill after gunfire emitted as a regular kill",
);
feed("r6 over", payload({ roundPhase: "over", round: 6, winTeam: "T", ctScore: 2, tScore: 4, kills: 4, roundWins: { "1": "ct_win_elimination", "2": "t_win_bomb", "3": "t_win_elimination", "4": "t_win_bomb", "5": "ct_win_elimination", "6": "t_win_elimination" } }));

// ---------------------------------------------------------------------------
console.log("\n=== scenario: knife kill while a molly still burns — the $1500 reward proves the knife ===");
// Reproduces the live session of 2026-06-10 (logs/gsi-...22-01-22.ndjson line 62):
// incendiary thrown, knife pulled, kill lands +$1500 — was misreported as a molotov kill.
const knifeKillsBeforeMolly = seen.filter((e) => e.type === "specialKill" && e.kind === "knife").length;
const mollyInHand = {
  w0: { name: "weapon_knife", type: "Knife", state: "holstered" },
  w1: { name: "weapon_molotov", type: "Grenade", state: "active", ammo_reserve: 1 },
} as const;
const knifeOut = { w0: { name: "weapon_knife", type: "Knife", state: "active" } } as const;
feed("r7 freeze", payload({ roundPhase: "freezetime", round: 6, ctScore: 2, tScore: 4, kills: 4 }));
feed("r7 live, molly in hand", payload({ roundPhase: "live", round: 6, ctScore: 2, tScore: 4, weapons: mollyInHand, kills: 4, state: { money: 1000 } }));
feed("molly thrown, knife out", payload({ roundPhase: "live", round: 6, ctScore: 2, tScore: 4, weapons: knifeOut, kills: 4, state: { money: 1000 } }));
feed("knife kill (+$1500), molly burning", payload({ roundPhase: "live", round: 6, ctScore: 2, tScore: 4, weapons: knifeOut, state: { round_kills: 1, money: 2500 }, kills: 5 }));
expect(
  seen.filter((e) => e.type === "specialKill" && e.kind === "knife").length === knifeKillsBeforeMolly + 1,
  "knife kill during an open molly window attributed to the knife via the $1500 reward",
);
feed("molly kill (+$300), knife still out", payload({ roundPhase: "live", round: 6, ctScore: 2, tScore: 4, weapons: knifeOut, state: { round_kills: 2, money: 2800 }, kills: 6 }));
expect(
  seen.filter((e) => e.type === "specialKill" && e.kind === "grenade" && e.nade === "fire").length === 2,
  "kill paying only $300 with the knife out still credited to the burning molly",
);
// Third kill seconds after the first two: the triple line must bypass the 6s
// kill cooldown (a live session lost its whole ace escalation to it).
feed("triple, seconds later", payload({ roundPhase: "live", round: 6, ctScore: 2, tScore: 4, weapons: knifeOut, state: { round_kills: 3, money: 3100 }, kills: 7 }));
expect(
  spoken.some((s) => s.category === "kill" && /riple|hree/.test(s.text)),
  "triple-kill line spoken despite the kill-category cooldown",
);
feed("r7 over", payload({ roundPhase: "over", round: 7, winTeam: "CT", ctScore: 3, tScore: 4, kills: 7, roundWins: { "1": "ct_win_elimination", "2": "t_win_bomb", "3": "t_win_elimination", "4": "t_win_bomb", "5": "ct_win_elimination", "6": "t_win_elimination", "7": "ct_win_elimination" } }));

// ---------------------------------------------------------------------------
console.log("\n=== scenario: cold start mid-post-plant must not announce a fresh plant ===");
const coldTracker = new GsiTracker();
const coldEvents = coldTracker.update(payload({ roundPhase: "live", round: 7, bomb: "planted", ctScore: 4, tScore: 3 }));
expect(!coldEvents.some((e) => e.type === "bombPlanted"), "first-ever payload with bomb=planted is a baseline sync, not an event");
const coldCtx = coldTracker.context();
expect(coldCtx.round === 8, `mid-round join adopts the live round number (got ${coldCtx.round})`);

// ---------------------------------------------------------------------------
console.log("\n=== scenario: noise control — singles/doubles silent, same-batch chatter consolidated ===");
// Fresh engines per check: synthetic event batches straight into handle(), so
// category cooldowns from the long run above can't mask the behavior under test.
function freshEngine(): { out: SpeakRequest[]; engine: InstanceType<typeof CoachEngine> } {
  const out: SpeakRequest[] = [];
  const engine2 = new CoachEngine((req) => out.push(req), null, { getCtx: () => tracker.context() });
  return { out, engine: engine2 };
}
{
  const { out, engine: e } = freshEngine();
  e.handle([{ type: "kill", roundKills: 1, headshot: true }], tracker.context());
  e.handle([{ type: "kill", roundKills: 2, headshot: false }], tracker.context());
  expect(out.length === 0, "single and double kills stay silent");
  e.handle([{ type: "kill", roundKills: 3, headshot: false }], tracker.context());
  expect(out.some((s) => s.category === "kill"), "triple kill still speaks");
}
{
  const { out, engine: e } = freshEngine();
  e.handle(
    [
      { type: "roundEnd", won: true, method: "ct_win_defuse", ourScore: 5, theirScore: 3 },
      { type: "bombDefused", ourSide: "CT" },
      { type: "mvp" },
    ],
    tracker.context(),
  );
  const roundEndLines = out.filter((s) => s.category === "roundEnd");
  expect(roundEndLines.length === 1, "exactly one consolidated line for the defuse round");
  expect(!out.some((s) => s.category === "bomb" || s.category === "mvp"), "no separate defuse/MVP chatter in the same batch");
  // The suppression promised the round-end line tells the whole story — and the
  // canned fallback (LLM is null here) must keep that promise, not just the LLM.
  const text = roundEndLines[0]?.text ?? "";
  expect(/defus|wire|stuck|stole|ninja|bomb's dead|retake guide/i.test(text), `fallback line tells the defuse story ("${text.slice(0, 60)}...")`);
  expect(text.includes("5") && text.includes("3"), "fallback line still carries the score");
  expect(/MVP/i.test(text), "fallback line still mentions the MVP");
}
{
  const { out, engine: e } = freshEngine();
  e.handle(
    [
      { type: "matchEnd", won: true, ourScore: 13, theirScore: 10 },
      { type: "freezetime", round: 24 },
      { type: "bombDefused", ourSide: "CT" },
    ],
    tracker.context(),
  );
  expect(out.some((s) => s.category === "match"), "match-end line spoken");
  expect(!out.some((s) => s.category === "economy" || s.category === "bomb"), "no buy advice or bomb chatter after the match ended");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: bomb planted right after the player's own kill — back the clutch, never call save ===");
const spokenF: SpeakRequest[] = [];
const trackerF = new GsiTracker();
const engineF = new CoachEngine(
  (req) => {
    spokenF.push(req);
    console.log(`  [say:${req.category}] ${req.text}`);
  },
  null,
  { getCtx: () => trackerF.context() },
);
function feedF(label: string, p: GsiPayload): void {
  const events = trackerF.update(p);
  if (events.length > 0) {
    console.log(`${label}: ${events.map((e) => e.type).join(", ")}`);
    engineF.handle(events, trackerF.context());
  }
}
feedF("warmup", payload({ mapPhase: "warmup" }));
feedF("r1 freeze", payload({ roundPhase: "freezetime", round: 0 }));
feedF("r1 live", payload({ roundPhase: "live", round: 0 }));
feedF("kill mid-clutch", payload({ roundPhase: "live", round: 0, state: { round_kills: 1 }, kills: 1 }));
feedF("plant lands seconds later", payload({ roundPhase: "live", round: 0, bomb: "planted", state: { round_kills: 1 }, kills: 1 }));
const fightLine = spokenF.find((s) => s.category === "retake");
expect(fightLine !== undefined, "retake-category line still spoken");
expect(fightLine !== undefined && !/save/i.test(fightLine.text), "no save talk while the player is mid-fight");
expect(fightLine !== undefined && /keep going|next|stay on it|finish/i.test(fightLine.text), "the line backs the ongoing fight");
expect(typeof trackerF.context().lastKillSecondsAgo === "number", "lastKillSecondsAgo exposed in context");

// ---------------------------------------------------------------------------
console.log("\n=== scenario: LLM retake line in flight — dropped when a kill lands after the plant ===");
// Mock LLM with a manually-resolved promise: the only offline way to exercise
// tacticalMoment's stillRelevant() (the canned-fallback path never runs it).
function llmEngine(t: InstanceType<typeof GsiTracker>, out: SpeakRequest[]): { engine: InstanceType<typeof CoachEngine>; resolve: (s: string | null) => void } {
  let resolve: (s: string | null) => void = () => {};
  const fakeLlm = {
    line: () => new Promise<string | null>((r) => { resolve = r; }),
    recordSpoken: () => {},
  } as unknown as LlmCoach;
  const e = new CoachEngine((req) => out.push(req), fakeLlm, {
    getCtx: () => t.context(),
    payloadAgeMs: () => 0,
    lastOwnKillAt: () => t.lastOwnKillAtMs(),
  });
  return { engine: e, resolve: (s) => resolve(s) };
}
{
  const out: SpeakRequest[] = [];
  const t = new GsiTracker();
  const { engine: e, resolve } = llmEngine(t, out);
  const run = (p: GsiPayload) => { const ev = t.update(p); if (ev.length) e.handle(ev, t.context()); };
  run(payload({ mapPhase: "warmup" }));
  run(payload({ roundPhase: "freezetime", round: 0 }));
  run(payload({ roundPhase: "live", round: 0 }));
  run(payload({ roundPhase: "live", round: 0, bomb: "planted" })); // CT plant → LLM call in flight
  run(payload({ roundPhase: "live", round: 0, bomb: "planted", state: { round_kills: 1 }, kills: 1 })); // kill lands mid-flight
  resolve("Mock retake-or-save lecture.");
  await sleep(20);
  expect(!out.some((s) => s.category === "retake"), "in-flight retake line dropped after the player's mid-flight kill");
}
{
  const out: SpeakRequest[] = [];
  const t = new GsiTracker();
  const { engine: e, resolve } = llmEngine(t, out);
  const run = (p: GsiPayload) => { const ev = t.update(p); if (ev.length) e.handle(ev, t.context()); };
  run(payload({ mapPhase: "warmup" }));
  run(payload({ roundPhase: "freezetime", round: 0 }));
  run(payload({ roundPhase: "live", round: 0 }));
  run(payload({ roundPhase: "live", round: 0, bomb: "planted" }));
  resolve("Mock retake-or-save lecture.");
  await sleep(20);
  const retakeLine = out.find((s) => s.category === "retake" && s.text.includes("Mock"));
  expect(retakeLine !== undefined, "LLM retake line still speaks when no kill interrupts it");
  // The relevance check must ride into the voice queue too: the line can die
  // while queued behind other audio (defuse, round end), not just mid-LLM.
  expect(typeof retakeLine?.stillRelevant === "function", "retake line carries stillRelevant into the queue");
  expect(retakeLine?.stillRelevant?.() === true, "queued retake line still relevant while the bomb is live");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: match point + money-reset rounds known to the context ===");
const trackerMp = new GsiTracker();
trackerMp.update(payload({ roundPhase: "freezetime", round: 11, ctScore: 12, tScore: 5 }));
const ctxMp = trackerMp.context();
expect(ctxMp.matchPoint === "us", `match point derived from live scores (got ${ctxMp.matchPoint})`);
expect(ctxMp.moneyResetsNextRound === true, "round 12 flagged as last round before the halftime money reset");
const mustWinLine = retakeDecisionLine({
  playerIsSelf: true,
  health: 100,
  armor: 0,
  equipValue: 800,
  matchPoint: "them",
});
expect(
  /retake|all five|all in|site|win|send/i.test(mustWinLine) && !/sav(e|ing) (it|for|your)/i.test(mustWinLine),
  `thin gear on match point still gets a must-win retake call, not a save ("${mustWinLine}")`,
);

// ---------------------------------------------------------------------------
console.log("\n=== scenario: triple-kill line goes stale once the fourth kill lands ===");
{
  const out: SpeakRequest[] = [];
  const t = new GsiTracker();
  const e = new CoachEngine((req) => out.push(req), null, {
    getCtx: () => t.context(),
    payloadAgeMs: () => 0,
    lastOwnKillAt: () => t.lastOwnKillAtMs(),
    ownRoundKills: () => t.ownRoundKillsNow(),
  });
  const run = (p: GsiPayload) => { const ev = t.update(p); if (ev.length) e.handle(ev, t.context()); };
  run(payload({ mapPhase: "warmup" }));
  run(payload({ roundPhase: "freezetime", round: 0 }));
  run(payload({ roundPhase: "live", round: 0 }));
  run(payload({ roundPhase: "live", round: 0, state: { round_kills: 3 }, kills: 3 }));
  const tripleLine = out.find((s) => s.category === "kill");
  expect(tripleLine !== undefined, "triple line queued");
  expect(tripleLine?.supersedes?.includes("kill") === true, "kill line supersedes older queued kill hype");
  expect(tripleLine?.stillRelevant?.() === true, "triple line relevant while the count is still 3");
  run(payload({ roundPhase: "live", round: 0, state: { round_kills: 4 }, kills: 4 }));
  expect(tripleLine?.stillRelevant?.() === false, "triple line overtaken once the fourth kill lands");
  const quadLine = out.filter((s) => s.category === "kill")[1];
  expect(quadLine !== undefined && quadLine.stillRelevant?.() === true, "quad line is the relevant one now");
  expect(quadLine?.supersedes?.includes("specialKill") === true, "kill lines also supersede queued special-kill stories");
  // Player gets traded right after the 4th kill: "go get the ace" hype must
  // not be spoken to a corpse — the quad line dies with the player.
  run(payload({ roundPhase: "live", round: 0, state: { round_kills: 4, health: 0 }, kills: 4 }));
  expect(quadLine?.stillRelevant?.() === false, "forward-looking quad hype dropped once the player is dead");
}
{
  // The ace is backward-looking: it celebrates a finished highlight, so it
  // still speaks even when the player got traded on the closing kill.
  const out: SpeakRequest[] = [];
  const t = new GsiTracker();
  const e = new CoachEngine((req) => out.push(req), null, {
    getCtx: () => t.context(),
    payloadAgeMs: () => 0,
    lastOwnKillAt: () => t.lastOwnKillAtMs(),
    ownRoundKills: () => t.ownRoundKillsNow(),
  });
  const run = (p: GsiPayload) => { const ev = t.update(p); if (ev.length) e.handle(ev, t.context()); };
  run(payload({ mapPhase: "warmup" }));
  run(payload({ roundPhase: "freezetime", round: 0 }));
  run(payload({ roundPhase: "live", round: 0 }));
  run(payload({ roundPhase: "live", round: 0, state: { round_kills: 5 }, kills: 5 }));
  const aceLine = out.find((s) => s.category === "kill");
  run(payload({ roundPhase: "live", round: 0, state: { round_kills: 5, health: 0 }, kills: 5 }));
  expect(aceLine !== undefined && aceLine.stillRelevant?.() === true, "ace line survives the player dying right after");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: mid-OT side swap and non-MR12 modes get the right round-end framing ===");
{
  // Round 27 ends 14-13: OT is already running and the score is NOT tied —
  // "tied, overtime now" lines would be flatly wrong; money still resets.
  const { out, engine: e } = freshEngine();
  e.handle(
    [{ type: "roundEnd", won: true, method: "ct_win_elimination", ourScore: 14, theirScore: 13 }],
    { round: 27, mode: "competitive", moneyResetsNextRound: true, ourSide: "CT", playerIsSelf: true },
  );
  const line = out.find((s) => s.category === "roundEnd");
  expect(line !== undefined && /ten (grand|K)|swap|overtime|OT/i.test(line.text), `mid-OT swap line mentions the reset ("${line?.text.slice(0, 70)}")`);
  expect(line !== undefined && !/tied/i.test(line.text), "mid-OT swap line never claims a tied score");
}
{
  // Wingman (MR8) reaching round 12: that's mid-second-half there, not halftime.
  const { out, engine: e } = freshEngine();
  e.handle(
    [{ type: "roundEnd", won: true, method: "ct_win_elimination", ourScore: 6, theirScore: 5 }],
    { round: 12, mode: "scrimcomp2v2", ourSide: "CT", playerIsSelf: true },
  );
  const line = out.find((s) => s.category === "roundEnd");
  expect(line !== undefined && !/half|pistol|swap|overtime/i.test(line.text), `wingman round 12 gets a normal round react ("${line?.text.slice(0, 70)}")`);
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: last round of the half / regulation — no next-round talk ===");
{
  const { out, engine: e } = freshEngine();
  e.handle(
    [{ type: "roundEnd", won: true, method: "ct_win_elimination", ourScore: 7, theirScore: 5 }],
    { round: 12, moneyResetsNextRound: true, ourSide: "CT", playerIsSelf: true },
  );
  const line = out.find((s) => s.category === "roundEnd");
  expect(line !== undefined, "round-12 end line spoken");
  expect(line !== undefined && /half|swap|reset|pistol|break/i.test(line.text), `line talks halftime, not next-round buys ("${line?.text.slice(0, 70)}")`);
  expect(line !== undefined && !/keep the guns|keep your guns|buy right/i.test(line.text), "no gun-carryover talk into the halftime wipe");
}
{
  const { out, engine: e } = freshEngine();
  e.handle(
    [{ type: "roundEnd", won: false, method: "t_win_bomb", ourScore: 12, theirScore: 12 }],
    { round: 24, moneyResetsNextRound: true, ourSide: "CT", playerIsSelf: true },
  );
  const line = out.find((s) => s.category === "roundEnd");
  expect(
    line !== undefined && /(overtime|\bOT\b|ten (grand|K|thousand))/i.test(line.text),
    `12-12 after round 24 mentions overtime ("${line?.text.slice(0, 70)}")`,
  );
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: freezetime economy knows resets, match point and pistols ===");
{
  const resetEco = economyLine({ playerIsSelf: true, money: 1200, ourLossStreak: 3, moneyResetsNextRound: true });
  expect(resetEco !== null && /spend|force|empty|buy/i.test(resetEco), `reset-round eco says spend ("${resetEco}")`);
  expect(resetEco !== null && !/real buy|buy lands next/i.test(resetEco), "no save-for-next-round advice into a money wipe");
  const mpEco = economyLine({ playerIsSelf: true, money: 1200, matchPoint: "them" });
  expect(mpEco !== null && /match|win|done|GG|force|buy|spend|table|bank/i.test(mpEco), `their-match-point eco is a must-win call ("${mpEco}")`);
  const pistolEco = economyLine({ playerIsSelf: true, money: 800, roundKind: "pistol" });
  expect(pistolEco !== null && /pistol|kevlar|armor|util|nade|team|pack|group/i.test(pistolEco), `pistol round gets pistol advice ("${pistolEco}")`);
  expect(pistolEco !== null && !/\beco\b|\bsave\b/i.test(pistolEco), "pistol round not mistaken for an eco");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: enemy loss streak + timeout call (LLM-less) at freezetime ===");
{
  const out: SpeakRequest[] = [];
  const t = new GsiTracker();
  const e = new CoachEngine((req) => out.push(req), null, { getCtx: () => t.context() });
  const run = (p: GsiPayload) => { const ev = t.update(p); if (ev.length) e.handle(ev, t.context()); };
  run(payload({ mapPhase: "warmup" }));
  // matchStart alone first — a same-batch round-1 freezetime is suppressed by design.
  run(payload({ roundPhase: "live", round: 5, ctScore: 1, tScore: 5, ctLosses: 5 }));
  run(payload({ roundPhase: "freezetime", round: 5, ctScore: 1, tScore: 5, ctLosses: 5, tLosses: 0 }));
  const ctxT = t.context();
  expect(ctxT.ourLossStreak === 5, `our loss streak read (${ctxT.ourLossStreak})`);
  expect(ctxT.theirLossStreak === 0, `enemy loss streak exposed in context (${ctxT.theirLossStreak})`);
  expect(ctxT.ourTimeoutsLeft === 1, `timeouts remaining exposed (${ctxT.ourTimeoutsLeft})`);
  const timeoutLine = out.find((s) => s.category === "timeout");
  expect(timeoutLine !== undefined, "canned timeout call spoken on a 5-loss streak (no LLM)");
  expect(timeoutLine !== undefined && /timeout|\btac\b|tactical/i.test(timeoutLine.text), `timeout line makes the call ("${timeoutLine?.text.slice(0, 60)}")`);
  expect(out.some((s) => s.category === "economy"), "economy line still speaks alongside it");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: matchStart + round-1 freezetime → ONE line that carries the pistol call ===");
{
  const { out, engine: e } = freshEngine();
  e.handle(
    [
      { type: "matchStart", map: "de_mirage", mode: "competitive" },
      { type: "freezetime", round: 1 },
    ],
    { ...tracker.context(), roundPhase: "freezetime", roundKind: "pistol", money: 800, playerIsSelf: true },
  );
  const matchLines = out.filter((s) => s.category === "match");
  expect(matchLines.length === 1, "exactly one line for the matchStart+freezetime batch");
  expect(!out.some((s) => s.category === "economy"), "no separate economy line racing the greeting");
  expect(
    /armor|util|kevlar|flash|nade|pistol|pack|group|together|five/i.test(matchLines[0]?.text ?? ""),
    `the one line still carries the pistol call ("${matchLines[0]?.text.slice(0, 80)}")`,
  );
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: LLM timeout directive rides the snapshot as a one-shot flag ===");
{
  const captured: MatchContext[] = [];
  const fakeLlm = {
    line: (c: MatchContext) => { captured.push(c); return Promise.resolve(null); },
    recordSpoken: () => {},
  } as unknown as LlmCoach;
  const e = new CoachEngine(() => {}, fakeLlm, { getCtx: () => tracker.context() });
  const lossCtx = { ...tracker.context(), ourLossStreak: 5, ourTimeoutsLeft: 1, money: 4000, playerIsSelf: true, roundPhase: "freezetime" };
  e.handle([{ type: "freezetime", round: 7 }], lossCtx);
  expect(captured[0]?.suggestTimeout === true, "freezetime prompt carries the timeout directive");
  e.handle([{ type: "teamkill" }], lossCtx);
  expect(captured[1]?.suggestTimeout === undefined, "non-freezetime prompts never carry it");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: bomb-carrier awareness ===");
{
  const t = new GsiTracker();
  t.update(payload({ mapPhase: "warmup", team: "T" }));
  t.update(payload({ roundPhase: "freezetime", round: 0, team: "T" }));
  const withBomb = {
    w0: { name: "weapon_glock", type: "Pistol", state: "active", ammo_clip: 20 },
    w1: { name: "weapon_c4", type: "C4", state: "holstered" },
  } as const;
  t.update(payload({ roundPhase: "live", round: 0, team: "T", weapons: withBomb }));
  expect(t.context().hasBomb === true, "C4 carrier flagged in context");
  t.update(payload({ roundPhase: "live", round: 0, team: "T" })); // bomb planted/dropped — default loadout
  expect(t.context().hasBomb === undefined, "flag clears when the bomb leaves the inventory");
  const carrierLine = lateRoundLine("T", true);
  expect(/bomb|c4|plant|carry|package|deliver/i.test(carrierLine), `carrier nudge talks about the bomb ("${carrierLine.slice(0, 60)}")`);
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: death forensics — flashed, full pockets, own molly, early deaths ===");
{
  const t = new GsiTracker();
  const run = (p: GsiPayload) => t.update(p);
  run(payload({ mapPhase: "warmup" }));
  run(payload({ roundPhase: "freezetime", round: 0 }));
  run(payload({ roundPhase: "live", round: 0 }));
  const nadePockets = {
    w0: { name: "weapon_ak47", type: "Rifle", state: "active", ammo_clip: 30 },
    w1: { name: "weapon_flashbang", type: "Grenade", state: "holstered", ammo_reserve: 1 },
    w2: { name: "weapon_smokegrenade", type: "Grenade", state: "holstered", ammo_reserve: 1 },
  } as const;
  run(payload({ roundPhase: "live", round: 0, weapons: nadePockets, state: { flashed: 255 } }));
  // Real GSI empties the weapons list on the death frame — the forensics must
  // come from the last ALIVE frame, so the sim models the wipe.
  run(payload({ roundPhase: "live", round: 0, weapons: {}, state: { flashed: 255, health: 0 } }));
  const ctxF = t.context();
  expect(ctxF.notables?.some((n) => n.includes("died while flashed")) === true, "blind death recorded as notable");
  expect(ctxF.notables?.some((n) => n.includes("2 unthrown grenades")) === true, "full-pockets death recorded");
  expect(ctxF.earlyDeaths === 1, `opening-seconds death counted (got ${ctxF.earlyDeaths})`);

  run(payload({ roundPhase: "freezetime", round: 1 }));
  const mollyHand = {
    w0: { name: "weapon_ak47", type: "Rifle", state: "holstered", ammo_clip: 30 },
    w1: { name: "weapon_molotov", type: "Grenade", state: "active", ammo_reserve: 1 },
  } as const;
  const rifleOnly = { w0: { name: "weapon_ak47", type: "Rifle", state: "active", ammo_clip: 30 } } as const;
  run(payload({ roundPhase: "live", round: 1, weapons: mollyHand }));
  run(payload({ roundPhase: "live", round: 1, weapons: rifleOnly })); // molly left the inventory
  run(payload({ roundPhase: "live", round: 1, weapons: rifleOnly, state: { burning: 200 } }));
  run(payload({ roundPhase: "live", round: 1, weapons: {}, state: { burning: 200, health: 0 } }));
  expect(t.context().notables?.some((n) => n.includes("own molly")) === true, "burning death inside own molly window blamed on the player");

  // Enemy fire with an UNTHROWN incendiary in pocket: the death-frame wipe
  // must not register a phantom throw and blame the player's own molly.
  run(payload({ roundPhase: "freezetime", round: 2 }));
  const rifleAndInc = {
    w0: { name: "weapon_ak47", type: "Rifle", state: "active", ammo_clip: 30 },
    w1: { name: "weapon_incgrenade", type: "Grenade", state: "holstered", ammo_reserve: 1 },
  } as const;
  run(payload({ roundPhase: "live", round: 2, weapons: rifleAndInc }));
  run(payload({ roundPhase: "live", round: 2, weapons: rifleAndInc, state: { burning: 255 } }));
  run(payload({ roundPhase: "live", round: 2, weapons: {}, state: { burning: 255, health: 0 } }));
  const r3Notes = (t.context().notables ?? []).filter((n) => n.startsWith("R3:"));
  expect(r3Notes.some((n) => n.includes("died burning")), "enemy-fire death recorded as died burning");
  expect(!r3Notes.some((n) => n.includes("own molly")), "enemy-fire death NOT blamed on the player's own molly");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: dead at gameover — K/D falls back to the last own frame ===");
{
  const { buildMatchRecord } = await import("../src/coach/debrief.js");
  const t = new GsiTracker();
  const run = (p: GsiPayload) => t.update(p);
  run(payload({ mapPhase: "warmup" }));
  run(payload({ roundPhase: "freezetime", round: 0 }));
  run(payload({ roundPhase: "live", round: 0 }));
  run(payload({ roundPhase: "live", round: 0, kills: 9 })); // last alive own frame
  run(payload({ roundPhase: "live", round: 0, kills: 9, state: { health: 0 }, weapons: {} }));
  run(payload({ roundPhase: "live", round: 0, steamid: MATE, kills: 23, state: { round_kills: 2 } }));
  run(payload({ roundPhase: "over", round: 1, winTeam: "CT", ctScore: 13, tScore: 7, steamid: MATE, kills: 23, roundWins: { "1": "ct_win_elimination" } }));
  const evs = run(payload({ mapPhase: "gameover", ctScore: 13, tScore: 7, steamid: MATE, kills: 23 }));
  const endEv = evs.find((e) => e.type === "matchEnd") as Extract<CoachEvent, { type: "matchEnd" }>;
  expect(endEv !== undefined, "matchEnd fires with the spectated-teammate player block");
  const rec = buildMatchRecord(endEv, t.context(), t.matchReport());
  expect(rec.kills === 9, `K/D from the last own frame, not the spectated teammate (got ${rec.kills})`);
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: restart during the gameover screen must not re-fire matchEnd ===");
{
  const t = new GsiTracker();
  const evs = t.update(payload({ mapPhase: "gameover", ctScore: 13, tScore: 7 }));
  expect(!evs.some((e) => e.type === "matchEnd"), "first-ever payload on the scoreboard is a baseline sync, not a matchEnd");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: tactical timeout must not wipe match memory or re-announce the match ===");
{
  const t = new GsiTracker();
  const run = (p: GsiPayload) => t.update(p);
  run(payload({ mapPhase: "warmup" }));
  run(payload({ roundPhase: "freezetime", round: 0 }));
  run(payload({ roundPhase: "live", round: 0 }));
  run(payload({ roundPhase: "live", round: 0, state: { round_kills: 1 }, kills: 1 }));
  run(payload({ roundPhase: "over", round: 1, winTeam: "CT", ctScore: 1, roundWins: { "1": "ct_win_elimination" } }));
  run(payload({ mapPhase: "timeout_ct", roundPhase: "freezetime", round: 1 }));
  const resumeEvents = run(payload({ mapPhase: "live", roundPhase: "freezetime", round: 1 }));
  expect(!resumeEvents.some((e) => e.type === "matchStart"), "timeout → live resume is not a fresh matchStart");
  expect(t.context().history?.some((h) => h.includes("R1") && h.includes("1k")) === true, "match memory survives the timeout");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: /coach quiet gates lines and LLM spend ===");
{
  const out: SpeakRequest[] = [];
  let muted = true;
  let llmCalls = 0;
  const fakeLlm = {
    line: () => { llmCalls++; return Promise.resolve("should never be requested while muted"); },
    recordSpoken: () => {},
  } as unknown as LlmCoach;
  const e = new CoachEngine((req) => out.push(req), fakeLlm, { getCtx: () => tracker.context(), isQuiet: () => muted });
  e.handle([{ type: "kill", roundKills: 3, headshot: false }], tracker.context());
  e.handle([{ type: "freezetime", round: 5 }], tracker.context());
  expect(out.length === 0, "muted: no lines reach the voice queue");
  expect(llmCalls === 0, "muted: no LLM calls are made");
  muted = false;
  e.handle([{ type: "kill", roundKills: 3, headshot: false }], tracker.context());
  expect(out.length === 1, "unmuted: speech resumes immediately");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: smart-tier prompts get full history + recentForm; fast tier stays lean ===");
{
  const captured: MatchContext[] = [];
  const fakeLlm = {
    line: (ctx: MatchContext) => { captured.push(ctx); return Promise.resolve(null); },
    recordSpoken: () => {},
  } as unknown as LlmCoach;
  const fullHist = Array.from({ length: 20 }, (_, i) => `R${i + 1} CT full WON (elim)`);
  const form = ["Past matches, newest first: lost 9-13 on Mirage (today)."];
  const e = new CoachEngine(() => {}, fakeLlm, {
    getCtx: () => tracker.context(),
    fullHistory: () => fullHist,
    recentForm: () => form,
  });
  e.handle([{ type: "halftime" }], { ...tracker.context(), history: fullHist.slice(-8) });
  expect(captured[0]?.history?.length === 20, `halftime prompt carries the full history (got ${captured[0]?.history?.length})`);
  expect(captured[0]?.recentForm?.length === 1, "halftime prompt carries cross-session form");
  e.handle([{ type: "teamkill" }], tracker.context());
  expect(captured[1]?.recentForm === undefined, "fast-tier prompt does NOT carry cross-session form");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: session store — record, trends, reload ===");
{
  const { SessionStore } = await import("../src/coach/session-store.js");
  const file = path.join(os.tmpdir(), `cs2-coach-sim-sessions-${Date.now()}.json`);
  const store = new SessionStore(file);
  expect(store.recentForm() === undefined, "no form lines before any match is on file");
  store.record({
    endedAt: new Date(Date.now() - 86_400_000).toISOString(),
    map: "de_mirage", mode: "competitive", won: false, ourScore: 9, theirScore: 13,
    kills: 14, assists: 3, deaths: 19, mvps: 1,
    pistols: { first: "lost", second: "lost" }, earlyDeaths: 4, roundsPlayed: 22,
  });
  store.record({
    endedAt: new Date().toISOString(),
    map: "de_mirage", mode: "competitive", won: false, ourScore: 7, theirScore: 13,
    kills: 11, assists: 5, deaths: 18, mvps: 0,
    pistols: { first: "lost", second: "won" }, earlyDeaths: 3, roundsPlayed: 20,
  });
  const form = store.recentForm("de_mirage") ?? [];
  console.log("  form:", JSON.stringify(form, null, 2));
  expect(form[0]?.startsWith("Past matches, newest first:") === true, "form leads with the match list");
  expect(form[0]?.includes("lost 7-13 on Mirage (today)") === true, "newest match first with a day label");
  expect(form.some((l) => l.includes("2 losses in a row")), "match losing streak surfaced");
  expect(form.some((l) => l.includes("won 1 of 4")), "pistol record aggregated");
  expect(form.some((l) => l.includes("On Mirage specifically: 0 won, 2 lost")), "map record surfaced");
  const reloaded = new SessionStore(file);
  expect(reloaded.count === 2, `store reloads from disk (${reloaded.count} records)`);
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: match end → session record ===");
{
  const { buildMatchRecord } = await import("../src/coach/debrief.js");
  feed("gameover", payload({ mapPhase: "gameover", ctScore: 13, tScore: 7, kills: 7, mvps: 1 }));
  expect(has("matchEnd"), "matchEnd detected at gameover");
  const endEvent = seen.find((e) => e.type === "matchEnd") as Extract<CoachEvent, { type: "matchEnd" }>;
  const rec = buildMatchRecord(endEvent, tracker.context(), tracker.matchReport());
  expect(rec.won === true && rec.ourScore === 13 && rec.theirScore === 7, `record carries the result (${rec.ourScore}-${rec.theirScore})`);
  expect(rec.pistols?.first === "won", "record remembers the pistol-round result");
  expect((rec.notables ?? []).some((n) => n.includes("knife")), "record keeps the knife-kill notable");
  expect((rec.buys?.full ?? 0) + (rec.buys?.force ?? 0) + (rec.buys?.eco ?? 0) > 0, "record counts the buys");
  expect(rec.kills === 7 && rec.mvps === 1, `record carries the K/D (${rec.kills} kills, ${rec.mvps} MVPs)`);
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: tactical timeout → speech for ours, jab for theirs ===");
{
  const out: SpeakRequest[] = [];
  const t = new GsiTracker();
  const e = new CoachEngine((req) => out.push(req), null, { getCtx: () => t.context() });
  const run = (p: GsiPayload) => { const ev = t.update(p); if (ev.length) e.handle(ev, t.context()); };
  run(payload({ mapPhase: "warmup" }));
  run(payload({ roundPhase: "live", round: 3 }));
  run(payload({ roundPhase: "freezetime", round: 3 }));
  const evOurs = t.update(payload({ mapPhase: "timeout_ct", roundPhase: "freezetime", round: 3 }));
  expect(evOurs.some((ev) => ev.type === "timeout" && ev.ours === true), "our timeout detected (we are CT, timeout_ct)");
  e.handle(evOurs, t.context());
  const speech = out.find((s) => s.category === "timeoutTalk");
  expect(speech !== undefined, "timeout speech spoken");
  expect((speech?.text.split(/\s+/).length ?? 0) >= 18, `the speech is an actual speech (${speech?.text.split(/\s+/).length} words)`);

  run(payload({ mapPhase: "live", roundPhase: "freezetime", round: 3 })); // resume
  const evTheirs = t.update(payload({ mapPhase: "timeout_t", roundPhase: "freezetime", round: 3 }));
  expect(evTheirs.some((ev) => ev.type === "timeout" && ev.ours === false), "their timeout detected (we are CT, timeout_t)");
  const out2: SpeakRequest[] = [];
  const e2 = new CoachEngine((req) => out2.push(req), null, { getCtx: () => t.context() });
  e2.handle(evTheirs, t.context());
  const jab = out2.find((s) => s.category === "timeoutTalk");
  expect(jab !== undefined && jab.text.split(/\s+/).length <= 16, `their timeout gets a short jab ("${jab?.text.slice(0, 60)}")`);

  const cold = new GsiTracker();
  const coldEvents = cold.update(payload({ mapPhase: "timeout_ct", roundPhase: "freezetime", round: 3 }));
  expect(!coldEvents.some((ev) => ev.type === "timeout"), "cold start mid-timeout stays quiet (half the pause is gone)");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: long form requested exactly at the dead-air moments ===");
{
  const calls: { type: string; longForm?: boolean; kills?: number }[] = [];
  const fakeLlm = {
    line: (c: MatchContext, ev: CoachEvent, _tier: string, opts?: { longForm?: boolean }) => {
      calls.push({ type: ev.type, longForm: opts?.longForm, kills: c.kills });
      return Promise.resolve(null);
    },
    recordSpoken: () => {},
  } as unknown as LlmCoach;
  const e = new CoachEngine(() => {}, fakeLlm, {
    getCtx: () => tracker.context(),
    finalStats: () => ({ kills: 21, assists: 3, deaths: 17, mvps: 2 }),
  });
  e.handle([{ type: "matchEnd", won: true, ourScore: 13, theirScore: 9 }], { ...tracker.context(), kills: undefined, playerIsSelf: false });
  expect(calls[0]?.type === "matchEnd" && calls[0]?.longForm === true, "match wrap-up requests the long form");
  expect(calls[0]?.kills === 21, "wrap-up snapshot restores the K/D from the last own frame");
  e.handle([{ type: "timeout", ours: true }], tracker.context());
  expect(calls[1]?.type === "timeout" && calls[1]?.longForm === true, "our timeout speech requests the long form");
  e.handle([{ type: "halftime" }], tracker.context());
  expect(calls[2]?.type === "halftime" && calls[2]?.longForm !== true, "halftime stays normal length");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: the Leetify recap waits for a quiet moment ===");
{
  const { spokenStatsSentence } = await import("../src/leetify.js");
  const { leetifyRecapLine } = await import("../src/coach/lines.js");
  const t = new GsiTracker();
  expect(t.quietMomentForSpeech() === true, "no GSI yet → quiet moment (game isn't running)");
  t.update(payload({ mapPhase: "warmup" }));
  t.update(payload({ roundPhase: "live", round: 0 }));
  expect(t.quietMomentForSpeech() === false, "live match → NOT a quiet moment");
  t.update(payload({ mapPhase: "gameover", ctScore: 13, tScore: 5 }));
  expect(t.quietMomentForSpeech() === true, "after gameover → quiet moment again");

  const sentence = spokenStatsSentence({ totalKills: 13, totalDeaths: 19, adr: 67.09, hsKills: 9, leetifyRating: -0.04, reactionTimeMs: 469 });
  expect(sentence === "13 kills to 19 deaths, ADR 67.09, 9 headshot kills, Leetify rating minus 0.04, time to damage 469 milliseconds", `stats sentence reads for TTS ("${sentence}")`);
  expect(spokenStatsSentence({}) === null, "no usable stats → no sentence");
  const recap = leetifyRecapLine("de_mirage", sentence!);
  expect(recap.includes("Mirage") && recap.includes("ADR 67.09") && /leetify/i.test(recap), `canned recap credits Leetify and reads the numbers ("${recap.slice(0, 70)}...")`);
}

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} — config timings: round=${config.timings.roundSeconds}s bomb=${config.timings.bombSeconds}s`);
process.exit(failures === 0 ? 0 : 1);
