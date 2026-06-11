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
const { retakeDecisionLine } = await import("../src/coach/lines.js");
import type { CoachEvent } from "../src/gsi/tracker.js";
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
}

function payload(opts: {
  mapPhase?: "warmup" | "live" | "intermission" | "gameover";
  roundPhase?: "freezetime" | "live" | "over";
  round?: number;
  bomb?: "planted" | "exploded" | "defused";
  winTeam?: "T" | "CT";
  roundWins?: Record<string, string>;
  ctScore?: number;
  tScore?: number;
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
      team_ct: { score: opts.ctScore ?? 0, consecutive_round_losses: 0, timeouts_remaining: 1, matches_won_this_series: 0 },
      team_t: { score: opts.tScore ?? 0, consecutive_round_losses: 0, timeouts_remaining: 1, matches_won_this_series: 0 },
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
  () => tracker.context(),
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
feed("death", payload({ roundPhase: "live", round: 2, ctScore: 1, tScore: 1, state: { health: 0 }, kills: 1 }));
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
  const engine2 = new CoachEngine((req) => out.push(req), null, () => tracker.context());
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
  expect(/defus|wire|stick|stole/i.test(text), `fallback line tells the defuse story ("${text.slice(0, 60)}...")`);
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
  () => trackerF.context(),
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
expect(fightLine !== undefined && /fight|finish/i.test(fightLine.text), "the line backs the ongoing fight");
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
  const e = new CoachEngine(
    (req) => out.push(req),
    fakeLlm,
    () => t.context(),
    () => 0,
    () => t.lastOwnKillAtMs(),
  );
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
  expect(out.some((s) => s.category === "retake" && s.text.includes("Mock")), "LLM retake line still speaks when no kill interrupts it");
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
expect(/win/i.test(mustWinLine) && !/save (it|the|for)/i.test(mustWinLine), "thin gear on match point still gets a must-win retake call, not a save");

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} — config timings: round=${config.timings.roundSeconds}s bomb=${config.timings.bombSeconds}s`);
process.exit(failures === 0 ? 0 : 1);
