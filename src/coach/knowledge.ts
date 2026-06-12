// Static CS2 knowledge injected into the LLM coach's system prompt.
// Numbers cross-checked against current (2026) MR12 values — if Valve patches
// the economy, this is the one file to touch.

import { pick } from "./lines.js";

/** MR12 economy facts the coach reasons with. Keep terse — it's prompt budget. */
export const ECONOMY_CHEATSHEET = `CS2 ECONOMY (MR12, all values $, verified 2026):
- Pistol rounds are round 1 and round 13 (side swap): everyone has 800, no carryover. Money cap 16000. Overtime (MR3) resets everyone to 10000 each OT half.
- Round win: elimination/time 3250; T bomb detonation 3500; CT defuse 3500.
- Round loss bonus ladder: 1400 / 1900 / 2400 / 2900 / 3400 (max). Exception: a lost PISTOL round pays 1900. Winning a round DROPS the loss counter (it does not fully reset) — one lost round after a win streak still pays near the bottom of the ladder.
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
- Enemy economy read: "theirLossStreak" is THEIR consecutive lost rounds — the only window into their wallet you get. 0 means they just won, expect a real buy. 1 usually means an eco or cheap force is coming. 3+ means their loss bonus is near max: broke now, but one won round away from full rifles. Call anti-eco discipline or a rebuy warning off this number.
- Timeouts: "ourTimeoutsLeft" above 0 with a 4+ round loss streak is exactly what a tactical timeout exists for — tell the team to vote it NOW: breathe, reset, fix ONE thing. Don't suggest it twice once it's been called (the count drops).
- Variety: the tactical call must CHANGE round to round — different site, different pace, different tool. Repeating the last call is only right when it's visibly printing rounds (and then say you're going back to the well).`;

/**
 * Per-map knowledge packs — researched June 2026 (web-verified callouts, current
 * layouts and meta). Active Duty as of June 2026: Ancient, Anubis (reworked
 * Jan 2026), Dust2, Inferno, Mirage, Nuke, Overpass. Train (dropped Jan 2026)
 * and Vertigo (dropped Jan 2025) stay here for other playlists. Keyed by GSI
 * map token; only the active map's section is injected, so an unknown map
 * degrades to "no notes" rather than wrong notes.
 */
const MAP_BRIEFINGS: Record<string, string> = {
  de_ancient: `MAP NOTES — Ancient:
- Key callouts: Mid (Top/Bottom), Xbox, Elbow, Red, Donut; A Main, Big Box, Plat, Triple, Temple, CT; Cave, B Ramp, Pillar, Square, Alley, House
- T: Default is 2-3: two hold A Main, three fight for mid and Donut control (Red smoke, Donut molly, flashes) — Donut threatens both sites. A execute: smoke CT, Temple and Donut, flash over A Main, molly default/under Temple, one player splits through Donut. B execute: Cave+Ramp split — Cave smoke is the priority, plus Doors/Long smokes, Pillar molly, flashes over from Ramp.
- T force/pistol: B Ramp flood with one Long smoke and double flash over; A Main double-flash rush to Big Box plant; silent Cave contact play off mid.
- CT: 2-1-2 (or 1-2-2 double mid): A Main contact + Temple/site anchor, Red/Snipers Nest holds mid, Cave + Ramp crossfire on B. Util goes to denying Donut takes (mid smoke/molly) and delaying Ramp (molly). Longest rotates in the pool (~15s) — call early; retake A via CT/Temple/Donut, B via House/Alley/Cave.
- Reads & timings: mid fight at 15-20s decides the round; Cave plywood wallbang spam for info; no mid presence by 0:30 means A Main default or B lurk; always check for the Donut lurker. Aug 2025 rework was visual — layout unchanged, but Temple's deep A Main angle is gone, so CTs contest A Main from Donut/util now.
- Change-ups: T — loud A util fake into B Ramp explode; slow double-lurk round. CT — 3-B stack with Cave aggression; mid push to Elbow; B tree boost.`,
  de_anubis: `MAP NOTES — Anubis (post-Jan-2026 rework: Drop moved beside Mid Doors, Doors reversed, E-box hole to Back B, A crates up on Walkway, scaffolding blocks Heaven-Camera):
- Key callouts: Mid (Top Mid, Doors, Bridge, Drop, Connector, Palace); Water/Canal (Boat, Arches, Dark, Upper); A (Main, Fountain, Walkway, Heaven, Camera, Tunnel); B (Long, Gate, Ruins, Pillar, E-box/Con, Back Site, Ninja, Street, Sniper, Cave)
- T: Default 1-3-1 (Alley/Main lurk, three Top Mid, one Water). Mid is now a real choke — reversed Doors give CTs safe peeks and Drop sits beside Doors, so spend Doors smoke plus double flash to win it. A exec: smoke Heaven, Camera, Connector; molly default; flash over Main. B exec: smoke Street and Con, flash Gate, molly Pillar/Back Site. Splits: Mid+Main onto A; Water-to-Dark plus Long onto B.
- T force/pistol: B Long flood with two Gate flashes; quiet Water/Arches contact onto A Main saving smokes for the plant.
- CT: 2-1-2 (Heaven+site A, Doors mid, Sniper+Street B). Walkway crates and scaffolded Camera make A holds and retakes stronger; B anchor feeds nades through the new E-box hole to Back B. Util: Top Mid smoke, Drop/Water molly, Long molly. Retakes: A via Tunnel-Heaven plus CT with Camera smoke; B via Cave plus Street.
- Reads & timings: Doors contact ~15s; Water splashes telegraph canal splits; silence means Long lurk plus late mid hit; whoever owns Drop owns the tempo.
- Change-ups: T — skip mid, double-stack Water; CT — pair-push Doors onto Drop/Boat early, or 3-stack B off Long reads.`,
  de_dust2: `MAP NOTES — Dust2:
- Key callouts: Long Doors/Blue/Pit/A Cross/Ramp/Goose/Car (A side); Catwalk-Short/Stairs/Short Boost; Top Mid/Xbox/Mid Doors/Suicide/CT Mid; Upper-Lower Tunnels/Close/B Doors/B Window/B Plat/Back Plat/B Car.
- T: default is 1 long, 1-2 mid behind the Xbox smoke off spawn, 2 tunnels plus a lurk. Main hits: long take (flash doors, smoke cross + CT, trade through pit, pair with a short split); B execute from upper (smoke B doors + window, flash over the wall, molly back plat); mid-to-B split (smoke CT mid, hit doors and tuns on one count).
- T force/pistol: B flood upper with two flashes over is the classic pistol; deagle long with one flash each; contact B with zero util when CTs expect noise.
- CT: 2-1-2 — AWP mid doors is the backbone, two long (pit + car/site), short player can solo self-boost on the boxes below short, two B (window/closet + car/plat). Util delays long (molly doors) and re-smokes B doors for retakes; retake A from CT + short, B from doors + window.
- Reads & timings: long doors duel around 15s; Xbox smoke off spawn signals mid/cat interest; total silence with no long contact means B rush or lower-tuns lurk; watch lower tunnels mid-round.
- Change-ups: T — double-AWP long, lower-tuns sneak, fake long then re-tunnel B. CT — 3-stack long flash push to blue, B-tuns aggro pair, smoke mid doors and push top mid. Apr 2026 update rebuilt Xbox taller (crouch-climb now hidden from short); layout otherwise classic.`,
  de_inferno: `MAP NOTES — Inferno:
- Key callouts: Banana (Car, Logs, Sandbags), B site (Coffins, Dark, New Box, Oranges, CT), Mid (Top Mid, Alt Mid, Underpass, Boiler), A side (Apps, Balcony, Pit, Arch, Library, Moto, Short, Truck)
- T: default keeps banana presence, apps control, mid lurk every round. B exec: smoke CT and Coffins, molly New Box/Dark, flash over Sandbags. A exec: apps+Short split — Moto, Library, Arch smokes, Pit molly, roof flashes from Second Mid. Graveyard is barred (Mar 2026): A post-plants live in Pit/Apps/Top Banana now, no graveyard cross.
- T force/pistol: five-man banana flood with flashes, plant open for banana; apps rush with Boiler/Balcony flashes, plant for Pit, play Close; nade-stack Sandbags to punish the CT banana molly.
- CT: 2-1-2 — B duo wins banana with car molly + re-flash around 15s, Arch/mid flex, A pair Close Apps/Boiler plus Pit-Site crossfire. A retakes are genuinely playable now (Graveyard barred, Balcony extended, Pit wall raised): retake via Arch + Library with util. B retakes use the opened Church windows above Coffins. Banana control controls the map.
- Reads & timings: CT molly hits Car ~13-18s — whether Ts re-contest or peel is the round's first read. Apps hits land ~25-35s. Alt Mid window reachable only via balcony (boost removed), so window peeks come slower. A "B exec" without CT+Coffins smokes is a fake.
- Change-ups: T — full A-util fake into empty banana, five-apps timing hit, late slow-default exec. CT — banana double-aggression to Car, Boiler-flash apps push, 3-A stack conceding banana for retake.`,
  de_mirage: `MAP NOTES — Mirage:
- Key callouts: A — Palace, Ramp, Tetris, Firebox, Stairs, Triple, Jungle, CT, Ticket; Mid — Top Mid, Window, Connector, Catwalk, Underpass, Ladder; B — Apps, Kitchen, Van, Bench, Market, Arches, Short, E-box.
- T: layout unchanged through mid-2026. Default is 1 Palace, 3 mid (Top Mid plus Underpass), 1 Apps. The spawn Window smoke anchors every round — it unlocks mid and both splits. Main hits: A execute (smoke CT, Jungle, Stairs, molly Firebox, flash over Ramp with a Palace split); mid-to-A through Connector; B execute (smoke Market window and door, molly Van, flash over Apps).
- T force/pistol: Apps B rush with two flashes and a Van molly; three-man Underpass to Cat behind Window and Connector smokes; full-five A Ramp contact hit on pistol.
- CT: 2-1-2 — Ramp/Tetris with Jungle/CT crossfire, Window AWP mid, Bench/Van anchor plus Market/Short. Early util: Top Mid smoke, Apps-ramp molly, Palace molly on timing. Rotate via CT and Connector; B retakes (Market, Short, CT) strongly favor CTs; Window control controls the map.
- Reads & timings: Underpass presence means a lurk to Connector or Short later. Count smokes — CT, Jungle, Stairs landing means A hit. Apps contact around 1:35 signals B pace; a quiet map past 1:00 signals late split. Window AWP dying collapses mid.
- Change-ups: T — full A-smoke fake then five through Apps; Palace stack; sneaky E-box plant. CT — Cat push off Top Mid smoke, duo flashing through Apps, three-A stack with Palace molly.`,
  de_nuke: `MAP NOTES — Nuke:
- Key callouts: Outside (Silo, T Red, Garage, Secret, Mini), Lobby/Radio/Trophy into Ramp (Headshot, Turnpike); A: Squeaky, Hut, Main, Heaven, Rafters, Hell; B: Vents, Window, Decon, Doors, Dark, Toxic.
- T: take Ramp and Lobby control first, then commit. Main executes: A hit through Hut+Main with Heaven and Rafters smokes, Mini flash, Tetris molly; Outside take behind a three-smoke wall (Garage, CT Red, Secret) into Secret for B or Main for A; Ramp B with top-ramp smoke, Headshot molly, vents pair dropping in. Executes live or die on synced timing — Nuke punishes stragglers harder than any map.
- T force/pistol: five-man Squeaky/Hut flash rush; Vents flood with flash dropped to B; Lobby P250 rush to Ramp; Silo run for an Outside pick.
- CT: 2-1-2 (Heaven plus site on A, one Garage/Outside, two Ramp/B). Util goes to Ramp delay (Radio incendiary, fallback smoke), Squeaky molly, Outside crossing smokes. Retake A via Heaven/Hut/Main; B via Vents drop, Secret, or Window. Outside plus Ramp control decides the map; 5-second A-to-B rotates through Vents/Hell keep stacks honest.
- Reads & timings: early Squeaky open or Silo AWP = info round; Garage smoke around 0:15 telegraphs Outside take; vent audio telegraphs B; no contact by 0:30 means late split — save CT util. Listen for Doors opening and Top Red boosts.
- Change-ups: T — fake Outside then flip through Lobby to A; delayed vents drop after A noise. CT — three-man Outside contact push to T Red; Lobby flush flashes; double-AWP yard; B stack versus vent-heavy teams.`,
  de_overpass: `MAP NOTES — Overpass:
- Key callouts: A: Long, Toilets/Bathrooms, Dice, Truck, Bank, Stairs (A Short); Mid: Fountain, Party, Playground, Connector; B: Monster, Water, B Short, Squeaky, Bridge, Heaven, Pit, Barrels, Pillar.
- T: 3-1-1 default — three take Fountain/Party, one Toilets-Long, one lurks B Short. A hit: early Bathrooms smoke, take Long past Dice, then Bank + Stairs smokes, flash over, plant Default. Mid split: win Connector with flashes, hit Stairs + Long together. B hit: Heaven smoke (from B sign in Short), Pit molly, double flash out Monster; or Short+Monster split using Bridge smoke from the Connector woodpile.
- T force/pistol: Monster glock flood with one flash, plant for Short cross; Long rush off a Toilets flash; quiet B Short sneak — Water is dry since the rework, no splash audio.
- CT: 2-1-2 — Toilets/Long + Bank on A, Connector flex, Monster + Heaven on B. Incendiary + smoke Monster every round; flash the Toilets push for Long info. Connector controls the map: A-B rotation 6-7s. Retake B via Heaven (drop straight down post-rework) plus Water; retake A via CT/Stairs and Long. Map is CT-leaning (~55%).
- Reads & timings: Long/Toilets contact ~10-15s, Monster rush contact ~12s. Heaven smoke = B execute, Bank smoke = A, prolonged silence = late split. Watch Fountain boosts, Squeaky audio, Connector fights.
- Change-ups: T — fake B noise then fast A through Tunnels; 5-man mid take. CT — 4-A stack with solo Heaven on deep Monster smokes; B Short push to Party; Monster lurk to Tracks.`,
  de_train: `MAP NOTES — Train:
- Key callouts: A Main, Ivy, Pigeons, Alley, Pop Dog, Underpass, Connector (Z), E-Box, Olof, Hell, Sandwich, Bomb Train, Brown Halls, Showers, B Ramp, Upper B (Hut), Oil, Sidewalk, CT Stairs. (Post-2024 rework: Pop Dog ladder and old Heaven are gone; Underpass links Pop Dog to B Halls.)
- T: Default 2 A Main, 1 Ivy, 1 Pop Dog, 1 roamer — pressure follows the roamer. A execute: smoke Ivy, Connector, Pop Dog and cross from spawn, flash over Main, clear Olof/E-Box/Sandwich, plant Bomb Train. B hit: Brown Halls/Showers split, smoke Z, flash or molly the Upper B hut (it sees past a Ramp smoke), trade down Ramp. Underpass control sets up A/B splits.
- T force/pistol: A rush is the strongest cheap play — one cross smoke plus team flashes, five Main, post-plant E-Box/Olof. Alt: five-man B Ramp flood with a single Z smoke.
- CT: 4-1 (Main, Ivy, Pop Dog, Connector AWP; lone B passive for retake) or 3-2. Early molly Pop Dog, smoke/molly A Main versus the rush. Connector is the rotation hub — losing Z loses the map. Retake A via Z plus CT Stairs/Ivy; B via Z plus Upper. 2025 boxes (Yard, outside Z, Upper halls) give CT cover.
- Reads & timings: util on Ivy inside 15-20s = A interest; early Pop Dog smoke = A hit or split; quiet past 40s = late full-util execute; B Halls steps tip the Upper player. Slightly CT-sided (~53%).
- Change-ups: T — loud A fake, collapse Underpass into B; Ivy-heavy split. CT — flash-push Ivy to Pigeons for info; early B Halls press; A stack versus forces.`,
  de_vertigo: `MAP NOTES — Vertigo:
- Key callouts: A: Ramp, Sandbags, Scaffold, Double, A Short/Lane, Elevator, Door, Heaven, Headshot; Mid: Top Mid, Boost, Connector; B: B Stairs, Generator, Back B, Electric Box, Catwalk. (Current layout = May 2024 rework: walkway behind Headshot to back of A, Elevator-to-Short door, Heaven-Elevator hallway removed.)
- T: Default three toward Ramp/Top Mid for info, lurk B Stairs. Main A execute: smokes cutting Heaven and Elevator plus CT smoke, molly Sandbags, flash over the wall, five up Ramp, plant for Ramp cover. Mid take (smoke Elevator/Door and CT Spawn) opens the B split through Connector/Catwalk with a B Stairs flood, or an A split via Short.
- T force/pistol: B Stairs flood with two flashes, plant behind Generator; Ramp all-in off one run-throw Ramp smoke; mid Boost pick with Deagles, then react.
- CT: 2-1-2 — Ramp plus site on A, Elevator/Door mid, Stairs plus Back B. Round-start Ramp smoke and Sandbags molly stall the hit; B molly on the Stairs wall. Ramp control decides the map. Retake A from Elevators/Heaven, B from CT Spawn and Catwalk.
- Reads & timings: rush contact at Sandbags ~12-15s; no Ramp pressure by 0:20 means B or a mid split; B Stairs footsteps and ladder drops are loud — trust sound; count CT ramp util and re-hit once smoke/molly are burned; watch Door peeks into Short.
- Change-ups: T — fake Ramp util then wrap B Stairs; late Ramp re-hit; double-fake mid. CT — three-man Ramp push with flashes; B Stairs double peek; A stack leaving mid to a spawn player.`,
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
 * Researched June 2026 alongside the briefings above.
 */
const MAP_PLAYBOOKS: Record<string, { T: string[]; CT: string[] }> = {
  de_ancient: {
    T: [
      "Donut default: three fight mid with Red smoke + Donut molly, two hold A Main, hit weak site late",
      "A split execute: smoke CT, Temple, Donut; double flash over A Main; one through Donut; default plant",
      "B split explode: Cave smoke priority plus Doors/Long, Pillar molly, flash over Ramp, Cave and Ramp commit together",
      "Cave rush: fast mid to Cave, entry flashes, CT smoke, Pillar molly; Ramp pair joins on contact",
      "Fake A into B: dump A util loud, four sneak T Lower to Ramp, punish the 15-second rotate",
      "Pistol B flood: one Long smoke, double flash over Ramp, all five commit, plant for Ramp/Cave crossfire",
      "A Main force: single CT smoke, double flash, plant behind Big Box, post-plant Main and Donut",
      "Slow double-lurk: hold mid and Ramp quiet, late Donut take with smoke, pinch A on rotation noise",
    ],
    CT: [
      "Standard 2-1-2: A Main contact plus Temple anchor, Red holds mid, Cave and Ramp crossfire B",
      "Mid lock 1-2-2: double mid owns Donut with smoke and molly, solo Temple anchor, punish mid takes",
      "Cave aggression: B pair flashes through Cave early, wallbang the plywood for info, fall back to crossfire",
      "B stack: three B with Ramp molly and Cave smoke, AWP Red, A anchor plays retake from Temple",
      "Donut sweep: mid plus A player flash through Donut to Elbow, catch the A Main lurk, reset fast",
      "Tree boost: B player boosted on tree over Ramp for one pick, drops, Cave partner covers fall-back",
    ],
  },
  de_anubis: {
    T: [
      "A exec: smoke Heaven, Camera, Connector, molly default, double flash over Main, five hit, plant for Main cross",
      "Mid-A split: Doors smoke plus double flash, take Bridge and Connector, three Main two Con, pincer Heaven",
      "B Long flood: smoke Street and Con, flash over Gate, molly Pillar and Back Site, all five commit",
      "Water B split: two Canal to Dark, three Long, Street smoke, sync contact both ways, plant for Long cross",
      "Default 1-3-1: Alley lurk, three Top Mid pressuring Doors, one Water; gather reads, late-round call",
      "Drop fight: double flash Doors, win Drop and Bridge, hold murder hole, then slow Connector-A hit",
      "Pistol B rush: all five Long, two flashes over Gate, plant default, set Gate-Street crossfire",
      "Force A contact: no early util, sneak Water and Arches into Main, save smokes to deny retake",
    ],
    CT: [
      "Standard 2-1-2: Heaven plus site A, Doors mid, Sniper plus Street B; smoke Top Mid, molly Drop",
      "Mid pair: AWP plays reversed-Doors angles, partner watches Drop; re-aggress Water once Ts rotate",
      "Water push: two through Doors onto Drop and Boat with flash, steal Canal, ambush A Main timing",
      "E-box anchor: B player holds Con, feeds nades through new hole to Back B, Sniper trades",
      "A crossfire: Camera behind scaffolding plus Walkway crates, silent Heaven; molly Main on first contact",
      "B stack: three B off Long-lurk reads, Cave rotator ready, molly Long, Sniper locks Gate",
    ],
  },
  de_dust2: {
    T: [
      "Long take: flash long doors, smoke A cross + CT, trade through pit, plant open for long",
      "B flood: smoke B doors + window from upper, double flash over, all five commit, plant for tuns",
      "Mid-to-B split: Xbox smoke off spawn, smoke CT mid, hit B doors and tunnels on one count",
      "A split: cat control behind Xbox smoke, smoke CT + cross, molly car and goose, hit short + long together",
      "Pistol B rush: full flood upper tuns, two flashes over wall, plant default behind big box",
      "Long force: deagles, one flash each, win doors duel, slow-clear pit, hit A late",
      "Contact B: no util, walk upper tuns, clear close together, save smokes for after-plant",
      "Lower lurk fake: four make long noise, lurker mid-to-lower tuns, late B hit with smokes",
    ],
    CT: [
      "Standard 2-1-2: AWP mid doors, pit + car on long, short self-boost, window + plat on B",
      "Long 3-stack: flash push to blue and doors at 15s, win first contact, fall back to pit and site",
      "B tuns aggro: two push upper with flash + molly for info, then fall to window and car",
      "Mid lock: smoke mid doors from CT, short player pushes top mid for cat control and timing info",
      "Double AWP: doors + long crossfire, force Ts toward B, restack B on first read",
      "A heavy 3-1-1: third on short boost, solo B car anchor plays time, mid rotates on sound",
    ],
  },
  de_inferno: {
    T: [
      "B banana blast: smoke CT and Coffins, molly New Box, double flash over Sandbags, all five plant for banana",
      "A apps split: Moto, Library, Arch smokes, Pit molly, roof flashes from Second Mid, hit Balcony and Short together",
      "A fake into B: throw full A util from apps and Second Mid, zero commit, five sprint through empty banana",
      "Slow default: early car molly, hold Top Banana and apps, lurk Underpass, save util, late B exec on rotation read",
      "Pistol B flood: stack flashes over banana, five commit, plant open for banana, post-plant Dark and Oranges",
      "Apps timing rush: clear Boiler, Balcony pop flash, Pit molly, five through apps, plant for Pit, hold Close",
      "Banana bait punish: show banana, eat the CT molly, then nade-stack Sandbags, flash through and run them down",
      "Mid-short squeeze: take Top Mid, smoke CT and Library, lurker holds Underpass flank, hit Short while apps fakes",
    ],
    CT: [
      "Standard 2-1-2: B duo molly car ~15s plus re-flash, Arch flex mid, A pair Close Apps and Pit-Site crossfire",
      "Banana takeover: double B, smoke Half-Wall, molly Logs, push to Car for info and timing, peel off after",
      "Apps aggression: Boiler pop flash, two swing T apps for a pick, fall back to Balcony-Site hold",
      "A-heavy 3-2: third man Library/Moto, concede banana, trust the buffed A retake — Graveyard barred means fewer clears",
      "B retake default: anchor plays Dark/New Box passive, retake through Garden using the new Church windows over Coffins",
      "Mid info push: early flash Top Mid, one swings to Second Mid door for T-spawn read, then resets",
    ],
  },
  de_mirage: {
    T: [
      "Standard A execute: smoke CT, Jungle, Stairs, molly Firebox; flash over Ramp, Palace pair out same time, plant Default",
      "Mid split A: Window smoke, trio takes Top Mid, smoke Stairs and CT, hit Connector and Ramp together",
      "B apps flood: smoke Market window and door, molly Van, double flash over Apps, all five commit",
      "Cat-to-B split: Window smoke, take Catwalk, smoke Market and Arches; Short trio times hit with Apps duo",
      "A fake to B: throw full A smokes and Ramp flashes, then all five fast through Apps",
      "Palace pop: stack Palace, one Ramp body for noise, mass flash out Palace, trade onto Triple and Default",
      "Pistol B rush: light buy, two flashes over Apps balcony, clear Van and Bench, plant for Market cross",
      "Force underpass stack: smoke Window and Connector from spawn, three sneak Underpass, pop Cat into B Short",
    ],
    CT: [
      "Standard 2-1-2: Ramp crossfire with Jungle, Window AWP, Bench anchor plus Market; smoke Top Mid, molly Apps early",
      "Cat push: Window smokes Top Mid, duo flashes up Catwalk, grab Boxes info, reset on first contact",
      "Apps aggression: B duo mollies Apps ramp, flashes into Apps for early pick, falls back to Van and Bench",
      "A stack: three across Tetris, Jungle, Ticket with Palace molly on timing; Market player retakes B with CT rotate",
      "Mid lockdown: Connector and Cat bodies support Window AWP, molly Underpass at 1:30, rotate through Mid on reads",
      "Window jump-peek: AWP takes early Top Mid pick with Connector flash support, repositions immediately after the shot",
    ],
  },
  de_nuke: {
    T: [
      "Outside wall: smoke Garage, CT Red, Secret; four cross to Secret, drop B, plant facing Doors",
      "A execute: Heaven and Rafters smokes, Mini flash, Tetris molly; squeaky pair plus Main trio pincer",
      "Ramp B take: smoke top ramp, molly Headshot, flash over; five down, plant Dark, hold vents",
      "Vents flood (pistol/force): squeaky to vents, flash the drop, all in B; one watches ramp flank",
      "Silo pop: AWP up Silo/Top Red for Outside pick, rest default Lobby, re-decide off it",
      "Secret sneak: quiet Outside run, one Secret smoke, lurker watches Garage; split B with ramp pair",
      "Fake Outside, flip A: show smokes and bodies yard, rotate Lobby, hit Hut behind Heaven smoke",
      "Squeaky pistol rush: flash door, all five through Hut and Main, plant open, play Hell cross",
    ],
    CT: [
      "Standard 2-1-2: Heaven plus site A, one Garage/Outside, two Ramp-B; util spent delaying Ramp",
      "Ramp delay: incendiary bounce to Radio, jiggle Box for info, smoke fallback to B",
      "Heavy Outside: three contact-push toward T Red early with smokes, collapse inside if it dies",
      "Lobby flush: molly Squeaky, double flash, two push Lobby/Radio for info, fall back to crossfires",
      "Double-AWP yard: Garage plus Main/Heaven AWPs lock Outside, rifles anchor Ramp and site",
      "B stack read: versus vent-heavy teams put three at Window/Dark/Toxic, smoke Doors on the hit",
    ],
  },
  de_overpass: {
    T: [
      "Monster flood: Heaven smoke from B sign, Pit molly, double flash out Monster, five commit, plant for Short cross",
      "B split: Bridge smoke from Connector woodpile plus Heaven smoke, two Short two Monster, lurker watches Connector flank",
      "A long take: early Bathrooms smoke, clear Dice, then Bank and Stairs smokes, flash over, plant Default",
      "Mid split A: flash Connector and take it, smoke Bank and Toilets, hit Stairs plus Long on one call",
      "3-1-1 default: three Fountain-Party, one Toilets-Long, lurk B Short; trade picks, hit the weak site late",
      "Pistol B rush: one flash over Monster, all five flood, plant open, crossfire Heaven and Short for exits",
      "Quiet Long: no util, walk behind Toilets, contact-peek Bank, save smokes for post-plant Connector and Stairs",
      "Fake B pop A: throw noise util at Monster, four sprint Tunnels to Long, instant Bank smoke and go",
    ],
    CT: [
      "Standard 2-1-2: Toilets-Long and Bank on A, Connector flex, Monster plus Heaven B; incendiary Monster every round",
      "Toilets push: two flash through Bathrooms ~15s for Long info, fall back to Dice-Bank crossfire",
      "B Short aggression: pop Squeaky early, smoke and take Party, duo collapses via Water, re-anchor on contact",
      "Monster lurk: incendiary first, then walk Tracks for exit frags while Heaven AWP covers the drop",
      "4-A stack: solo B plays Heaven with deep Monster smokes to delay, rest stack Long and Stairs",
      "B retake: drop Heaven straight down (post-rework), pair with Water-Short push, clear Pit then Pillar",
    ],
  },
  de_train: {
    T: [
      "A cross rush: cross and Ivy smokes from spawn, flash over Main, five hit, clear Olof/E-Box, plant Bomb Train",
      "Full A exec: smoke Ivy, Connector, Pop Dog, cross; flash Main, trade through Sandwich, plant for Main cover",
      "Pop Dog split: take Underpass quiet, smoke Connector, hit A from Pop Dog and Main simultaneously",
      "Ivy take: flash through Pigeons, smoke CT Stairs and Old Bomb, hit A from Ivy and Main together",
      "B ramp flood: smoke Z, molly Oil and Hut, flash Upper, five through Ramp, plant for Halls",
      "Upper-lower B split: Showers and Brown Halls pincer, smoke Z, flash the Hut, trade entries, plant Oil-side",
      "Underpass B sneak: loud fake at A Main, four collapse Pop Dog-Underpass into B Halls, fast plant",
      "Roamer default: 2 Main, 1 Ivy, 1 Pop Dog plus roamer; execute wherever the roamer finds it thin",
    ],
    CT: [
      "Standard 4-1: Main, Ivy, Pop Dog, Connector AWP; lone B plays passive retake, save smokes for Z",
      "Anti-rush A: molly Main mouth, smoke cross at 10s, E-Box/Olof crossfire — punish the five-man flood",
      "Pop Dog molly default: auto-molly Pop Dog early, Connector AWP watches both exits, rotate off info",
      "Ivy press: flash-push Ivy toward Pigeons/Dumpster for an info kill, fall back on first contact",
      "B halls press: Upper player flashes Brown Halls/Showers early with Ramp support, reset passive after info",
      "Z stack: AWP plus rifle behind Connector boxes, concede site, retake-heavy through Z and Upper with saved util",
    ],
  },
  de_vertigo: {
    T: [
      "Ramp execute: smoke Heaven and Elevator plus CT, molly Sandbags, flash over wall, five up Ramp, plant for Ramp",
      "Generator B hit: T-spawn smokes both sides of Generator, molly Back B, double flash over Stairs, plant default",
      "Mid-to-B split: smoke Elevator and CT Spawn from Mid, three through Connector and Catwalk, two flood B Stairs",
      "Short A split: take Top Mid, smoke Door and CT, hit A Short and Ramp together, crossfire the plant",
      "Ramp re-hit: poke Ramp early to burn CT smoke and molly, regroup, full execute at 1:00 with saved util",
      "Run-smoke ramp control: run-throw Ramp smoke, take Sandbags free, hold for a late site hit",
      "Mid fake, B wrap: loud util and bodies Top Mid, lurker holds, all five hit B Stairs at 0:45",
      "Pistol B flood: two flashes over B Stairs, all five commit, plant behind Generator for Catwalk cross",
    ],
    CT: [
      "Standard 2-1-2: Ramp plus site on A, Elevator mid, Stairs plus Back B; round-start Ramp smoke, Sandbags molly",
      "Ramp push: three A players flash over Sandbags, take Ramp to bottom, mid covers the Door flank",
      "B Stairs double peek: molly Stairs wall first, two swing wide with flash, Catwalk player trades",
      "Door flash peek: mid CT opens Elevator-Short Door, flashes Short, crossfires Ramp-walkers with the Sandbags player",
      "A stack read: leave mid to a spawn player, four on A, double-smoke Ramp on contact",
      "Retake protocol: A from Elevators and Heaven with Ramp smoke; B from CT Spawn and Catwalk, flash and trade",
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
