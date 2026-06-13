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
// Multi-feed: a squad of 3 lets the roster tests exercise BOTH the honest-partial
// path (2 of 3 wired → rosterComplete false, always hedge) and the whole-team
// certainty path (all 3 wired → rosterComplete true, last-man calls unlock).
process.env.COACH_SQUAD_SIZE = "3";
// Disable the global-event re-election seam: the sim runs synchronously, so
// back-to-back matches fire microseconds apart and a wall-clock seam would
// wrongly collapse them (in production they're minutes apart).
process.env.GSI_GLOBAL_SEAM_MS = "0";

const { GsiTracker } = await import("../src/gsi/tracker.js");
const { RosterManager } = await import("../src/gsi/roster.js");
const { CoachEngine } = await import("../src/coach/engine.js");
const { config } = await import("../src/config.js");
const { retakeDecisionLine, economyLine, lateRoundLine, lateRoundCarrierNamed, ourTimeoutSpeechLine } = await import("../src/coach/lines.js");
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
  /** Multi-feed: which client is POSTing (provider.steamid). Defaults to ME. */
  provider?: string;
  /** Override the player-block name (defaults to the ME/MATE pair). */
  name?: string;
  team?: "T" | "CT";
  state?: PlayerState;
  kills?: number;
  mvps?: number;
  weapons?: Record<string, Partial<GsiWeapon>>;
}): GsiPayload {
  return {
    provider: { name: "cs2", appid: 730, version: 1, steamid: opts.provider ?? ME, timestamp: 0 },
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
      steamid: opts.steamid ?? opts.provider ?? ME,
      name: opts.name ?? (opts.steamid === MATE ? "BobTheFriend" : "Andy"),
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
  // payloadAgeMs is required now that payloadFresh() treats a never-received feed
  // as STALE (the old `?? 0` fix): timer callouts (bomb/late-round) bail without it.
  { getCtx: () => tracker.context(), payloadAgeMs: () => 0 },
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

  // Reconnect: only menu payloads (no map block) preceded — same rule applies.
  const rejoin = new GsiTracker();
  rejoin.update({ provider: { name: "cs2", appid: 730, version: 1, steamid: ME, timestamp: 0 } } as GsiPayload);
  const rejoinEvents = rejoin.update(payload({ mapPhase: "timeout_ct", roundPhase: "freezetime", round: 3 }));
  expect(!rejoinEvents.some((ev) => ev.type === "timeout"), "reconnect from the menu into a running timeout stays quiet");

  // Crisis framing only when the scoreboard says so.
  const aheadLine = ourTimeoutSpeechLine({ playerIsSelf: true, ourScore: 9, theirScore: 2, ourLossStreak: 0 });
  expect(
    !/losing streak|funeral|bleeding|not better than us|picked off/i.test(aheadLine),
    `timeout speech while ahead doesn't invent a crisis ("${aheadLine.slice(0, 60)}...")`,
  );
  const behindLine = ourTimeoutSpeechLine({ playerIsSelf: true, ourScore: 2, theirScore: 9 });
  expect((behindLine.split(/\s+/).length ?? 0) >= 25, "timeout speech while behind is still a full speech");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: our timeout + freezetime in one batch → the speech owns the moment ===");
{
  const { out, engine: e } = freshEngine();
  e.handle(
    [
      { type: "timeout", ours: true },
      { type: "freezetime", round: 9 },
    ],
    { ...tracker.context(), money: 4000, playerIsSelf: true },
  );
  expect(out.some((s) => s.category === "timeoutTalk"), "our-timeout batch speaks the speech");
  expect(!out.some((s) => s.category === "economy"), "and suppresses the duplicate freezetime buy line");
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
  // Abandon: the client goes back to the menu (payloads without a map block),
  // so no gameover ever clears inMatch — menu frames must count as quiet.
  t.update({ provider: { name: "cs2", appid: 730, version: 1, steamid: ME, timestamp: 0 } } as GsiPayload);
  expect(t.quietMomentForSpeech() === true, "menu payloads after abandoning a match count as quiet");

  const t2 = new GsiTracker();
  t2.update(payload({ mapPhase: "warmup" }));
  t2.update(payload({ roundPhase: "live", round: 0 }));
  t2.update(payload({ mapPhase: "gameover", ctScore: 13, tScore: 5 }));
  expect(t2.quietMomentForSpeech() === true, "after gameover → quiet moment again");

  const sentence = spokenStatsSentence({ totalKills: 13, totalDeaths: 19, adr: 67.09, hsKills: 9, leetifyRating: -0.04, reactionTimeMs: 469 });
  expect(sentence === "13 kills to 19 deaths, ADR 67.09, 9 headshot kills, Leetify rating minus 0.04, time to damage 469 milliseconds", `stats sentence reads for TTS ("${sentence}")`);
  expect(spokenStatsSentence({}) === null, "no usable stats → no sentence");
  const kdOnly = spokenStatsSentence({ kdRatio: 0.68 });
  expect(kdOnly === "K D ratio 0.68", `K/D fallback avoids the slash for TTS ("${kdOnly}")`);
  const recap = leetifyRecapLine("de_mirage", sentence!);
  expect(recap.includes("Mirage") && recap.includes("ADR 67.09") && /leetify/i.test(recap), `canned recap credits Leetify and reads the numbers ("${recap.slice(0, 70)}...")`);
}

// ===========================================================================
// MULTI-FEED: friends also running the GSI cfg. These exercise the RosterManager
// (demux by provider.steamid → one tracker per feed → fused output), which the
// scenarios above never touch (they feed a single GsiTracker directly). Real
// SteamID64s here (17 digits) — the roster validates the shape and drops junk.
// ===========================================================================
const P1 = "76561198000000001"; // primary user ("Andy")
const P2 = "76561198000000002"; // friend ("Mouse")
const P3 = "76561198000000003"; // friend ("Cadian")

function rosterRig(primary: string): {
  r: InstanceType<typeof RosterManager>;
  out: SpeakRequest[];
  run: (label: string, p: GsiPayload) => CoachEvent[];
} {
  const out: SpeakRequest[] = [];
  const r = new RosterManager(primary);
  const e = new CoachEngine((req) => out.push(req), null, { getCtx: () => r.context() });
  const run = (label: string, p: GsiPayload): CoachEvent[] => {
    const { events, ctx } = r.update(p);
    if (events.length > 0) {
      console.log(`  ${label}: ${events.map((x) => x.type).join(", ")}`);
      e.handle(events, ctx);
    }
    return events;
  };
  return { r, out, run };
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: multi-feed — demux, global-event dedup, named teammate triple ===");
{
  const { out, run } = rosterRig(P1);
  run("P1 warmup", payload({ provider: P1, mapPhase: "warmup" }));
  const start = run("P1 r1 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 0 }));
  expect(start.some((e) => e.type === "matchStart"), "primary feed drives matchStart");
  run("P1 r1 live", payload({ provider: P1, roundPhase: "live", round: 0 }));

  // A friend joins and catches up — its duplicate global events are dropped
  // (P1 is the authority), so the channel never hears "match found" twice.
  run("P2 warmup", payload({ provider: P2, mapPhase: "warmup", name: "Mouse" }));
  const dup = run("P2 r1 freeze", payload({ provider: P2, roundPhase: "freezetime", round: 0, name: "Mouse" }));
  expect(!dup.some((e) => e.type === "matchStart" || e.type === "freezetime"), "friend feed's duplicate global events are dropped");
  run("P2 r1 live", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse" }));

  // Singles/doubles from a teammate stay silent (aggregate, don't multiply); the
  // triple becomes a NAMED teammateMultiKill.
  const k1 = run("P2 kill 1", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse", state: { round_kills: 1 }, kills: 1 }));
  expect(k1.length === 0, "a teammate's single kill stays silent");
  run("P2 kill 2", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse", state: { round_kills: 2 }, kills: 2 }));
  const triple = run("P2 triple", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse", state: { round_kills: 3 }, kills: 3 }));
  const tmk = triple.find((e) => e.type === "teammateMultiKill") as Extract<CoachEvent, { type: "teammateMultiKill" }> | undefined;
  expect(tmk?.roundKills === 3, "a teammate's triple becomes a teammateMultiKill");
  expect(tmk?.who.name === "Mouse", "teammateMultiKill carries the friend's own-feed name");
  // Events ITEM 7: teammate multikill hype now buffers behind MULTIKILL_FLUSH_MS
  // (700ms) so two friends popping off merge into one line — flush the window
  // before asserting it lands (the line is still spoken, just one beat later).
  await sleep(900);
  expect(out.some((s) => s.category === "teammate" && s.text.includes("Mouse")), "teammate hype spoken by name");

  // Both feeds cross the round end; only the authority's reaches the engine.
  const p1End = run("P1 r1 over", payload({ provider: P1, roundPhase: "over", round: 1, winTeam: "CT", ctScore: 1, roundWins: { "1": "ct_win_elimination" } }));
  expect(p1End.filter((e) => e.type === "roundEnd").length === 1, "authority feed emits the single roundEnd");
  const p2End = run("P2 r1 over", payload({ provider: P2, roundPhase: "over", round: 1, winTeam: "CT", ctScore: 1, name: "Mouse", roundWins: { "1": "ct_win_elimination" } }));
  expect(!p2End.some((e) => e.type === "roundEnd"), "friend feed's duplicate roundEnd is dropped");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: multi-feed — dead-spectate of a wired teammate is de-duplicated ===");
{
  const { run } = rosterRig(P1);
  run("P1 warmup", payload({ provider: P1, mapPhase: "warmup" }));
  run("P1 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 0 }));
  run("P1 live", payload({ provider: P1, roundPhase: "live", round: 0 }));
  run("P2 live", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse" }));
  // P1 dies and spectates P2 (a wired, live feed). P1's tracker emits teammateKill,
  // but P2 reports its own kills first-hand — so the roster drops the duplicate.
  run("P1 death", payload({ provider: P1, roundPhase: "live", round: 0, state: { health: 0 }, weapons: {} }));
  run("P1 spectates P2 (baseline)", payload({ provider: P1, roundPhase: "live", round: 0, steamid: P2, name: "Mouse", state: { round_kills: 1 }, kills: 3 }));
  const spec = run("P1 sees P2 frag (spectated)", payload({ provider: P1, roundPhase: "live", round: 0, steamid: P2, name: "Mouse", state: { round_kills: 2 }, kills: 3 }));
  expect(!spec.some((e) => e.type === "teammateKill"), "spectated kill of a WIRED teammate is dropped (reported first-hand)");

  // Spectating an UN-wired teammate (never POSTed a feed) still narrates — today's behavior.
  const UNWIRED = "76561198000000009";
  run("P1 spectates unwired (baseline)", payload({ provider: P1, roundPhase: "live", round: 0, steamid: UNWIRED, name: "RandoMM", state: { round_kills: 0 }, kills: 1 }));
  const un = run("P1 sees unwired frag", payload({ provider: P1, roundPhase: "live", round: 0, steamid: UNWIRED, name: "RandoMM", state: { round_kills: 1 }, kills: 1 }));
  expect(un.some((e) => e.type === "teammateKill"), "spectated kill of an UN-wired teammate still narrates");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: multi-feed — partial roster stays honest (2 of a 3-stack) ===");
{
  const { r, run } = rosterRig(P1);
  run("P1 warmup", payload({ provider: P1, mapPhase: "warmup" }));
  run("P1 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 0, state: { money: 4000 } }));
  run("P2 freeze", payload({ provider: P2, roundPhase: "freezetime", round: 0, name: "Mouse", state: { money: 800 } }));
  const ctx = r.context();
  expect(ctx.team !== undefined, "team block present with 2+ feeds");
  expect(ctx.team?.wiredCount === 2, `wiredCount counts fresh feeds (got ${ctx.team?.wiredCount})`);
  expect(ctx.team?.rosterComplete === false, "2 of a 3-person squad is NOT roster-complete — coach must hedge");
  expect(ctx.team?.members.some((m) => m.name === "Mouse") === true, "teammate named from their own feed");
  expect(ctx.team?.members.some((m) => m.isPrimary) === true, "primary flagged in the roster");
  expect(ctx.team?.econ?.length === 2, "team econ carries both wired players' money for the buy call");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: multi-feed — full squad unlocks the last-man call (named survivor) ===");
{
  const { run } = rosterRig(P1);
  run("P1 warmup", payload({ provider: P1, mapPhase: "warmup" }));
  run("P1 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 0 }));
  run("P1 live", payload({ provider: P1, roundPhase: "live", round: 0 }));
  run("P2 live", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse" }));
  run("P3 live", payload({ provider: P3, roundPhase: "live", round: 0, name: "Cadian" }));
  // Drop to two alive: no last-man call yet.
  const twoLeft = run("P2 dies", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse", state: { health: 0 }, weapons: {} }));
  expect(!twoLeft.some((e) => e.type === "lastManStanding"), "no last-man call with two still alive");
  // Primary dies too → the lone survivor is friend P3, named in the third person.
  const lastMan = run("P1 dies", payload({ provider: P1, roundPhase: "live", round: 0, state: { health: 0 }, weapons: {} }));
  const lm = lastMan.find((e) => e.type === "lastManStanding") as Extract<CoachEvent, { type: "lastManStanding" }> | undefined;
  expect(lm !== undefined, "last-man-standing fires when the full squad is down to one");
  expect(lm?.who.name === "Cadian", `last-man call names the surviving friend (got ${lm?.who.name})`);
  expect(lm?.rosterComplete === true, "last-man only fires with whole-team certainty");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: multi-feed — an ENEMY-team friend on the shared token is quarantined ===");
{
  const ENEMY = "76561198000000007";
  const { r, run } = rosterRig(P1);
  run("P1 warmup", payload({ provider: P1, mapPhase: "warmup", team: "CT" }));
  run("P1 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 0, team: "CT" }));
  run("P1 live", payload({ provider: P1, roundPhase: "live", round: 0, team: "CT" }));
  run("P2 live (CT)", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse", team: "CT" }));
  // A friend queued onto the enemy T side, POSTing to the same token.
  run("ENEMY live (T)", payload({ provider: ENEMY, roundPhase: "live", round: 0, name: "Traitor", team: "T" }));
  const ctx = r.context();
  expect(ctx.team?.wiredCount === 2, `enemy feed excluded from wiredCount (got ${ctx.team?.wiredCount})`);
  expect(!ctx.team?.members.some((m) => m.name === "Traitor"), "enemy feed is NOT a roster member");
  // The enemy triples — must NOT be hyped as a teammate.
  run("ENEMY kill 1", payload({ provider: ENEMY, roundPhase: "live", round: 0, name: "Traitor", team: "T", state: { round_kills: 1 }, kills: 1 }));
  run("ENEMY kill 2", payload({ provider: ENEMY, roundPhase: "live", round: 0, name: "Traitor", team: "T", state: { round_kills: 2 }, kills: 2 }));
  const enemyTriple = run("ENEMY triple", payload({ provider: ENEMY, roundPhase: "live", round: 0, name: "Traitor", team: "T", state: { round_kills: 3 }, kills: 3 }));
  expect(!enemyTriple.some((e) => e.type === "teammateMultiKill"), "an enemy's triple is never hyped as a teammate");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: multi-feed — halftime side-swap can't sneak an enemy friend into the squad ===");
{
  const ENEMY = "76561198000000008";
  const { r, run } = rosterRig(P1);
  run("P1 r1 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 0, team: "CT" }));
  run("P1 r1 live", payload({ provider: P1, roundPhase: "live", round: 0, team: "CT" }));
  run("P2 r1 live (CT)", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse", team: "CT" }));
  // An enemy-team friend on T posts several frames → opposite-side votes pile up.
  run("E1 f1 (T)", payload({ provider: ENEMY, roundPhase: "live", round: 0, name: "Traitor", team: "T" }));
  run("E1 f2 (T)", payload({ provider: ENEMY, roundPhase: "live", round: 0, name: "Traitor", team: "T" }));
  run("E1 f3 (T)", payload({ provider: ENEMY, roundPhase: "live", round: 0, name: "Traitor", team: "T" }));
  // HALFTIME SWAP: the primary flips to T first; the enemy hasn't posted its
  // post-swap (CT) frame yet, so it still shows T — momentarily the SAME side as
  // the just-swapped primary. The accumulated opposite-side vote must keep it out.
  run("P1 swapped to T", payload({ provider: P1, roundPhase: "freezetime", round: 12, team: "T", ctScore: 6, tScore: 6 }));
  const enemyTriple = run("E1 triple (stale T)", payload({ provider: ENEMY, roundPhase: "live", round: 12, name: "Traitor", team: "T", state: { round_kills: 3 }, kills: 3, ctScore: 6, tScore: 6 }));
  expect(!enemyTriple.some((e) => e.type === "teammateMultiKill"), "halftime side coincidence does NOT hype the enemy as a teammate");
  // The real teammate P2 also swaps to T and must STAY in the squad.
  run("P2 swapped to T", payload({ provider: P2, roundPhase: "freezetime", round: 12, name: "Mouse", team: "T", ctScore: 6, tScore: 6 }));
  const ctx = r.context();
  expect(ctx.team?.members.some((m) => m.name === "Mouse") === true, "real teammate stays wired through the side swap");
  expect(!ctx.team?.members.some((m) => m.name === "Traitor"), "enemy stays quarantined across the swap");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: multi-feed — a brand-new feed seen only during the swap seam can't be voted in ===");
{
  const SNEAK = "76561198000000010";
  const { run } = rosterRig(P1);
  run("P1 r1 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 0, team: "CT" }));
  run("P1 r1 live", payload({ provider: P1, roundPhase: "live", round: 0, team: "CT" }));
  run("P2 r1 live", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse", team: "CT" }));
  // The primary has crossed the swap to round 13 (T). A fresh enemy connects but
  // is a round behind (still round 12) — out of phase, so its side is never voted
  // against the primary's, even though its stale T momentarily matches the primary's new T.
  run("P1 r13 freeze (T)", payload({ provider: P1, roundPhase: "freezetime", round: 12, team: "T", ctScore: 6, tScore: 6 }));
  run("Sneak baseline (r12, T)", payload({ provider: SNEAK, roundPhase: "live", round: 11, name: "Sneak", team: "T", ctScore: 6, tScore: 6 }));
  const seam = run("Sneak triple (r12 while primary on r13)", payload({ provider: SNEAK, roundPhase: "live", round: 11, name: "Sneak", team: "T", state: { round_kills: 3 }, kills: 3, ctScore: 6, tScore: 6 }));
  expect(!seam.some((e) => e.type === "teammateMultiKill"), "a feed a round out of phase casts no vote and isn't hyped");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: multi-feed — side votes reset between matches (former teammate, now an enemy) ===");
{
  const { r, run } = rosterRig(P1);
  // Match A: P1 + P2 both CT — P2 becomes a confirmed teammate.
  run("A P1 live", payload({ provider: P1, roundPhase: "live", round: 0, team: "CT" }));
  run("A P2 live", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse", team: "CT" }));
  run("A P2 live 2", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse", team: "CT" }));
  expect(r.context().team?.members.some((m) => m.name === "Mouse") === true, "P2 is a teammate in match A");
  // Match B begins (both clients re-matchStart through warmup). P2 is now an enemy.
  run("B P1 warmup", payload({ provider: P1, mapPhase: "warmup", team: "CT" }));
  run("B P1 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 0, team: "CT" }));
  run("B P1 live", payload({ provider: P1, roundPhase: "live", round: 0, team: "CT" }));
  run("B P2 warmup", payload({ provider: P2, mapPhase: "warmup", name: "Mouse", team: "T" }));
  run("B P2 enemy live", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse", team: "T" }));
  run("B P2 enemy live 2", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse", team: "T" }));
  expect(!r.context().team?.members.some((m) => m.name === "Mouse"), "P2's match-A votes reset; now correctly an enemy, out of the squad");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: multi-feed — a mid-match blip doesn't wipe a teammate's confirmation ===");
{
  const { r, run } = rosterRig(P1);
  run("P1 r5 live", payload({ provider: P1, roundPhase: "live", round: 4, team: "CT", ctScore: 3, tScore: 1 }));
  run("P2 r5 live", payload({ provider: P2, roundPhase: "live", round: 4, name: "Mouse", team: "CT", ctScore: 3, tScore: 1 }));
  run("P2 r5 live 2", payload({ provider: P2, roundPhase: "live", round: 4, name: "Mouse", team: "CT", ctScore: 3, tScore: 1 }));
  expect(r.context().team?.members.some((m) => m.name === "Mouse") === true, "P2 confirmed teammate mid-match");
  // Primary moves on to round 6; P2 has a network blip (one menu frame) and
  // resumes a round behind — so its resume casts no fresh vote. The vote tally
  // must survive the spurious matchStart (scoreboard is 3-1, not a new game),
  // or P2 would drop out of the squad for the gap.
  run("P1 r6 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 5, team: "CT", ctScore: 3, tScore: 1 }));
  run("P1 r6 live", payload({ provider: P1, roundPhase: "live", round: 5, team: "CT", ctScore: 3, tScore: 1 }));
  run("P2 menu blip", { provider: { name: "cs2", appid: 730, version: 1, steamid: P2, timestamp: 0 } } as GsiPayload);
  run("P2 resume (a round behind)", payload({ provider: P2, roundPhase: "live", round: 4, name: "Mouse", team: "CT", ctScore: 3, tScore: 1 }));
  expect(r.context().team?.members.some((m) => m.name === "Mouse") === true, "P2 stays a teammate through a mid-match blip (votes not wiped at 3-1)");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: multi-feed — abandoning a match still announces the NEXT one ===");
{
  const { run } = rosterRig(P1);
  run("warmup", payload({ provider: P1, mapPhase: "warmup" }));
  run("match A freeze", payload({ provider: P1, roundPhase: "freezetime", round: 0 }));
  run("match A live", payload({ provider: P1, roundPhase: "live", round: 0 }));
  // Abandon: client drops to the menu (payloads with no map block), no gameover.
  run("menu", { provider: { name: "cs2", appid: 730, version: 1, steamid: P1, timestamp: 0 } } as GsiPayload);
  // New match queued — its matchStart MUST still fire (the old inMatch latch ate it).
  const matchB = run("match B live", payload({ provider: P1, roundPhase: "freezetime", round: 0 }));
  expect(matchB.some((e) => e.type === "matchStart"), "the next match is announced after an abandon");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: multi-feed — no false last-man at round start (stale dead frames) ===");
{
  const { run } = rosterRig(P1);
  run("P1 warmup", payload({ provider: P1, mapPhase: "warmup" }));
  run("P1 r1 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 0 }));
  run("P1 r1 live", payload({ provider: P1, roundPhase: "live", round: 0 }));
  run("P2 r1 live", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse" }));
  run("P3 r1 live", payload({ provider: P3, roundPhase: "live", round: 0, name: "Cadian" }));
  // Round 1: friends die, P1 wins it. (Their last frames now show dead, round 1.)
  run("P2 dies r1", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse", state: { health: 0 }, weapons: {} }));
  run("P3 dies r1", payload({ provider: P3, roundPhase: "live", round: 0, name: "Cadian", state: { health: 0 }, weapons: {} }));
  run("P1 r1 over", payload({ provider: P1, roundPhase: "over", round: 1, winTeam: "CT", ctScore: 1, roundWins: { "1": "ct_win_elimination" } }));
  // Round 2 goes live for the PRIMARY only — the friends' feeds haven't posted a
  // round-2 frame yet, so their cached frames still read "dead from round 1".
  // That must NOT be read as a 1-alive clutch.
  run("P1 r2 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 1, ctScore: 1 }));
  const r2Live = run("P1 r2 live", payload({ provider: P1, roundPhase: "live", round: 1, ctScore: 1 }));
  expect(!r2Live.some((e) => e.type === "lastManStanding"), "no false last-man at round start while teammates' feeds are behind");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: connection-blip — a behind/unknown member suppresses the whole-team last-man until it catches up ===");
{
  // The synchronous harness can't make a still-connected feed go non-fresh (its
  // lastSeen is bumped to now on every payload and wall-clock never advances), so
  // ITEM 1's leave-grace/reclaim-confirm windows are unit-reasoned, not driven here.
  // What IS deterministic — and is the honesty guarantee ITEM 2/13 exist for — is
  // that a CONFIRMED member whose feed is BEHIND the squad round reads as alive
  // === undefined (an honest unknown), and the whole-team last-man call stays
  // suppressed for as long as anyone is unknown, then fires once every member is
  // accounted for and exactly one survives.
  const { r, run } = rosterRig(P1);
  run("P1 warmup", payload({ provider: P1, mapPhase: "warmup" }));
  run("P1 r1 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 0 }));
  run("P1 r1 live", payload({ provider: P1, roundPhase: "live", round: 0 }));
  run("P2 r1 live", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse" }));
  run("P3 r1 live", payload({ provider: P3, roundPhase: "live", round: 0, name: "Cadian" }));
  expect(r.context().team?.rosterComplete === true, "full 3-stack wired and caught up → roster-complete");

  // The squad rolls into round 2: P1 advances and P2 dies, but P3's feed is still
  // a round behind (a brief stall), so the squad-MAX refRound leaves P3's cached
  // frame reading as an unknown — NOT a confirmed survivor count.
  run("P1 r2 live", payload({ provider: P1, roundPhase: "live", round: 1, ctScore: 1 }));
  const stalled = run("P2 dies r2", payload({ provider: P2, roundPhase: "live", round: 1, name: "Mouse", state: { health: 0 }, weapons: {}, ctScore: 1 }));
  expect(!stalled.some((e) => e.type === "lastManStanding"), "no last-man while a member's feed is still behind the round (alive unknown)");
  const cadian = r.context().team?.members.find((m) => m.name === "Cadian");
  expect(cadian !== undefined && cadian.alive === undefined, "the behind member shows alive === undefined (honest unknown, not a false death)");

  // P3's feed catches up to round 2 already dead → now every member is known and
  // P1 is the lone survivor, so the whole-team last-man finally fires (primary
  // survivor, addressed in the second person → who.name undefined).
  const lastMan = run("P3 catches up dead", payload({ provider: P3, roundPhase: "live", round: 1, name: "Cadian", state: { health: 0 }, weapons: {}, ctScore: 1 }));
  const lm = lastMan.find((e) => e.type === "lastManStanding") as Extract<CoachEvent, { type: "lastManStanding" }> | undefined;
  expect(lm !== undefined, "last-man fires once the behind member catches up and one survivor remains");
  expect(lm?.who.name === undefined, "the primary survivor is addressed in the second person (no name)");
  expect(lm?.rosterComplete === true, "last-man still carries whole-team certainty");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: connection-blip ITEM 13 — authority lagging a faster teammate at a boundary stays an honest unknown ===");
{
  const { run } = rosterRig(P1);
  run("P1 warmup", payload({ provider: P1, mapPhase: "warmup" }));
  run("P1 r1 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 0 }));
  run("P1 r1 live", payload({ provider: P1, roundPhase: "live", round: 0 }));
  run("P2 r1 live", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse" }));
  run("P3 r1 live", payload({ provider: P3, roundPhase: "live", round: 0, name: "Cadian" }));
  run("P2 dies r1", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse", state: { health: 0 }, weapons: {} }));
  run("P3 dies r1", payload({ provider: P3, roundPhase: "live", round: 0, name: "Cadian", state: { health: 0 }, weapons: {} }));
  // P2's feed crosses into round 2 first; the authority P1 is still posting round-1
  // frames. The squad-MAX refRound jumps to P2's round, so P1's and P3's cached
  // round-1 (dead) frames read as unknown — no false 1-alive clutch on the survivors.
  const ahead = run("P2 r2 live (ahead of authority)", payload({ provider: P2, roundPhase: "live", round: 1, name: "Mouse", ctScore: 1 }));
  expect(!ahead.some((e) => e.type === "lastManStanding"), "a teammate pulling ahead of the authority casts no false last-man");
  const behind = run("P1 r1 frame (authority lagging)", payload({ provider: P1, roundPhase: "live", round: 0 }));
  expect(!behind.some((e) => e.type === "lastManStanding"), "the lagging authority's stale frame is an honest unknown, not a clutch");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: econ — gear + alive per entry, fresh tier, cross-round buy-sync ===");
{
  const { r, run } = rosterRig(P1);
  run("P1 warmup", payload({ provider: P1, mapPhase: "warmup" }));
  run("P1 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 0, state: { money: 4000, equip_value: 4500 } }));
  run("P2 freeze", payload({ provider: P2, roundPhase: "freezetime", round: 0, name: "Mouse", state: { money: 800, equip_value: 0 } }));
  run("P3 freeze", payload({ provider: P3, roundPhase: "freezetime", round: 0, name: "Cadian", state: { money: 800, equip_value: 0 } }));
  const team = r.context().team;
  const econ = team?.econ ?? [];
  const primaryEntry = econ.find((e) => e.isPrimary);
  expect(primaryEntry?.equipValue === 4500, `primary econ entry carries its own gear (equipValue ${primaryEntry?.equipValue})`);
  expect(econ.length === 3 && econ.every((e) => e.alive === true), "every econ entry carries alive (all up at freezetime)");
  // Each feed reports its OWN player (provider === player.steamid → playerIsSelf),
  // so every feed's own equipValue is read — the non-primary entries carry the gear
  // they reported (0 here), NOT undefined. The honesty hedge is the tier, below.
  expect(econ.filter((e) => !e.isPrimary).every((e) => e.equipValue === 0), "non-primary entries carry the gear value they reported (0)");
  expect(team?.members.every((m) => m.tier === "fresh") === true, "every member is fresh-tier in the synchronous harness (staleMs ≈ 0)");

  // Build a 2-round out-of-sync pattern: Mouse full-buys alone while P1/P3 save.
  // Post the teammates first and the authority (P1) LAST each freeze, so the ring
  // snapshots the round's settled buys exactly once (phaseIsFreeze on P1's frame).
  const syncRig = rosterRig(P1);
  const sr = syncRig.r;
  const sRun = syncRig.run;
  sRun("P1 warmup", payload({ provider: P1, mapPhase: "warmup" }));
  sRun("P1 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 0 }));
  sRun("P1 live", payload({ provider: P1, roundPhase: "live", round: 0 }));
  sRun("P2 live", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse" }));
  sRun("P3 live", payload({ provider: P3, roundPhase: "live", round: 0, name: "Cadian" }));
  for (const round of [2, 3]) {
    sRun(`r${round} P? live`, payload({ provider: P1, roundPhase: "live", round: round - 1, ctScore: 1 }));
    sRun(`r${round} P2 live`, payload({ provider: P2, roundPhase: "live", round: round - 1, name: "Mouse", ctScore: 1 }));
    sRun(`r${round} P3 live`, payload({ provider: P3, roundPhase: "live", round: round - 1, name: "Cadian", ctScore: 1 }));
    sRun(`r${round} P2 freeze (full)`, payload({ provider: P2, roundPhase: "freezetime", round, name: "Mouse", state: { money: 5000 }, ctScore: 1 }));
    sRun(`r${round} P3 freeze (save)`, payload({ provider: P3, roundPhase: "freezetime", round, name: "Cadian", state: { money: 1000 }, ctScore: 1 }));
    sRun(`r${round} P1 freeze (save)`, payload({ provider: P1, roundPhase: "freezetime", round, state: { money: 1000 }, ctScore: 1 }));
  }
  const synced = sr.context().team;
  expect(synced?.rosterComplete === true, "full squad wired for the buy-sync read");
  expect(typeof synced?.buySyncNote === "string" && synced.buySyncNote.includes("Mouse"), `buy-sync read names the lone out-of-sync buyer ("${synced?.buySyncNote}")`);

  // 2-of-3 wired → no whole-team license → no buy-sync read at all.
  const partial = rosterRig(P1);
  partial.run("P1 warmup", payload({ provider: P1, mapPhase: "warmup" }));
  partial.run("P1 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 0, state: { money: 5000 } }));
  partial.run("P2 freeze", payload({ provider: P2, roundPhase: "freezetime", round: 0, name: "Mouse", state: { money: 1000 } }));
  expect(partial.r.context().team?.buySyncNote === undefined, "no buy-sync read while the roster is only partial (no whole-team license)");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: events ITEM 8 — numbers-aware CT retake when the squad is fully wired ===");
{
  // The branch reads only rosterComplete + aliveWired + gear off MatchContext, so
  // the team literal can skip members[]. TeamContext now REQUIRES visibility (and
  // members[].tier), so the literal is cast `as any` to satisfy the type offline.
  const teamCtx = (alive: number, complete = true) =>
    ({ playerIsSelf: true, health: 100, armor: 100, equipValue: 4000, ourSide: "CT",
       team: { wiredCount: 3, rosterComplete: complete, squadSize: 3, members: [], aliveWired: alive, visibility: "x" } }) as any;
  // The line is a shuffle-bag pick, so exhaust the 2-alive pool across several calls:
  // EVERY variant must make the two-man call, and the SET must hedge the enemy.
  const two: string[] = [];
  for (let i = 0; i < 6; i++) two.push(retakeDecisionLine(teamCtx(2)));
  expect(two.every((l) => /two|2/i.test(l)), "every 2-alive line makes a two-man call");
  expect(two.some((l) => /dunno|can't see|don't know|their numbers|overcommit/i.test(l)), "the 2-alive pool hedges the unseen enemy");
  const one: string[] = [];
  for (let i = 0; i < 6; i++) one.push(retakeDecisionLine(teamCtx(1)));
  expect(one.every((l) => !/all five|5-man|five-man|\bfive\b/i.test(l)), "a 1-alive numbers call never orders a 5-man retake");
  // Partial roster (no whole-team count) falls through to the gear pools.
  const partial: string[] = [];
  for (let i = 0; i < 8; i++) partial.push(retakeDecisionLine(teamCtx(2, false)));
  expect(
    partial.every((l) => !/of us|full squad up|Three-plus|the bodies/.test(l)),
    "a partial roster falls through to the gear pools, not a numbers call",
  );
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: events ITEM 4 — late-round nudge names the wired C4 carrier ===");
{
  const named = lateRoundCarrierNamed("Mouse");
  expect(named.includes("Mouse") && /bomb|c4|plant|site|carry/i.test(named), `carrier nudge names the teammate and talks bomb ("${named}")`);
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: events ITEM 7 — simultaneous teammate multikills merge; same-feed dedupes; freezetime clears ===");
{
  // Two friends popping off in the same beat buffer and flush ONE merged line after
  // MULTIKILL_FLUSH_MS (700ms) — await sleep(900) clears the window. The engine reads
  // the top-level tracker for ctx, but the buffer/flush never touch it for content.
  const out: SpeakRequest[] = [];
  const e = new CoachEngine((req) => out.push(req), null, { getCtx: () => tracker.context() });
  e.handle([{ type: "teammateMultiKill", who: { steamid: P2, name: "Mouse" }, roundKills: 3 }], tracker.context());
  e.handle([{ type: "teammateMultiKill", who: { steamid: P3, name: "Cadian" }, roundKills: 4 }], tracker.context());
  expect(out.length === 0, "no line speaks inside the merge window");
  await sleep(900);
  const merged = out.filter((s) => s.category === "teammate");
  expect(merged.length === 1, "the two multikills merge into exactly ONE teammate line");
  expect(merged[0]?.text.includes("Mouse") && merged[0]?.text.includes("Cadian"), "the merged line names BOTH friends");

  // Same steamid going triple → quad raises the buffered entry to one quad line.
  const out2: SpeakRequest[] = [];
  const e2 = new CoachEngine((req) => out2.push(req), null, { getCtx: () => tracker.context() });
  e2.handle([{ type: "teammateMultiKill", who: { steamid: P2, name: "Mouse" }, roundKills: 3 }], tracker.context());
  e2.handle([{ type: "teammateMultiKill", who: { steamid: P2, name: "Mouse" }, roundKills: 4 }], tracker.context());
  await sleep(900);
  const dedup = out2.filter((s) => s.category === "teammate");
  expect(dedup.length === 1 && /four|4|quad|fifth/i.test(dedup[0].text), "a triple→quad on one feed dedupes to a single quad-level line");

  // A freezetime between the multikill and the flush clears the buffer (new round,
  // last round's pending hype is dead) — no teammate line survives the boundary.
  const out3: SpeakRequest[] = [];
  const e3 = new CoachEngine((req) => out3.push(req), null, { getCtx: () => tracker.context() });
  e3.handle([{ type: "teammateMultiKill", who: { steamid: P2, name: "Mouse" }, roundKills: 3 }], tracker.context());
  e3.handle([{ type: "freezetime", round: 5 }], { ...tracker.context(), playerIsSelf: true, money: 4000 });
  await sleep(900);
  expect(!out3.some((s) => s.category === "teammate"), "a freezetime before the flush clears the pending multikill hype");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: llm-prompt — visibility verdict + squad-aware freezetime/halftime/matchEnd prompts ===");
{
  const { describeMomentForTest } = await import("../src/coach/llm.js");
  // 2 of a 3-stack wired → the verdict is an explicit hedge, names the gap, and
  // never licenses whole-team facts.
  const { r, run } = rosterRig(P1);
  run("P1 warmup", payload({ provider: P1, mapPhase: "warmup" }));
  run("P1 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 4, ctScore: 2, tScore: 2 }));
  run("P2 freeze", payload({ provider: P2, roundPhase: "freezetime", round: 4, name: "Mouse", ctScore: 2, tScore: 2 }));
  const partialVis = r.context().team?.visibility ?? "";
  expect(/hedge/i.test(partialVis), `partial verdict tells the coach to hedge ("${partialVis.slice(0, 60)}...")`);
  expect(partialVis.includes("3"), "partial verdict names the full squad size");
  expect(!/whole-team facts/i.test(partialVis), "partial verdict never licenses whole-team facts");

  // The third feed completes the stack → the verdict flips to whole-team licence.
  run("P3 freeze", payload({ provider: P3, roundPhase: "freezetime", round: 4, name: "Cadian", ctScore: 2, tScore: 2 }));
  const fullCtx = r.context();
  expect(fullCtx.team?.rosterComplete === true, "all three wired → roster-complete");
  expect(/whole-team facts/i.test(fullCtx.team?.visibility ?? ""), "the full-stack verdict licenses whole-team facts");

  const freeze = describeMomentForTest({ type: "freezetime", round: 5 }, fullCtx);
  expect(/coordinated execute/i.test(freeze), "full-stack freezetime prompt invites a coordinated execute");
  expect(/SUGGESTED setup|can't see where/i.test(freeze), "the execute is a suggestion, not an asserted position");
  expect(freeze.includes("Mouse") && freeze.includes("Cadian"), "the execute hands jobs to the named crew");
  const halftime = describeMomentForTest({ type: "halftime" }, fullCtx);
  expect(/wired crew/i.test(halftime), "halftime prompt names the wired crew");
  expect(/team\.visibility/i.test(halftime), "halftime prompt defers to team.visibility");
  expect(/ONE lighter jab/i.test(halftime), "halftime prompt allows the rotated one-jab");
  const matchEnd = describeMomentForTest({ type: "matchEnd", won: true, ourScore: 13, theirScore: 9 }, fullCtx, true);
  expect(/PRIMARY player's ALONE|no stats for any teammate/i.test(matchEnd), "matchEnd prompt guards the K/D as the primary's alone");

  // Second rig: only 2 of 3 wired → the coordinated execute is withheld, but the
  // dead-air break clause is econ-independent and still names the players we can see.
  const half = rosterRig(P1);
  half.run("P1 warmup", payload({ provider: P1, mapPhase: "warmup" }));
  half.run("P1 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 4, ctScore: 2, tScore: 2 }));
  half.run("P2 freeze", payload({ provider: P2, roundPhase: "freezetime", round: 4, name: "Mouse", ctScore: 2, tScore: 2 }));
  const partialCtx = half.r.context();
  const freezePartial = describeMomentForTest({ type: "freezetime", round: 5 }, partialCtx);
  expect(!/coordinated execute/i.test(freezePartial), "a partial roster gets no coordinated-execute invite");
  const halftimePartial = describeMomentForTest({ type: "halftime" }, partialCtx);
  expect(/wired crew|players you can see/i.test(halftimePartial), "the halftime break clause still names the wired crew (econ-independent)");
}

// ---------------------------------------------------------------------------
console.log("\n=== scenario: ops — quarantine surfacing + configured squad size + primary presence ===");
{
  const ENEMY = "76561198000000011";
  const { r, run } = rosterRig(P1);
  run("P1 warmup", payload({ provider: P1, mapPhase: "warmup", team: "CT" }));
  run("P1 freeze", payload({ provider: P1, roundPhase: "freezetime", round: 0, team: "CT" }));
  run("P1 live", payload({ provider: P1, roundPhase: "live", round: 0, team: "CT" }));
  run("P2 live", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse", team: "CT" }));
  run("P2 live 2", payload({ provider: P2, roundPhase: "live", round: 0, name: "Mouse", team: "CT" }));
  run("ENEMY live", payload({ provider: ENEMY, roundPhase: "live", round: 0, name: "Traitor", team: "T" }));
  run("ENEMY live 2", payload({ provider: ENEMY, roundPhase: "live", round: 0, name: "Traitor", team: "T" }));
  expect(r.primaryEverSeenThisMatch() === true, "the configured primary connected a feed this match");
  const quarantined = r.quarantinedFeeds();
  expect(quarantined.some((q) => q.name === "Traitor" && q.reason === "opposite-side-vote"), "the enemy-side feed is surfaced as quarantined (opposite-side vote)");
  expect(!quarantined.some((q) => q.name === "Mouse"), "the confirmed teammate is NOT quarantined");
  expect(r.squadSize() === 3, "squad size reads the configured COACH_SQUAD_SIZE");
  expect(r.context().team?.rosterComplete === false, "2 confirmed of a 3-stack → not roster-complete");
}

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} — config timings: round=${config.timings.roundSeconds}s bomb=${config.timings.bombSeconds}s`);
process.exit(failures === 0 ? 0 : 1);
