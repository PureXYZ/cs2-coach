// Static CS2 knowledge injected into the LLM coach's system prompt.
// Numbers cross-checked against current (2026) MR12 values — if Valve patches
// the economy, this is the one file to touch.

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
- Retake or save (CT, bomb planted, ~40s): with armor, util and numbers feel, retake TOGETHER. With no armor, a pistol, or an expensive gun (AWP) and a bad picture — saving for next round is often the smarter call. Never call a save on match point or when the score math means this round must be played out. A defuse kit makes the retake markedly stronger — say who should be on the stick if the player has it.
- Post-plant (T): play time and crossfires, don't re-peek into the retake; the clock is a teammate.
- Force-buy rounds: utility multiplies cheap guns — suggest stacking nades on one choke (a "nade stack") or playing one site as five.
- Anti-eco (they're broke after you won pistol): warn about getting too close — keep range, don't gift them guns.`;

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
- CT: standard 2A-1mid-2B; retakes come from CT+jungle (A) or market (B). Window AWP controls everything mid.`,
  de_inferno: `MAP NOTES — Inferno:
- Both sides live and die on banana control. T: claim banana early with mollies/flashes, then B execs onto new box and dark; or apps+arch split A pit.
- T force/pistol: banana flood B, or 5 apps. Utility stack on banana works cheap.
- CT: spend util on banana every round, 2-1-2; A retakes from arch + graveyard with mollies for pit/site.`,
  de_nuke: `MAP NOTES — Nuke:
- CT-leaning map. T: outside control opens secret+garage B splits; fast A through hut/squeaky punishes light setups; vent drops to B for wraps.
- T force/pistol: 5-man hut rush A with flashes is the classic.
- CT: 2 outside is standard; ramp control decides B; retake B via secret together.`,
  de_ancient: `MAP NOTES — Ancient:
- Mid control is everything. T: default through mid/donut, then hit A from donut+main or B with ramp smokes.
- T force/pistol: B ramp rush as five, or donut stack into A.
- CT: contest donut early, hold B from cave+triple; mid smoke buys the whole round.`,
  de_anubis: `MAP NOTES — Anubis (reworked Jan 2026: new hole between E-box and back of B, reversed mid doors):
- T: water/mid control splits A via connector+main; B hits through palace with smokes for street cross — the new E-box hole adds a sneaky B entrance.
- T force/pistol: 5 B palace, or mid rush to connector.
- CT: aggressive mid info pays; A retakes from heaven, B from street/connector — watch the E-box hole on B holds.`,
  de_dust2: `MAP NOTES — Dust 2:
- T: long control or B tunnels as five; classic mid-to-B split with the CT-cross smoke; catwalk+long A execs.
- T force/pistol: B rush tunnels or long flood with one smoke for cross.
- CT: AWP mid/long is king; long 2, short 1, B 2; retake B from window+tunnels squeeze.`,
  de_train: `MAP NOTES — Train:
- T: ivy and popdog control first; A execs need smokes for sniper-nest and connector; B through upper with flashes.
- T force/pistol: 5-man B upper, or A main flood with cheap util.
- CT: hold ivy + popdog actively; site cross-fires around the trains win retakes — go together.`,
  de_overpass: `MAP NOTES — Overpass:
- T: bathrooms+long A split, or take water/monster for B with short support. Connector control swings both sites.
- T force/pistol: 5 B monster, or bathrooms rush.
- CT: aggressive B fence/heaven boosts gather info; A holds from bank+truck; retake B from water+site together.`,
  de_vertigo: `MAP NOTES — Vertigo:
- T: A ramp execs with double smoke, or mid take to B split via window.
- T force/pistol: 5-man B rush, or ramp flood with flashes.
- CT: double ramp is standard; retake A from elevator+connector as one unit.`,
};

/** Briefing for the active map, or empty when we don't know the map. */
export function mapBriefing(gsiMapName: string | undefined): string {
  if (!gsiMapName) return "";
  const token = (gsiMapName.split("/").pop() ?? gsiMapName).toLowerCase();
  const brief = MAP_BRIEFINGS[token];
  return brief ? `\n\n${brief}` : "";
}
