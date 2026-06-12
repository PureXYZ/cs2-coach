import type { MatchContext } from "../gsi/tracker.js";

// Canned lines, persona: a dry, sarcastic, perpetually unimpressed coach —
// the user's explicit preference (consensual roast). The informational payload
// (buy calls, retake/save, scores, clocks) must survive every joke; sarcasm is
// the wrapper, never the content. Authored via a writers-room pass (4 comedic
// lenses → per-group judges → voice unifier), then hand-curated.

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

interface BagState {
  /** Indices into the pool still unplayed this cycle; consumed from the end. */
  remaining: number[];
  /** Index spoken most recently, so a fresh cycle never opens with it. */
  last: number;
}

const bags = new Map<string, BagState>();

/**
 * Shuffle-bag pick: every line in the pool plays once, in random order, before
 * any line repeats — and a new cycle never starts with the line that just ended
 * the previous one. Keyed by pool name (not contents, since many pools
 * interpolate scores), state lives for the process so it spans rounds and matches.
 * Exported for the LLM coach's rotating strategy angles — same fairness rules.
 */
export function pick(poolName: string, pool: string[]): string {
  if (pool.length === 1) return pool[0];
  let state = bags.get(poolName);
  if (!state) {
    state = { remaining: [], last: -1 };
    bags.set(poolName, state);
  }
  if (state.remaining.length === 0) {
    state.remaining = shuffle([...pool.keys()]);
    const top = state.remaining.length - 1;
    if (state.remaining[top] === state.last) {
      const j = Math.floor(Math.random() * top);
      [state.remaining[top], state.remaining[j]] = [state.remaining[j], state.remaining[top]];
    }
  }
  const index = state.remaining.pop()!;
  state.last = index;
  return pool[index];
}

const MAP_NAMES: Record<string, string> = {
  de_ancient: "Ancient",
  de_anubis: "Anubis",
  de_dust2: "Dust 2",
  de_inferno: "Inferno",
  de_mirage: "Mirage",
  de_nuke: "Nuke",
  de_overpass: "Overpass",
  de_train: "Train",
  de_vertigo: "Vertigo",
  cs_office: "Office",
  cs_italy: "Italy",
};

/** GSI gives raw tokens like "de_dust2"; TTS would read that as "de underscore dust two". */
function mapDisplayName(raw: string): string {
  // Workshop maps arrive as "workshop/3070284539/de_cache" — keep only the map token.
  const token = raw.split("/").pop() ?? raw;
  const known = MAP_NAMES[token.toLowerCase()];
  if (known) return known;
  return token
    .replace(/^(de|cs|ar)_/i, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function matchStartLine(rawMap: string): string {
  if (!rawMap || rawMap === "unknown") {
    return pick("matchStartNoMap", [
      "Game found. Map's a mystery, much like your positioning.",
      "Somewhere a server found us a map. Walk in like you've practiced. Lie if needed.",
      "Queue popped, destination unknown. Lower your expectations now to save time later.",
    ]);
  }
  const map = mapDisplayName(rawMap);
  return pick("matchStart", [
    `New match on ${map}. Expectations set at sea level. Climb if you can.`,
    `Welcome to ${map}, where your stats historically go to die. Prove the trend wrong.`,
    `${map} again. The map's not the problem, but sure, let's blame it anyway.`,
    `Loading into ${map}. Set your hopes to moderate and your crosshair to head level.`,
    `My ${map} notes from your last game are mostly sighs. Let's add a page.`,
  ]);
}

/** Economy advice for freezetime, from own money/equipment + team loss streak. */
export function economyLine(ctx: MatchContext): string | null {
  const money = ctx.money;
  if (money === undefined) return null;
  const equip = ctx.equipValue ?? 0;
  const losses = ctx.ourLossStreak ?? 0;

  // Pistol rounds first: the generic ladder reads $800 as "eco" and starts
  // talking about saving — on a round where everyone is equally broke by design.
  if (ctx.roundKind === "pistol") {
    return pick("ecoPistol", [
      "Pistol round. Armor or util, pick one, and play it together as five.",
      "Eight hundred each. Kevlar or nades — choose, then stick with the team.",
      "Pistol time. Don't get cute solo, the team that groups up wins this one.",
    ]);
  }
  // Their match point: lose this round and the match ends — "save for next
  // round" is advice about a round that won't exist.
  if (ctx.matchPoint === "them") {
    return pick("ecoMustWin", [
      "Their match point. A save means GG — buy whatever you've got and go win it.",
      "Lose this and we're done. Money stopped mattering, spend it and fight.",
      "No next round to save for. Force everything, this is the whole match.",
    ]);
  }
  // Last round before a money wipe (half end, overtime boundaries): saved cash
  // and gear evaporate, so the only wrong buy is no buy.
  if (ctx.moneyResetsNextRound) {
    return pick("ecoSpendReset", [
      "Money's gone after this round anyway. Spend all of it, force it up.",
      "Wallet resets next round — saving now is donating to nobody. Buy everything.",
      "Last round before the reset. Empty the account, every dollar dies at the swap.",
    ]);
  }

  if (equip >= 3500) {
    return pick("ecoKitted", [
      "Already fully kitted. Try not to donate that rifle to their economy.",
      "Full loadout already. The gun stays with you this round. Novel concept.",
      "Nothing to buy. Just don't hand them the rifle this time, it skews my spreadsheet.",
      "Treat that rifle like rent money. You're set, so don't throw it away.",
      "Everything's bought. This is usually when you run it down mid. Break the pattern.",
      "Kitted out. Protect that gun like it's the last one. It might be.",
      "No shopping needed. Keep the rifle out of enemy hands. That's the whole assignment.",
    ]);
  }
  if (money >= 4700) {
    return pick("ecoFullBuy", [
      "You're rich. Rifle, armor, full utility. Spend it. Money wins nothing sitting there.",
      "Big bank this round. Full buy. Yes, the grenades too. They do things.",
      "Over forty-seven hundred in the bank. Full buy, no hoarding. Money can't aim, but it helps.",
      "Quit sitting on the pile. Full buy: rifle, armor, grenades, the works.",
      "Spend it all. A rich player with no nades is just a sad rich player.",
      "Flush for once. Rifle, armor, and the grenades. Broke isn't your excuse this round.",
      "Buy everything. Rifle, vest, helmet, grenades. This isn't a retirement fund.",
    ]);
  }
  if (money >= 3700) {
    return pick("ecoBuy", [
      "Rifle and armor. Utility if the math works. It rarely does for you.",
      "You can afford a real gun. Rifle, armor, maybe a nade. Growth.",
      "Grab the rifle and the vest. Utility's optional, hitting shots apparently is too.",
      "Mid-tier money: rifle, armor, a flash if it fits. The flash works better when actually thrown.",
      "Today's drill: rifle, armor, utility if the budget smiles. We practiced this. Allegedly.",
      "Enough for a rifle and a vest. Squeeze in utility if you can. Miracles not included.",
      "Get armored and rifled up. Spare change goes to grenades.",
    ]);
  }
  if (money <= 1800) {
    if (losses >= 2) {
      return pick("ecoSaveStreak", [
        "Full save. The loss bonus is the only thing improving here. Real buy next round.",
        "Another loss, another payout. Save again, the real buy lands next round.",
        "Pockets empty, morale emptier. Save this one, the bonus money funds next round's buy.",
        "Silver lining to all this losing: max loss bonus. Full save now, full buy next.",
        "Stack the loss bonus, save now, buy properly next round. Losing strategically, your specialty.",
      ]);
    }
    return pick("ecoSave", [
      "Account's at zero. Eco round: pistol at most, hunt a pick, don't gift them a rifle.",
      "Eco time. The plan is taking their guns, not handing over yours.",
      "Broke again. Pistol or nothing. Sneak a pick, exit breathing. That's the dream.",
      "Save round. Maybe a pistol. The enemy doesn't need handouts, they're beating you for free.",
      "Wallet's empty. Pistol and a prayer. Play for picks, exit alive.",
      "Can't afford feelings, let alone rifles. Eco: picks and survival only.",
      "Pistol round by poverty. Play for picks together, don't feed them free rifles.",
    ]);
  }
  return pick("ecoAwkward", [
    "Awkward money. Force or save, but with the team. Solo forcing is charity.",
    "Money's in between. Match the team's call. Buying alone helps exactly one team, theirs.",
    "Tricky number. Do whatever the team does. A lone force has never once worked for you.",
    "Half-buy territory. Force together or save together. The economy is a group project.",
    "Team forces, you force. Team saves, you save. Independent thought stays holstered.",
  ]);
}

export function bombPlantedLine(ourSide: string | undefined): string {
  if (ourSide === "CT") {
    return pick("plantedCT", [
      "Bomb's down. Forty seconds. Group up and retake together. Trickling in is a queue to die.",
      "That's a plant. Collect your teammates and hit it together. One-man retakes have a known ending.",
      "Live bomb, our problem. One regroup, one call, one retake. Together.",
      "Enemy plant. Retake as a unit — single-file entries just pad their stats.",
      "Forty seconds to retake. Gather the team first, then go. In that order.",
    ]);
  }
  if (ourSide === "T") {
    return pick("plantedT", [
      "Plant's down. Set crossfires, let the clock work. Re-peeking is how leads get refunded.",
      "Down and ticking. Sit in your crossfire and do nothing. You're great at nothing.",
      "We planted. The clock fights for you now — hold the crossfire and hush.",
      "Good, it's planted. Don't re-peek the kill you already won. Hold your angle.",
      "Timer's doing the work now. Crossfire up, stay patient, every re-peek lowers our win probability.",
    ]);
  }
  // Side unknown (e.g. just reconnected) — stay neutral.
  return pick("plantedNeutral", [
    "Confirmed plant. The round has a deadline now.",
    "Somebody planted. Forty-ish seconds of consequences incoming.",
    "Heads up, the bomb's down. Clock's running for someone.",
  ]);
}

export function bombDefusedLine(ourSide: string | undefined): string {
  if (ourSide === "CT") {
    return pick("defusedCT", [
      "Defused. You actually stole that round. I'm mildly startled.",
      "Clipped the wires and their hopes. Fine, that was good.",
      "Kit on the stick, round in our pocket. The projections did not see that coming.",
      "Ninja defuse. Decades of coaching and you can still surprise me.",
    ]);
  }
  if (ourSide === "T") {
    return pick("defusedT", [
      "They defused it. Your round, taken like an unlocked bike.",
      "Round's gone, defused clean. Somebody guarded that plant with their imagination.",
      "Our plant, their defuse. All that work to get it down, none to protect it. Poetic.",
      "Kit beats clock, their round. Next time guard the bomb like it pays rent.",
    ]);
  }
  return pick("defusedNeutral", [
    "Wire's cut somewhere. Someone's celebrating, someone's typing in all caps.",
    "Defuse on the feed. One team's thrilled. The odds say it wasn't us.",
  ]);
}

export function bombExplodedLine(ourSide: string | undefined): string {
  if (ourSide === "T") {
    return pick("explodedT", [
      "Boom. Our bomb, their problem. The clock did the heavy lifting, but I'll count it.",
      "Detonation. Round's ours. The bomb remains our most consistent performer this match.",
      "Bomb went off, round's ours. The plan survived everyone's improvising.",
      "It exploded, we get paid. Genuinely competent. Don't get used to my tone.",
    ]);
  }
  if (ourSide === "CT") {
    return pick("explodedCT", [
      "Forty whole seconds of warning and we still missed the appointment.",
      "Beaten by a timer. The bomb doesn't even shoot back.",
      "Kaboom, on your watch. That retake needed to start twenty seconds sooner.",
      "Heard that explosion? That was our loss bonus going up. Small silver linings.",
    ]);
  }
  return pick("explodedNeutral", [
    "Big boom somewhere. A round just ended. Consult the scoreboard for the emotional verdict.",
    "Something detonated. Hopefully that was the plan and not the surprise.",
  ]);
}

export function roundWonLine(ourScore: number, theirScore: number): string {
  return pick("roundWon", [
    `We take that one. ${ourScore} to ${theirScore}. Don't spend all the confidence at once.`,
    `Chalk that one up, ${ourScore} to ${theirScore}. Keep the guns, keep the momentum, stay humble. Or quiet.`,
    `${ourScore}-${theirScore}. The plan worked, which means somebody accidentally followed it.`,
    `Securing rounds now, ${ourScore}-${theirScore}. I'd act surprised but my face is tired.`,
    `Score's ${ourScore} to ${theirScore}. Winning looks weird on you. Don't stop.`,
    `Suspiciously competent, ${ourScore}-${theirScore}. Who are you people.`,
    `Round's ours, ${ourScore}-${theirScore}. Almost looked rehearsed. It wasn't, but almost.`,
  ]);
}

export function roundLostLine(ourScore: number, theirScore: number): string {
  return pick("roundLost", [
    `Round lost. ${ourScore}-${theirScore}. Reset, buy right, pretend that didn't happen.`,
    `That round's gone, ${ourScore} to ${theirScore}. Grieve later, win now.`,
    `Their round, ${ourScore}-${theirScore}. Annoying, fixable, and entirely on tape. Adjust.`,
    `Scoreboard says ${ourScore}-${theirScore}. It says nothing about the next round. Go take that one.`,
    `Down a round at ${ourScore}-${theirScore}. The comeback starts with not tilting.`,
    `There goes a round, ${ourScore} to ${theirScore}. Rounds are like buses, win the next one.`,
    `Ouch, ${ourScore} to ${theirScore}. Park the ego and play the next one properly.`,
  ]);
}

export function killLine(roundKills: number, name?: string): string | null {
  // Third-person fallback so templates like "${who} drops a triple" stay grammatical.
  const who = name ?? "our star";
  if (roundKills >= 5) {
    return pick("killAce", [
      `${who} just got an ace. I had a roast ready and you ruined it.`,
      `An ace. Fine. ${who} earns one compliment, redeemable never.`,
      "That's an ace. Genuinely good. This conversation never happened.",
    ]);
  }
  if (roundKills === 4) {
    return pick("killQuad", [
      `Four kills, ${who}. One more and I'll have to revise my entire opinion of you.`,
      "Quad kill. The ace is right there. Don't trip over it.",
      "That makes four. One left. No pressure, except all of it.",
    ]);
  }
  if (roundKills === 3) {
    return pick("killTriple", [
      `A triple from ${who}. Who are you and what did you do with my player.`,
      "Triple kill. Tonight's demo review just got slightly less painful.",
      `Someone check on ${who}, that was three whole kills.`,
      "Three of them down. Apparently practice pays off once a season.",
    ]);
  }
  // Singles and doubles stay silent: play-by-play of routine kills is noise —
  // the multikill escalation and the special-kill stories carry the hype.
  return null;
}

export function knifeKillLine(name?: string): string {
  const who = name ?? "our star";
  return pick("knifeKill", [
    `A knife kill in competitive. ${who}, their family saw that.`,
    `Fifteen hundred dollars and a ruined ego — ${who} just knifed someone in competitive.`,
    "Knifed. In a competitive match. That person is uninstalling as we speak.",
    `${who} brought a knife to a gunfight and won. Disgusting. Beautiful.`,
  ]);
}

export function zeusKillLine(): string {
  return pick("zeusKill", [
    "Tased. Someone bought full armor and died to a glorified cattle prod. Art.",
    "Death by Zeus. Two hundred dollars of pure disrespect. I respect it.",
    "Zapped. Somewhere, a player is staring silently at their monitor.",
  ]);
}

export function nadeKillLine(nade: "he" | "fire"): string {
  if (nade === "fire") {
    return pick("mollyKill", [
      "Molly kill. They had every chance to leave the fire. They stayed for the ambiance.",
      "Cooked. Your grenade did more damage than your last three gunfights combined.",
      "Roasted by your incendiary. Least personal kill in the game. Still counts.",
    ]);
  }
  return pick("heKill", [
    "Direct hit. They tried to catch the grenade with their face.",
    // "Grenade", not "HE" — TTS reads a standalone "HE" as the pronoun.
    "Grenade kill. You threw money at the problem and the problem died. Valid strategy.",
    "Naded them out of existence. The grenade aims better than you do, most rounds.",
  ]);
}

export function lowHpKillLine(hp: number): string {
  return pick("lowHpKill", [
    `You won that at ${hp} HP. Practically a ghost with a gun. Unsettling.`,
    `${hp} health and you took the duel anyway. Medically inadvisable, weirdly admirable.`,
    `Clutched it at ${hp} HP. Now go hide — health doesn't regenerate here.`,
  ]);
}

export function teamkillLine(): string {
  return pick("teamkill", [
    "Outstanding aim, catastrophic target selection. That was your teammate. Apologize in chat.",
    "Friendly fire, minus the friendly. Type the apology and mean it.",
    "Your victim was wearing our colors. We shoot the other five. Apologize.",
    "Congratulations on the kill nobody wanted. Apologize before the kick vote starts.",
  ]);
}

/** Narrate the teammate the dead player is spectating; quiet for routine kills. */
export function teammateKillLine(name: string | undefined, kills: number, health?: number): string | null {
  const who = name ?? "your teammate";
  if (kills >= 5) {
    return pick("specAce", [
      `Death has perks. Front-row seat for the ace show from ${who}.`,
      `From the bench you just watched ${who} ace. Take notes. Several notes.`,
    ]);
  }
  if (kills === 4) {
    return pick("specQuad", [
      `${who} has four. You have a death cam. Cheer quietly.`,
      `Count it: four for ${who}. One more and you'll have witnessed history from the cheap seats.`,
    ]);
  }
  if (kills === 3) {
    return pick("specTriple", [
      `Meanwhile ${who} drops a triple, and you're a camera with opinions.`,
      `Watch and learn from the couch — ${who} just got a triple.`,
      `Triple for ${who}. No pressure from the corpse section, please.`,
    ]);
  }
  if (health !== undefined && health > 0 && health <= 20 && kills >= 1) {
    return pick("specClutch", [
      `All eyes on ${who}, alive at ${health} HP. The math says no. Watch anyway.`,
      `${who} is clutching this at ${health} HP. Pray quietly, you've done enough.`,
    ]);
  }
  return null;
}

/** Locally-derived clock callout: ~35 seconds left, no plant yet. */
export function lateRoundLine(side: string | undefined): string {
  if (side === "T") {
    return pick("lateRoundT", [
      "Thirty-five seconds and no plant. Pick a site, commit now, the bomb isn't decorative.",
      "Half a minute left. Stop touring the map and get that bomb down somewhere.",
      "You have thirty-five seconds to remember the objective. Hit a site and plant. Now.",
    ]);
  }
  if (side === "CT") {
    return pick("lateRoundCT", [
      "No plant with thirty-five seconds left. The clock's on your payroll. Hold, don't go hunting.",
      "Clock check: half a minute left and they've done nothing. Hold tight, the timer frags for us.",
      "Time wins this at thirty-five seconds — hold, and nobody volunteers for a highlight.",
    ]);
  }
  return pick("lateRoundNeutral", [
    "Half a minute left, no plant. Somebody's master plan has quietly fallen apart.",
  ]);
}

/** Locally-derived bomb-timer callout: roughly ten seconds left on the C4. */
export function bombTenLine(side: string | undefined, fighting = false): string {
  if (side === "CT") {
    // Mid-fight: the player just got a kill — give them the clock, not a
    // "back off" order aimed at someone who's clearly winning the exchange.
    if (fighting) {
      return pick("bombTenCTFighting", [
        "Swinging with ten seconds left? Fine — finish them fast.",
        "Mid-massacre with ten seconds on the bomb. Keep going, then get on it.",
        "Detonation in ten seconds. Close this fight out — I've got faith. Some.",
      ]);
    }
    return pick("bombTenCT", [
      "Ten seconds. If you're not on the stick already, walk away and live.",
      "That bomb has ten seconds. No defuse started means no defuse. Get clear and survive.",
      "Clock says ten seconds. Unless you're already sticking it, run and keep that gun.",
    ]);
  }
  if (side === "T") {
    return pick("bombTenT", [
      "Don't peek. Ten seconds left. Even you can stand still that long.",
      "Hold and hush. Ten more seconds and the round pays out.",
      "Only ten seconds to survive. Re-peeking now would be a bold new kind of stupid.",
    ]);
  }
  return pick("bombTenNeutral", ["Final ten seconds on the bomb. However this ends, it ends loudly."]);
}

/**
 * Rule-based CT retake-or-save call when Claude isn't available (or too slow):
 * a coarse read of the player's own gear — the honest subset of what we know.
 */
export function retakeDecisionLine(ctx: MatchContext): string {
  // Dead (spectating): gear fields describe the teammate or nothing — talk to
  // the team instead of advising a corpse about its loadout.
  if (!ctx.playerIsSelf || (ctx.health ?? 0) <= 0) return bombPlantedLine("CT");
  // Mid-fight: a kill seconds ago means they're clutching RIGHT NOW — back the
  // play in few words. A retake-or-save lecture talks over the only person playing.
  if (ctx.lastKillSecondsAgo !== undefined && ctx.lastKillSecondsAgo <= 10) {
    return pick("retakeFighting", [
      "You started this fight. Finish it.",
      "Keep the fight going, you've got them rattled. Take the next one.",
      "Good kill — now finish it. The bomb can wait three more seconds.",
    ]);
  }
  // THEIR match point (a lost round ends the match — nothing left to save for)
  // or a money reset next round (the saved gear evaporates): "save" is the one
  // call that's always wrong. At OUR match point normal judgment still applies —
  // losing a round at 12-5 keeps the gear and the lead.
  if (ctx.matchPoint === "them" || ctx.moneyResetsNextRound) {
    return pick("retakeMustWin", [
      "A save gets you nothing past this round. All five in, win the retake.",
      "Saving's pointless here — there's nothing to carry it into. Go win the round.",
      "Win it or it's all gone anyway. Everybody commits to the retake.",
    ]);
  }
  const thinGear = (ctx.armor ?? 0) === 0 || (ctx.equipValue ?? 0) < 1500 || (ctx.health ?? 100) < 40;
  if (ctx.defuseKit) {
    return pick("retakeKit", [
      "You've got the kit, so you're the defuser. Team clears, you stick.",
      "Designated defuser today — the kit's in your pocket. Retake with the team, they clear your path.",
      "Carrying the kit makes you important for once. Team goes, you go, you defuse.",
    ]);
  }
  if (thinGear) {
    return pick("retakeThin", [
      "Held together with tape. Only go if all five commit — otherwise save for next round.",
      "With that loadout, a solo retake is a tribute, not a play. Full squad or save.",
      "Thin gear, thinner odds. Full team push or nothing. Saving beats donating.",
    ]);
  }
  return pick("retakeGo", [
    "Gear's good enough. Retake together, trade every fight, and nobody enters alone. Nobody.",
    "Decent loadout, live bomb. Stack up, hit the site together, trade like you've met before.",
    "Take it back together. Trade the kills, hold hands if you must.",
    "This retake's winnable if you go in as five. Trickling converts it into their highlight reel.",
  ]);
}

export function deathLine(): string | null {
  // Speak rarely on death; nobody wants narration of every death.
  if (Math.random() > 0.2) return null;
  return pick("death", [
    "Dead. Shocking. Give your team the info before it expires.",
    "Died doing what you love: peeking. Give your team the info, then start grieving.",
    "That death cam means one job left: talk. Positions, numbers, give your team the info.",
    "Another grave for the collection. Pass the info to your team, ghost duty starts now.",
  ]);
}

export function mvpLine(name?: string): string {
  // Lines address the player directly when no name is known.
  const who = name ?? "you";
  return pick("mvp", [
    "Round MVP. Somebody had to get it. Glad it was you, somehow.",
    `Well, well, ${who} carried a round. Don't make me start believing in you.`,
    `The MVP medal goes to ${who}. I ran the numbers twice. They held up. Disturbing.`,
    "Look at you, MVP. Updating my file from concerning to occasionally useful.",
  ]);
}

/**
 * Round-end react for the LAST round of the first half (round 12): "keep the
 * guns / buy right next round" talk is wrong here — sides swap and money wipes.
 */
export function halfEndLine(won: boolean, ourScore: number, theirScore: number): string {
  if (won) {
    return pick("halfEndWon", [
      `Half's ours, ${ourScore}-${theirScore}. Sides swap, money's wiped — win the pistol and keep it rolling.`,
      `That's the half, ${ourScore}-${theirScore}. Everything resets now, so bring the lead, not the guns.`,
      `${ourScore}-${theirScore} at the break. New side, fresh wallets, pistol next. Same energy.`,
    ]);
  }
  return pick("halfEndLost", [
    `Half ends ${ourScore}-${theirScore}. Clean slate now — new side, fresh money, pistol round next.`,
    `That half's over, ${ourScore}-${theirScore}. Money resets, sides swap, excuses stay here.`,
    `${ourScore}-${theirScore} at the swap. Whole new game on the other side — start it with the pistol.`,
  ]);
}

/** Round-end react when overtime (or another OT half) follows — fresh money, no carryover. */
export function otNextLine(ourScore: number, theirScore: number): string {
  return pick("otNext", [
    `${ourScore}-${theirScore}. Overtime. Fresh ten grand each — nobody gets to be tired now.`,
    `Still tied at ${ourScore}-${theirScore}, so we do overtime. Full reset, full buys, no excuses.`,
    `${ourScore}-${theirScore} means extra rounds. Money resets to ten grand — settle it properly.`,
  ]);
}

export function halftimeLine(ctx: MatchContext): string {
  const our = ctx.ourScore;
  const their = ctx.theirScore;
  // Templates already say "halftime" — keep the score fragment bare so TTS
  // doesn't stutter "Halftime! 7-5 at the half. Great half..."
  const score = our !== undefined && their !== undefined ? ` ${our}-${their}.` : "";
  if (our !== undefined && their !== undefined && our > their) {
    return pick("halftimeAhead", [
      `Halftime!${score} A lead. Sides swap and money resets, so earn it twice.`,
      `Halftime.${score} Winning at the break. Economy resets, so does my skepticism.`,
      `Halftime!${score} We're ahead. New side, fresh economy, don't hand the lead back.`,
    ]);
  }
  if (our !== undefined && their !== undefined && our < their) {
    return pick("halftimeBehind", [
      `Halftime!${score} First half's a sunk cost. Fresh money, fresh side, go take it back.`,
      `Halftime.${score} Down at the break. Sides swap, wallets reset, excuses don't carry over.`,
      `Halftime!${score} Behind, but sides swap and money resets. The comeback starts with one clean buy.`,
    ]);
  }
  return pick("halftimeEven", [
    `Halftime.${score} Dead even. Money resets on the swap. Someone has to blink. Not us.`,
    `Halftime!${score} Tied. A literal coin flip now, so bring a heavier coin this half.`,
    `Halftime.${score} All square. New side, clean economy. Mediocrity this consistent is almost impressive.`,
  ]);
}

export function matchPointLine(forUs: boolean): string {
  return forUs
    ? pick("matchPointUs", [
        "Match point. Close it clean. No hero plays, no victory laps before the victory.",
        "The match ends right here if nobody freelances. So nobody freelances.",
        "A single round from winning it all. The fastest way to ruin it is creativity. Avoid creativity.",
        "Professionals end it here quietly. The highlight reel can wait one round.",
      ])
    : pick("matchPointThem", [
        "Cushion's gone. We don't lose this round, simple as that. Calm and clean.",
        "Their match point, not their match. Win this round and the pressure flips sides.",
        "Zero margin now, so play sharp, not scared. Tilt loses this faster than they can.",
        "Backs to the wall. Forget the score, play this round on its merits.",
      ]);
}

export function matchEndLine(won: boolean | undefined, ourScore: number, theirScore: number): string {
  if (won === true) {
    return pick("matchWon", [
      `Match won, ${ourScore}-${theirScore}. Enjoy it. I'll find something to critique by tomorrow.`,
      `Somehow that's a win, ${ourScore}-${theirScore}. Against my projections and several laws of probability.`,
      `Victory, ${ourScore}-${theirScore}. I'm proud in a quiet, deniable way.`,
    ]);
  }
  if (won === false) {
    return pick("matchLost", [
      `Lost the match, ${ourScore}-${theirScore}. The demo will be educational, the way autopsies are.`,
      `Dropped it, ${ourScore}-${theirScore}. It happens. To us, often. Next one.`,
      `It ends ${ourScore}-${theirScore}. They were better today. Tomorrow's stats start blank. Use that.`,
    ]);
  }
  return pick("matchOver", [
    `And that's a wrap at ${ourScore}-${theirScore}. Celebrate at your own risk.`,
    `All done at ${ourScore}-${theirScore}. You do the math, I'll do the sighing.`,
    `Final score ${ourScore}-${theirScore}. Interpret it however your mood requires.`,
  ]);
}
