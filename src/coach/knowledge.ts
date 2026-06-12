// Static CS2 knowledge injected into the LLM coach's system prompt.
// Numbers cross-checked against current (2026) MR12 values — if Valve patches
// the economy, this is the one file to touch.

import { pick } from "./lines.js";

/** MR12 economy facts the coach reasons with. Keep terse — it's prompt budget. */
export const ECONOMY_CHEATSHEET = `CS2 ECONOMY (MR12, all values $, verified 2026):
- Pistol rounds are round 1 and round 13 (side swap): everyone has 800, no carryover. Money cap 16000. Overtime (MR3) resets everyone to 10000 each OT half.
- Round win: elimination/time 3250; T bomb detonation 3500; CT defuse 3500.
- Round loss bonus ladder: 1400 / 1900 / 2400 / 2900 / 3400 (max). Exception: a lost PISTOL round pays 1900. Winning a round DROPS the loss counter by one, it does not reset it — one lost round after a win streak still pays only 1400.
- Ts who planted but lost still get +800 each; planter +300; defuser +300.
- Kill rewards: rifles & pistols 300, SMGs 600 (P90 300), shotguns 900 (XM1014 600), AWP 100, knife 1500, Zeus 100, HE/molotov 300. CTs also each get +50 team bonus per T killed by anyone on CT.
- Rough buy thresholds (self): full rifle+armor+util needs ~4700; rifle+armor ~3700; under ~2000 is save/eco territory; in between is force-buy land — only force as a team.`;

/** Decision principles for the moments the user cares most about. */
export const DECISION_PRINCIPLES = `DECISION PRINCIPLES:
- Buys: match the team — five half-buys lose to five rifles; solo-saving while four buy is throwing. On high loss bonus (3 losses+) a clean full save converts into a real buy; breaking it with a panic half-buy wastes two rounds.
- Pistol rounds: suggest one concrete plan (stack a site, rush together, or default), not generalities. Winning a pistol usually means two or three easy rounds — say so.
- Retake or save (CT, bomb planted, ~40s): with armor, util and numbers feel, retake TOGETHER. With no armor, a pistol, or an expensive gun (AWP) and a bad picture — saving for next round is often the smarter call. A defuse kit makes the retake markedly stronger — say who should be on the stick if the player has it.
- Save calls are FORBIDDEN when matchPoint is "them" (losing this round loses the match — there is no next round to save for) or moneyResetsNextRound is true (the saved gear evaporates at the reset). In those spots the only call is how to win the round. At OUR OWN match point ("us") normal retake-or-save judgment applies — a lost round keeps the gear and the lead.
- Mid-fight rule: when lastKillSecondsAgo is under ~10, the player is actively winning fights. Never call save/disengage/rotate at them — they cannot use it and it talks over their clutch. Back the play or say less.
- Post-plant (T): play time and crossfires, don't re-peek into the retake; the clock is a teammate.
- Force-buy rounds: utility multiplies cheap guns — suggest stacking nades on one choke (a "nade stack") or playing one site as five.
- Anti-eco (they're broke after you won pistol): warn about getting too close — keep range, don't gift them guns.
- Variety: the tactical call must CHANGE round to round — different site, different pace, different tool. Repeating the last call is only right when it's visibly printing rounds (and then say you're going back to the well).`;

/**
 * Per-map nuggets — Active Duty pool as of June 2026 (Ancient, Anubis, Dust2,
 * Inferno, Mirage, Nuke, Overpass) plus recent rotations (Train, Vertigo) for
 * other playlists. Keyed by GSI map token; only the active map's section is
 * injected, so an unknown map degrades to "no notes" rather than wrong notes.
 */
const MAP_BRIEFINGS: Record<string, string> = {
  de_mirage: `MAP NOTES — Mirage:
- T: mid control wins the map — smoke window, fight top-mid, then split B via catwalk or take A with ramp+palace. Default: 2 mid, lurk palace.
- T force/pistol: B apps flood with flashes, or 5-man A ramp. Nade-stack apps when they expect it cheap.
- CT: standard 2A-1mid-2B; retakes come from CT+jungle (A) or market (B). Window AWP controls everything mid.
- Change-ups: T slow default into late A ramp hit; contact-peek mid no-smoke; B apps fake into cat-to-A. CT: jungle-to-palace aggression, mid push to top-mid after a won round.`,
  de_inferno: `MAP NOTES — Inferno:
- Both sides live and die on banana control. T: claim banana early with mollies/flashes, then B execs onto new box and dark; or apps+arch split A pit.
- T force/pistol: banana flood B, or 5 apps. Utility stack on banana works cheap.
- CT: spend util on banana every round, 2-1-2; A retakes from arch + graveyard with mollies for pit/site.
- Change-ups: T mid take to short A no-apps; banana fake into 5 apps; late-round double-lurk. CT: aggressive apps push with a flash, banana car boost, stacking 3 B off a read.`,
  de_nuke: `MAP NOTES — Nuke:
- CT-leaning map. T: outside control opens secret+garage B splits; fast A through hut/squeaky punishes light setups; vent drops to B for wraps.
- T force/pistol: 5-man hut rush A with flashes is the classic.
- CT: 2 outside is standard; ramp control decides B; retake B via secret together.
- Change-ups: T slow ramp take to B; A fake into vent drop; outside smoke wall once a half. CT: T-roof aggression, 3-outside overload, silo AWP rounds.`,
  de_ancient: `MAP NOTES — Ancient:
- Mid control is everything. T: default through mid/donut, then hit A from donut+main or B with ramp smokes.
- T force/pistol: B ramp rush as five, or donut stack into A.
- CT: contest donut early, hold B from cave+triple; mid smoke buys the whole round.
- Change-ups: T A-main split without donut; mid-to-B wrap; slow default punishing CT util waste. CT: donut push with a flash, mid take after two won rounds, B cave lurk.`,
  de_anubis: `MAP NOTES — Anubis (reworked Jan 2026: new hole between E-box and back of B, reversed mid doors):
- T: water/mid control splits A via connector+main; B hits through palace with smokes for street cross — the new E-box hole adds a sneaky B entrance.
- T force/pistol: 5 B palace, or mid rush to connector.
- CT: aggressive mid info pays; A retakes from heaven, B from street/connector — watch the E-box hole on B holds.
- Change-ups: T A main fake into water-to-B; E-box hole sneak after a loud mid take; double-lurk palace+main. CT: water push, connector smoke-off, B street aggression.`,
  de_dust2: `MAP NOTES — Dust 2:
- T: long control or B tunnels as five; classic mid-to-B split with the CT-cross smoke; catwalk+long A execs.
- T force/pistol: B rush tunnels or long flood with one smoke for cross.
- CT: AWP mid/long is king; long 2, short 1, B 2; retake B from window+tunnels squeeze.
- Change-ups: T short-only A hit with one long lurk; mid doors contact play; long fake into tunnels. CT: pit aggression on long, mid-to-B pinch, short push after plant-side read.`,
  de_train: `MAP NOTES — Train:
- T: ivy and popdog control first; A execs need smokes for sniper-nest and connector; B through upper with flashes.
- T force/pistol: 5-man B upper, or A main flood with cheap util.
- CT: hold ivy + popdog actively; site cross-fires around the trains win retakes — go together.
- Change-ups: T A fake into popdog-to-B; ivy lurk while four hit B; slow round hunting the CT pusher. CT: ivy double-peek, upper B aggression, A-site train boosts.`,
  de_overpass: `MAP NOTES — Overpass:
- T: bathrooms+long A split, or take water/monster for B with short support. Connector control swings both sites.
- T force/pistol: 5 B monster, or bathrooms rush.
- CT: aggressive B fence/heaven boosts gather info; A holds from bank+truck; retake B from water+site together.
- Change-ups: T long-A only with bathrooms fake; monster slow-walk after loud A util; connector take to split both. CT: bathrooms push, water lurk, party-side stack off a read.`,
  de_vertigo: `MAP NOTES — Vertigo:
- T: A ramp execs with double smoke, or mid take to B split via window.
- T force/pistol: 5-man B rush, or ramp flood with flashes.
- CT: double ramp is standard; retake A from elevator+connector as one unit.
- Change-ups: T ramp fake into B stairs; elevator sneak round; slow default forcing CT util first. CT: ramp triple-stack, mid window aggression, B sandbags forward hold.`,
};

/** Briefing for the active map, or empty when we don't know the map. */
export function mapBriefing(gsiMapName: string | undefined): string {
  if (!gsiMapName) return "";
  const token = (gsiMapName.split("/").pop() ?? gsiMapName).toLowerCase();
  const brief = MAP_BRIEFINGS[token];
  return brief ? `\n\n${brief}` : "";
}

/**
 * Named, callable plays per map and side — the freezetime prompt rotates two of
 * these in so the strategy talk stays concrete and map-specific instead of
 * cycling the same generic calls. Each entry is one line a coach could say.
 */
const MAP_PLAYBOOKS: Record<string, { T: string[]; CT: string[] }> = {
  de_mirage: {
    T: [
      "Mid take to B split: smoke window, fight top mid, hit B through cat and apps together",
      "A exec: smoke CT and jungle, molly under palace, ramp and palace hit at once",
      "B apps flood: stack the nades on apps, double flash over, all five through",
      "Slow default: two mid, palace lurk, take whatever opens after their util's gone",
    ],
    CT: [
      "Standard 2-1-2 with the window AWP — mid control is the whole map",
      "Mid push after a won round: flash top mid, pinch their default",
      "Jungle-to-palace aggression with a flash — catch the palace lurk",
      "Stack three B off a read, dump util early on apps",
    ],
  },
  de_inferno: {
    T: [
      "Banana take into B exec: mollies and flashes up banana, smoke coffins and new box",
      "Apps and arch split onto A pit, smoke library and arch site",
      "Five-man apps rush with flashes — cheap and fast before they're set",
      "Slow default: hold banana, lurk mid, hit late when their util's burned",
    ],
    CT: [
      "Spend util on banana every round, 2-1-2, car-and-sandbags hold",
      "Aggressive apps push with a flash to deny the free map",
      "Banana car boost for early info, fall back on contact",
      "Stack three B off a read, molly banana on the timing",
    ],
  },
  de_nuke: {
    T: [
      "Outside take: smoke wall outside, split B through secret and garage",
      "Fast A: flash hut and squeaky, hit site before rotations",
      "Vent drop to B after a loud A fake",
      "Five-man hut rush with flashes — the classic cheap hit",
    ],
    CT: [
      "Two outside is standard — ramp control decides B",
      "T-roof aggression for early info",
      "Three-outside overload after a read",
      "Silo AWP round to punish outside takes",
    ],
  },
  de_ancient: {
    T: [
      "Mid and donut control, then A from donut and main together",
      "B ramp exec: smokes for cave and triple, all five",
      "Donut stack into A — cheap and fast",
      "Slow default punishing their early util waste",
    ],
    CT: [
      "Contest donut early, hold B from cave and triple",
      "Mid smoke buys the round — standard 2-1-2",
      "Donut push with a flash after a won round",
      "B cave lurk on their mid take",
    ],
  },
  de_anubis: {
    T: [
      "Water and mid control, split A through connector and main",
      "B exec through palace with smokes for street cross",
      "E-box hole sneak to B behind a loud mid take",
      "Double lurk palace and main on a slow round",
    ],
    CT: [
      "Aggressive mid info play, fall back to connector",
      "Water push with a flash after a won round",
      "Connector smoke-off to cut the A split",
      "B street aggression to deny the palace take",
    ],
  },
  de_dust2: {
    T: [
      "Long take: flash over, smoke CT cross, all five through",
      "B tunnels as five: smoke window and door, flash in",
      "Classic mid-to-B split with the CT-cross smoke",
      "Cat and long A exec, one tunnels lurk",
    ],
    CT: [
      "AWP holds mid or long — that gun is the round",
      "Long 2, short 1, B 2 standard; squeeze B retakes from window and tunnels",
      "Pit aggression on long with a flash",
      "Mid-to-B pinch after their tunnels commit",
    ],
  },
  de_train: {
    T: [
      "Ivy and popdog control first, then A exec with sniper-nest and connector smokes",
      "B through upper with flashes, all five",
      "A fake into popdog-to-B wrap",
      "Ivy lurk while four hit B upper",
    ],
    CT: [
      "Hold ivy and popdog actively — site crossfires win retakes",
      "Ivy double-peek with a flash",
      "Upper B aggression for info",
      "A-site train boosts to break their exec",
    ],
  },
  de_overpass: {
    T: [
      "Bathrooms and long A split, smoke bank and truck",
      "Water and monster take for B with short support",
      "Connector control, then split both sites late",
      "Five-man monster flood with flashes",
    ],
    CT: [
      "B fence and heaven boosts for early info",
      "A holds from bank and truck, retake B from water together",
      "Bathrooms push with a flash after a won round",
      "Water lurk to catch the B take from behind",
    ],
  },
  de_vertigo: {
    T: [
      "A ramp exec with the double smoke, flash up",
      "Mid take to B split through window",
      "Five-man B rush with flashes",
      "Ramp fake into B stairs",
    ],
    CT: [
      "Double ramp is standard — hold it with util",
      "Mid window aggression with a flash",
      "Ramp triple-stack off a read",
      "B sandbags forward hold to break the rush",
    ],
  },
};

/**
 * Two rotating named plays for the freezetime prompt (shuffle-bag fairness —
 * every play gets called before any repeats). Empty when map or side is unknown.
 */
export function playbookOptions(gsiMapName: string | undefined, side: string | undefined, n = 2): string[] {
  if (!gsiMapName || (side !== "T" && side !== "CT")) return [];
  const token = (gsiMapName.split("/").pop() ?? gsiMapName).toLowerCase();
  const book = MAP_PLAYBOOKS[token]?.[side];
  if (!book || book.length === 0) return [];
  const out: string[] = [];
  const want = Math.min(n, book.length);
  // Consecutive shuffle-bag picks never repeat for pools of 2+, so this terminates.
  while (out.length < want) {
    const play = pick(`playbook:${token}:${side}`, book);
    if (!out.includes(play)) out.push(play);
  }
  return out;
}
