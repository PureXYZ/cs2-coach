import type { MatchContext } from "../gsi/tracker.js";

// Canned lines, persona: a sarcastic, snide, perpetually unimpressed esports
// coach — the user's explicit preference (consensual roast). Spoken register on
// purpose: short sentences, contractions, CS slang, the occasional swear. The
// informational payload (buy calls, retake/save, scores, clocks) must survive
// every joke; sarcasm is the wrapper, never the content. Authored via a
// writers-room workflow (4 comedic lenses → per-group judges), hand-curated.

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
      "Match found. Don't know the map yet. My disappointment works on all of them.",
      "We're in. No clue where yet. Surprise me. Pleasantly, for once.",
      "Queue popped. Wherever we land, buy armor and aim at heads.",
      "Here we go again. Map unknown. Wake the hell up, warmup's over.",
    ]);
  }
  const map = mapDisplayName(rawMap);
  return pick("matchStart", [
    `${map}. Great. Let's see what we ruin today.`,
    `Match found. ${map}. God help us all.`,
    `We're on ${map}. Pistol first. Don't do anything weird.`,
    `Oh good, ${map}. Home of your worst whiffs. Let's add to the collection.`,
    `Here we go, ${map}. Crosshair at head height. It's free and you still won't do it.`,
    `New match on ${map}. Set your expectations low. I set mine in 2009.`,
    `Back on ${map}. Same shit, new lobby.`,
    `Fresh game on ${map}. Zero deaths so far. Career best. Don't fuck it up.`,
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
      "Pistol round. Armor or util, pick one. And stay together. Yes, all five of you.",
      "Eight hundred bucks. Armor or util, one each. Five guys, one direction. Shock the shit out of me.",
      "Glock money, everyone. Armor or a flash, not both. Move as a pack.",
      "Kevlar or a flash, your pick. Then five-man it like you actually like each other.",
      "It's pistols, not a talent show. Armor or util each, then play it as five.",
      "Twenty years of pistol rounds and the advice hasn't changed. Armor or util, and stay grouped.",
      "Don't get cute on pistol. Armor or a nade, and everybody swings the same damn fight.",
      "Pick armor or util, then group up. Pistol-round heroes die first and broke.",
    ]);
  }
  // Their match point: lose this round and the match ends — "save for next
  // round" is advice about a round that won't exist.
  if (ctx.matchPoint === "them") {
    return pick("ecoMustWin", [
      "Match point, theirs. Money means nothing now. Buy what's there and win the damn thing.",
      "Do or die. A full wallet looks stupid on the losing team. Buy up.",
      "They're one round from ending this. Economy's officially canceled. Everything goes on the table.",
      "No tomorrow if we lose this one. Empty the bank, grab anything that shoots.",
      "Quick math: lose this, match over. Saving is the dumbest shit available. Spend.",
      "It's win or handshake time. Buy whatever's left and make it count.",
    ]);
  }
  // Last round before a money wipe (half end, overtime boundaries): saved cash
  // and gear evaporate, so the only wrong buy is no buy.
  if (ctx.moneyResetsNextRound) {
    return pick("ecoSpendReset", [
      "It's all gone at the end of this round anyway. Spend every damn cent. Force it.",
      "The bank resets after this one. Saving now is just burning money politely. Buy it all.",
      "Saving into a reset. Bold plan. Terrible plan. Buy everything you can carry.",
      "Your wallet dies with this round. Take it down with you. Full force.",
      "This cash doesn't carry over. Force the buy. Dying rich is for idiots.",
      "Money zeroes out after this either way. Max the buy. Spend it angry.",
      "No point hoarding, it's all getting wiped. Empty the account, buy stupid shit, win loud.",
    ]);
  }

  if (equip >= 3500) {
    return pick("ecoKitted", [
      "Wallet stays shut, you've got everything. Bring that rifle home alive.",
      "Nothing to buy. Keep the gun. That's it. That's the whole damn speech.",
      "Kitted. Zero shopping. Try dying less, it's free.",
      "Shop's closed. Don't gift-wrap the AK for them on the way out.",
      "Everything's bought. Treat the rifle like it's insured. Then remember it isn't.",
      "Geared up, util and all. The only way to fuck this up is dying for free.",
      "Inventory's full, skip the store. Dead bodies with full kits make me physically ill.",
      "Fully equipped. Per my last timeout, we do not hand out free rifles to strangers.",
      "You're loaded already. Donating rifles to their broke asses is not a strat.",
      "All set. Spend zero. A dry peek right now is a yard sale.",
    ]);
  }
  if (money >= 4700) {
    return pick("ecoFullBuy", [
      "You're rich. Full buy. Rifle, armor, and yes, the nades too.",
      "If you leave the buy menu without util, get your ass back in. We're not broke.",
      "Buy it all. Even the molly you never throw. No shortcuts.",
      "Money's not the problem this round. Full buy, all the util. The aim's the problem.",
      "Wallet's fat. Empty it. Rifle, kevlar, grenades. The whole menu.",
      "No half kits today. Skip the util again and we're doing a six a.m. demo review.",
      "Full buy. Every slot. Saving nades for later is not a strategy.",
      "Forty-seven hundred plus. And util means buying it, not admiring it.",
      "Spend it. Gun, armor, grenades, all of it. Your bank account isn't winning shit this round.",
      "Big money, big buy. And get the smokes, you cheap bastard.",
    ]);
  }
  if (money >= 3700) {
    return pick("ecoBuy", [
      "Decent money. Rifle and armor. Util only if the math works.",
      "Mid buy. Rifle, armor. Nades are a luxury today, not a goddamn right.",
      "Rifle plus armor. Change left over? Grab a flash. If not, don't cry.",
      "Enough for the essentials. Gun and plates. Grenades are dessert, not dinner.",
      "Not rich, not broke. Gun and armor. Util's a maybe, armor's not fucking optional.",
      "Gun first, armor second, util a distant third. Welcome to the middle class, it sucks here.",
      "Solid buy round. Armor and a rifle. Util comes last, like you on the scoreboard.",
      "Nothing fancy. Rifle, armor. Flash if it fits. Don't get cute.",
      "Plates, rifle, one flash tops. Don't force a full kit on half-assed money.",
      "You can afford a rifle and kevlar, so buy a rifle and kevlar. Flash if anything's left.",
    ]);
  }
  if (money <= 1800) {
    if (losses >= 2) {
      return pick("ecoSaveStreak", [
        "Full save. The loss bonus is cooking. Next round we're rich. Touch nothing.",
        "Hands off the buy menu. Bonus is maxed. Full buy next round. Trust the math.",
        "Zero spending. That loss streak's the only damn thing we've grown all half. It pays next round.",
        "Pistols out, dignity away. Next round it's rifles for everyone.",
        "This round's a write-off, save everything. Next round the bank opens. Don't ruin it forcing a Deagle.",
        "Don't buy shit. The bonus maxes after this. Eat this round, feast the next.",
        "Nobody buys. Bonus money lands next round, and then we shop like adults.",
        "Save this one. I know it hurts like hell. Real buy next round, promise.",
      ]);
    }
    return pick("ecoSave", [
      "Eco. Pistols at most. Take a pick if it's free, then get out alive.",
      "Full eco. Die holding nothing, fine. Don't die holding their next damn rifle.",
      "Stack up, take one shot, leave. An eco's a robbery, not a shootout.",
      "Under eighteen hundred means pistols only. Pick or no pick, you exit breathing. Non-negotiable.",
      "Tighten the belt. Anything you buy now, they inherit in ninety seconds. Pistol, picks, leave.",
      "Broke-ass round. Cheap pistol, sneaky angles, and run when it goes bad. It will go bad.",
      "That money's not a buy, it's a cry for help. Eco, grab a pick, exit alive.",
      "Bank's empty. One lucky pistol kill beats a half-assed force. Play for that, then walk.",
      "Budget round. Spend nothing, annoy them, get out. Real guns come back later.",
      "Plan's simple. One pick, one exit, no hero movie.",
    ]);
  }
  return pick("ecoAwkward", [
    "Awkward money. Force or save, I honestly don't give a shit which. Just match each other.",
    "Force as five or save as five. A solo Galil is just a delivery.",
    "Coin-flip money. Heads we force, tails we save. All five flip the same coin.",
    "Money's in no-man's land. Sync the buy with the boys. Freelancing it is bot behavior.",
    "Weird buy round. Half a buy each is a full waste. Everyone makes the same call.",
    "Don't solo buy. Don't solo save. The team picks one, you copy it. Wild concept.",
    "Mixed buys are why my hair's gray. One plan, five people. Decide fast.",
    "Tweener money. Lone-wolfing the buy menu helps exactly fucking nobody. Force or save as a team.",
  ]);
}

export function bombPlantedLine(ourSide: string | undefined): string {
  if (ourSide === "CT") {
    return pick("plantedCT", [
      "Bomb's down. Group up. Nobody freelances.",
      "Forty seconds. Find your friends first. Then take it back.",
      "They planted. Shocking. Gather up, then go.",
      "Plant's in. Trickle in one by one and I'm logging off.",
      "That's a plant. Retake as five, not five separate funerals.",
      "There it goes. Form up and hit that shit together.",
      "Nobody's winning this one-man-army shit. Regroup first.",
      "It's planted. Retake together or don't fucking bother.",
    ]);
  }
  if (ourSide === "T") {
    return pick("plantedT", [
      "Planted. Crossfires up. Re-peek and we're having words.",
      "Bomb's ticking. The clock's our best fragger now. Let it work.",
      "We planted. Great. Now do nothing. Beautifully.",
      "Nice plant. Now play boring as hell. Boring wins post-plants.",
      "Hold your spot. Curiosity kills more post-plants than AWPs do.",
      "Kills are optional now. Living isn't.",
      "Bomb's down. Sit in your crossfires and shut the hell up.",
      "Timer's running. Every second you don't peek is free damn money.",
    ]);
  }
  // Side unknown (e.g. just reconnected) — stay neutral.
  return pick("plantedNeutral", [
    "Bomb's down. Forty seconds. Someone's about to have a shit day.",
    "That's a plant. Clock's live. Look alive.",
    "Plant's in. Clock's the boss from here.",
  ]);
}

export function bombDefusedLine(ourSide: string | undefined): string {
  if (ourSide === "CT") {
    return pick("defusedCT", [
      "Defused. We stole that shit. Act natural.",
      "Stuck it. Their plant, our paycheck. Love a refund.",
      "Wire's cut, round's ours. They can cry about it.",
      "Ninja'd it right back. I'm annoyed at how proud I am.",
      "Bomb's dead. Someone finally watched a damn retake guide.",
      "Round stolen. Somebody on their team is getting yelled at right now.",
    ]);
  }
  if (ourSide === "T") {
    return pick("defusedT", [
      "They defused. Nobody watched the damn bomb. Incredible work, everyone.",
      "Our plant, their defuse. Watching it was the whole job.",
      "That bomb had zero babysitters. Now it's theirs. Cool cool.",
      "We planted it and then wandered off. Defused. Of course.",
      "That's their defuse. Ten bucks says nobody had eyes on the bomb.",
      "Somebody just defused in our living room. Where the hell was everybody?",
    ]);
  }
  return pick("defusedNeutral", [
    "Bomb's defused. Somewhere, a T player is screaming into a pillow.",
    "Defuse went through. Hope that was us.",
  ]);
}

export function bombExplodedLine(ourSide: string | undefined): string {
  if (ourSide === "T") {
    return pick("explodedT", [
      "Kaboom. That damn near looked rehearsed.",
      "There's the detonation. See what not re-peeking buys? A whole round.",
      "That's the sound of us getting paid.",
      "Site's a crater. Love it when a plan works.",
      "Their retake never showed up. Our round, easy as hell.",
      "Bomb did its job. You did yours. Shocking, honestly.",
    ]);
  }
  if (ourSide === "CT") {
    return pick("explodedCT", [
      "Boom. That was ours. Retake was fucking late.",
      "It exploded. We planned that retake like a group project. Nobody started.",
      "There goes the site. Slow-ass retake. My knees move faster.",
      "That sound means the retake never happened. Round over.",
      "Explosion, our side. You can't out-wait a bomb, it always wins.",
      "Round's gone. Next time the retake starts before the beeping does.",
    ]);
  }
  return pick("explodedNeutral", [
    "That was the bomb. Somebody's payday, somebody's problem.",
    "Big boom. Round's decided. Hope to hell it was ours.",
  ]);
}

export function roundWonLine(ourScore: number, theirScore: number): string {
  return pick("roundWon", [
    `That's ours. ${ourScore}-${theirScore}. Settle down.`,
    `A win. ${ourScore}-${theirScore}. I'll allow it.`,
    `Score's ${ourScore}-${theirScore}. Do that again, but on purpose.`,
    `Okay, that worked. ${ourScore}-${theirScore}. Run that shit back.`,
    `Round won. ${ourScore}-${theirScore}. I had doubts. Keeping them.`,
    `One for us. ${ourScore}-${theirScore}. I'd celebrate, but I've seen your follow-up rounds.`,
    `Winner winner. ${ourScore}-${theirScore}. Whatever that was, bottle it.`,
    `Somehow we won that. ${ourScore}-${theirScore}. The comms said otherwise the whole damn time.`,
    `Nice round. ${ourScore}-${theirScore}. Don't make me regret the compliment.`,
    `We took that. ${ourScore}-${theirScore}. Almost looked like a damn plan.`,
    `Hell yeah. ${ourScore}-${theirScore}. Next one's still a normal round, by the way.`,
    `There it is. ${ourScore}-${theirScore}. One more like that and I might relax a muscle.`,
  ]);
}

export function roundLostLine(ourScore: number, theirScore: number): string {
  return pick("roundLost", [
    `Lost that one. ${ourScore}-${theirScore}. Breathe. Reset. Next.`,
    `${ourScore}-${theirScore}. Whatever the hell that was, don't do it again.`,
    `That round stunk. ${ourScore}-${theirScore}. Flush it.`,
    `They get one. ${ourScore}-${theirScore}. Don't make it a habit.`,
    `Somebody got baited that round. Can't see it, can still feel it. ${ourScore}-${theirScore}. Next.`,
    `Quick question. What the fuck was the plan there? Genuinely asking. ${ourScore}-${theirScore}.`,
    `Oof. ${ourScore}-${theirScore}. They played it better. There, I said it. Now hit back.`,
    `Gave that one away, ${ourScore}-${theirScore}. Tilt is a choice. Don't fucking choose it.`,
    `Dropped it. ${ourScore}-${theirScore}. The next round doesn't give a damn about this one.`,
    `Let it go, ${ourScore}-${theirScore}. Stop replaying it in your head. That's my job, and it's miserable.`,
    `Yeah, that's a loss, ${ourScore}-${theirScore}. Crosshair up, ego down, go again.`,
    `Round's gone. ${ourScore}-${theirScore}. Short memory. Play on.`,
  ]);
}

export function killLine(roundKills: number, name?: string): string | null {
  // Third-person fallback so templates like "${who} drops a triple" stay grammatical.
  const who = name ?? "our star";
  if (roundKills >= 5) {
    return pick("killAce", [
      "An ace. Damn it. That was clean.",
      "Five for five. Shit. Okay. Respect.",
      `${who} just aced. Clip it before I deny everything.`,
      `All five. I hate that I'm impressed. Good shit, ${who}.`,
      "Ace. You get one nice sentence: that was filthy.",
      "Whatever. Ace. Incredible. Moving on.",
      "My notes say you can't shoot. The ace disagrees. Noted.",
      `Whole lobby cleared by ${who}. Fine. You're him. Today only.`,
    ]);
  }
  if (roundKills === 4) {
    return pick("killQuad", [
      "Four. One more and I'll say something nice.",
      "Quad. Number five's waiting. Don't keep him long.",
      `${who}'s on four. I'm not blinking.`,
      "Don't whiff the fifth. I'll lose my shit.",
      `One left, ${who}. No pressure. Okay, all the pressure.`,
      "Holy shit, four. Clear your corners, close it out.",
      `Who the hell let ${who} cook? That's four.`,
      "That's four. Finish it and I'll claim credit.",
    ]);
  }
  if (roundKills === 3) {
    return pick("killTriple", [
      "Huh. Three. I'll update your file.",
      `Three of 'em. Okay, ${who}'s awake.`,
      "That's a triple. Don't ego peek the rest.",
      "Look at you. Three down. Almost looked like a plan.",
      "Damn, a triple. Even the scoreboard's confused.",
      "Triple kill. Who the hell lent you that aim?",
      `A triple, ${who}. So you do listen sometimes.`,
      "Shit. Three kills. Warn me next time.",
      `${who} with a triple. Fine. Small nod from the bench.`,
      "Don't get weird about it, but that was a triple.",
    ]);
  }
  // Singles and doubles stay silent: play-by-play of routine kills is noise —
  // the multikill escalation and the special-kill stories carry the hype.
  return null;
}

export function knifeKillLine(name?: string): string {
  const who = name ?? "our star";
  return pick("knifeKill", [
    "A knife kill. In comp. Filthy shit. I love it.",
    `${who} just knifed a man. He's uninstalling as we speak.`,
    "Knifed. That's not a kill, that's a damn message.",
    "You had a gun. You chose the knife. Respect.",
    "Stabbed in a gunfight. His whole damn family felt that.",
    "The knife? He has to live with that forever.",
    "That's a knife kill. He's already typing angry. Perfect.",
    `The blade, ${who}. Maximum disrespect. I approve this message.`,
  ]);
}

export function zeusKillLine(): string {
  return pick("zeusKill", [
    "Zeus kill. Two hundred dollars of disrespect, paid in full.",
    "He had a rifle. You had a battery. Damn.",
    "Zapped. He's gonna hear that crackle in his sleep.",
    "That's a Zeus kill. He's never telling anyone about this.",
    "The Zeus connects. His ego just fucking flatlined.",
    "Tased. He died embarrassed. As intended.",
  ]);
}

export function nadeKillLine(nade: "he" | "fire"): string {
  if (nade === "fire") {
    return pick("mollyKill", [
      "Molly kill. He stood in it. On purpose, apparently.",
      "Cooked him. Medium rare. Chef shit.",
      "He died to a puddle of fire. Slowly. With options.",
      "A molly frag. The floor was lava and he lost.",
      "Fire did the work. You just watched. Teamwork.",
      "Burned him alive. Not even your fault. Hell of a molly.",
    ]);
  }
  return pick("heKill", [
    // "Nade"/"grenade", never a bare "HE" — TTS reads that as the pronoun.
    "Nade kill. Direct deposit, right into his face.",
    "Frag grenade, actual frag. The name finally makes sense.",
    "He ate the whole nade. Every bit. Greedy.",
    "Zero bullets, one nade, full kill. Efficient as hell.",
    "Grenade kill. Physics did the hard part. Take the credit anyway.",
    "Boom. Naded him. Cheapest damn funeral on the server.",
  ]);
}

export function lowHpKillLine(hp: number): string {
  return pick("lowHpKill", [
    `${hp} HP and you swung anyway. Shit worked. Somehow.`,
    `Clutched a duel at ${hp} HP. One dink and you were dust.`,
    `You had ${hp} HP and an ego. The ego won.`,
    `That was a coin flip at ${hp} HP. It landed your way.`,
    `He lost to a guy on ${hp} HP. He's never recovering.`,
    `Won that on ${hp} HP. Pure fucking audacity.`,
  ]);
}

export function teamkillLine(): string {
  return pick("teamkill", [
    "That was your teammate. Type sorry in chat. Now.",
    "Wrong jersey, genius. Open chat, type sorry, mean that shit.",
    "Great spray control, shame about the target. Chat. Sorry. Go.",
    "Congrats, you're the enemy team's MVP. Now type sorry in chat.",
    "Shot your own damn guy. Apologize in chat, then think about it.",
    "One less gun for us, thanks. Apology in chat, pronto.",
    "He was on YOUR team. One sorry in chat, minimum.",
    "Friendly fire isn't friendly. Apologize in chat and buy him something.",
  ]);
}

/** Narrate the teammate the dead player is spectating; quiet for routine kills. */
export function teammateKillLine(name: string | undefined, kills: number, health?: number): string | null {
  const who = name ?? "your teammate";
  if (kills >= 5) {
    return pick("specAce", [
      `Ace. ${who} killed everybody. You contributed a death.`,
      `That's an ace for ${who}. I'm annoyed at how impressed I am.`,
      `Five for five. ${who} aced it while you spectated. Teamwork, technically.`,
      `${who} just aced. Damn. That never gets old.`,
    ]);
  }
  if (kills === 4) {
    return pick("specQuad", [
      `Four for ${who}. One more and you owe them dinner.`,
      `${who}'s on four. You're watching a carry from the floor.`,
      `That's a quad from ${who}. The ace watch is officially on.`,
      `Holy shit, ${who} just hit four. Best thing you've watched all day.`,
    ]);
  }
  if (kills === 3) {
    return pick("specTriple", [
      `Triple for ${who}. Your death really set that up nicely.`,
      `${who}'s got three. Turns out staying alive helps.`,
      `There's the triple. ${who}'s cleaning up. Stay dead, you've earned the rest.`,
      `Three kills for ${who}. So that's what aiming looks like.`,
      `Watch close. ${who}'s on three. Free fucking masterclass.`,
    ]);
  }
  if (health !== undefined && health > 0 && health <= 20 && kills >= 1) {
    return pick("specClutch", [
      `${who} is clutching this on ${health} HP. Disgusting. Respect.`,
      `${health} HP and ${who}'s still winning fights. Shit's unfair.`,
      `${who}'s alive on ${health} HP and going for it. That looks illegal.`,
      `Look at ${who}. ${health} HP, ice in the veins. Take notes, ghost.`,
    ]);
  }
  return null;
}

/** Locally-derived clock callout: ~35 seconds left, no plant yet. */
export function lateRoundLine(side: string | undefined): string {
  if (side === "T") {
    return pick("lateRoundT", [
      "Thirty-five seconds, no plant. Pick a site and hit it. Now.",
      "Clock's bleeding. Commit somewhere. The bomb isn't a souvenir.",
      "Tick tock. The default's over. Hit something.",
      "Stop hunting picks. Plant the damn bomb. That's the whole round.",
      "Half a minute. Plant now or donate the round.",
      "No plant. Clock doesn't give a shit. Send it.",
    ]);
  }
  if (side === "CT") {
    return pick("lateRoundCT", [
      "Thirty-five, no plant. The clock's on our payroll. Hold.",
      "No bomb down. Sit your ass tight and let them panic.",
      "Time pressure's all theirs. Camping's legal as hell right now.",
      "Half a minute. They're the desperate ones. Act like it.",
      "Hold your angles. Patience pays. Hero peeks don't.",
      "Don't chase. They have to come to you. Stay home.",
    ]);
  }
  return pick("lateRoundNeutral", [
    "Thirty seconds, no plant. Somebody's about to panic. Don't be them.",
    "Clock's getting loud, no bomb down. Someone make a damn decision.",
  ]);
}

/** Locally-derived bomb-timer callout: roughly ten seconds left on the C4. */
export function bombTenLine(side: string | undefined, fighting = false): string {
  if (side === "CT") {
    // Mid-fight: the player just got a kill — give them the clock, not a
    // "back off" order aimed at someone who's clearly winning the exchange.
    if (fighting) {
      return pick("bombTenCTFighting", [
        "Finish him. Fast. You've got fuck-all for time.",
        "Close it out. The bomb's not waiting for style points.",
        "Win it quick, then kit or quit.",
        "You've got this. Make it quick.",
      ]);
    }
    return pick("bombTenCT", [
      "Ten seconds. Not defusing? Run.",
      "It's about to pop. Clear out. Save your ass.",
      "Bail. Now. Dying to the bomb is the saddest shit in CS.",
      "Too late to stick. Walk away. Guns are expensive.",
      "That beeping's speeding up. Get gone.",
      "Drop the hero act. Off the site. Keep that rifle alive.",
    ]);
  }
  if (side === "T") {
    return pick("bombTenT", [
      "Ten seconds. Don't peek. Don't even fucking breathe.",
      "Stand still. The check clears in ten.",
      "Freeze. Statues win post-plants. Be a statue.",
      "Just exist for ten more seconds. That's the whole damn job.",
      "Almost there. Peek now and I'm flipping the desk.",
      "Nobody move. It's over. Don't get cute at the buzzer.",
    ]);
  }
  return pick("bombTenNeutral", [
    "Ten on the bomb. This ends loud or it ends quiet.",
    "Final seconds. Whatever you're doing, do it faster.",
  ]);
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
      "There you go. Keep going.",
      "That's one. Next, please.",
      "Filthy. Stay on it.",
      "Good. Breathe. Finish it.",
    ]);
  }
  // THEIR match point (a lost round ends the match — nothing left to save for)
  // or a money reset next round (the saved gear evaporates): "save" is the one
  // call that's always wrong. At OUR match point normal judgment still applies —
  // losing a round at 12-5 keeps the gear and the lead.
  if (ctx.matchPoint === "them" || ctx.moneyResetsNextRound) {
    return pick("retakeMustWin", [
      "No save. None. Everybody retakes.",
      "Saving means jack shit here. All five on site, right now.",
      "Forget the guns. They're worth zero if we lose. Go win it.",
      "All in. There's no tomorrow money. Take the site back.",
      "This one's win or fucking nothing. Send everybody.",
    ]);
  }
  const thinGear = (ctx.armor ?? 0) === 0 || (ctx.equipValue ?? 0) < 1500 || (ctx.health ?? 100) < 40;
  if (ctx.defuseKit) {
    return pick("retakeKit", [
      "You've got the kit. They clear, you stick. That's the job.",
      "Kit carrier. Congrats, you're important now. Get on the damn bomb.",
      "One job: the bomb. They shoot, you snip.",
      "You're the defuser today. Everyone else is furniture. Get to work.",
      "Forget kills. Stick that shit and win.",
    ]);
  }
  if (thinGear) {
    return pick("retakeThin", [
      "You're paper right now. All five go or you save.",
      "No armor, no hero shit. Group retake or keep the gun.",
      "That loadout's held together with tape. Full squad goes, or you don't.",
      "One bad peek ends you. Retake with everyone or just hide.",
      "Broke and brave is just broke. Five-man retake or walk away.",
    ]);
  }
  return pick("retakeGo", [
    "Gear's good. Retake as five. Trade everything.",
    "Nobody solos this shit. Pair up, swing together, punish every peek.",
    "Stack up and go. Whoever entries, refrag him. That's the plan.",
    "You're geared. Walk in with friends. Nobody dies for free.",
    "Retake time. Buddy system. Anyone entering alone gets benched.",
    "Full kit, no excuses. Hit the site as a unit.",
  ]);
}

export function deathLine(): string | null {
  // Speak rarely on death; nobody wants narration of every death.
  if (Math.random() > 0.2) return null;
  return pick("death", [
    "You're dead. Mic on. Tell them what the hell you saw.",
    "Dead. Tragic. Now talk: where he was, how lit he is.",
    "Down again. At least donate the info. Where, what gun.",
    "That's a death, not a vacation. Give the damn info.",
    "Dying's free, silence isn't. Call out what killed you.",
    "Ghosts can talk in this game. Position, weapon, go.",
    "You died. Happens a lot. Info first, sulk later.",
    "Welp. Dead body, live mic. Get the info out.",
  ]);
}

export function mvpLine(name?: string): string {
  const who = name ?? "our star";
  return pick("mvp", [
    `MVP, ${who}. The bar was on the floor. You cleared it.`,
    "Our MVP, everybody. One good round and the ego's already loading.",
    "Round MVP. Frame that shit. Might not happen twice.",
    "Look who's MVP. Same guy I yelled at all damn half. Growth.",
    `${who} gets the MVP. You get five seconds of smugness, max.`,
    "Star on the scoreboard. Enjoy it. Rent's due next round.",
    `That star's yours, ${who}. Don't ask what the competition looked like.`,
    `Hell must be chilly today. ${who} got the MVP star.`,
  ]);
}

/**
 * Round-end react for the LAST round of the first half (round 12): "keep the
 * guns / buy right next round" talk is wrong here — sides swap and money wipes.
 */
export function halfEndLine(won: boolean, ourScore: number, theirScore: number): string {
  if (won) {
    return pick("halfEndWon", [
      `Half's done, ${ourScore}-${theirScore}, and we took the closer. New side, fresh money. Win the damn pistol.`,
      `That's the half, ${ourScore}-${theirScore}, ours at the buzzer. Swap sides, wallets reset, pistol incoming.`,
      `Nice close to the half, ${ourScore}-${theirScore}. Fresh money for everyone, including them. Pistols next.`,
      `Ended the half winning, ${ourScore}-${theirScore}. Money's wiped, so the swagger resets with it. Pistol time.`,
      `Closed the half with a W. ${ourScore}-${theirScore}. Everything resets. Cash, sides, my patience. Pistols when we're back.`,
    ]);
  }
  return pick("halfEndLost", [
    `Lost the last one, ${ourScore}-${theirScore}. Money resets. Pistols don't give a shit about first halves.`,
    `That's the half, ${ourScore}-${theirScore}. Ugly ending. Good news: it all resets. Even that.`,
    `${ourScore}-${theirScore} at the break, and yeah, that last round was ass. Wipe it. New side, new bank.`,
    `Half's over, ${ourScore}-${theirScore}. Cash resets, and that whole side can't hurt you anymore.`,
    `Rough finish, ${ourScore}-${theirScore}. New side, fresh money. My halftime speech is two words: do better.`,
  ]);
}

/** Round-end react when overtime (or another OT half) follows — fresh money, no carryover. */
export function otNextLine(ourScore: number, theirScore: number): string {
  return pick("otNext", [
    `${ourScore}-${theirScore}. Overtime. Everyone gets ten grand and a fresh shot at disappointing me.`,
    `Couldn't finish it. ${ourScore}-${theirScore}. Overtime now. Ten K each. Try not to piss it away.`,
    `Tied at ${ourScore}-${theirScore}, so it's OT. Fresh ten thousand, full buys, zero excuses.`,
    `Overtime, ${ourScore}-${theirScore}. Twenty years and these still take time off my life. Everyone's rich again. Buy proper.`,
  ]);
}

export function halftimeLine(ctx: MatchContext): string {
  const our = ctx.ourScore;
  const their = ctx.theirScore;
  const score = our !== undefined && their !== undefined ? `${our}-${their}` : "the score";
  if (our !== undefined && their !== undefined && our > their) {
    return pick("halftimeAhead", [
      `Halftime, ${score}, we're up. Money resets, so the lead's the only damn thing you keep.`,
      `Up at half, ${score}. The lead carries over. The guns don't. Win the pistol.`,
      `${score} at half. Ahead, somehow. Sides swap, cash resets, and smug doesn't win pistols.`,
      `We lead ${score} at the half. Don't frame it yet. New side, broke wallets, earn it again.`,
      `Halfway done and winning, ${score}. Weird feeling, right? Swap sides, reset money, don't get cute.`,
    ]);
  }
  if (our !== undefined && their !== undefined && our < their) {
    return pick("halftimeBehind", [
      `Halftime, down ${score}. Could be worse. Barely. Fresh side, fresh money. Win the damn pistol.`,
      `We're losing ${score}. Were. Half's over, everything resets. Comeback starts at the pistol.`,
      `Down ${score} at the break. Good news: money resets. Bad news: you still have to aim.`,
      `That half was dogshit, ${score}. It's also over. New money, new side. Go take the pistol.`,
      `Break time, ${score} against us. Everyone's broke now, both teams. They've got to beat us all over again.`,
    ]);
  }
  return pick("halftimeEven", [
    `A whole half and we learned nothing. ${score}. Money resets, pistol decides.`,
    `Halftime, ${score}. Dead even. We're exactly as average as them. Fix that after the swap.`,
    `All square at the break, ${score}. New half, new money. First to blink loses.`,
    `${score} at half, a coin flip. Cash resets. Win the damn pistol and stop flipping coins.`,
  ]);
}

export function matchPointLine(forUs: boolean): string {
  return forUs
    ? pick("matchPointUs", [
        "Match point, us. Close it clean. No hero shit.",
        "One round from winning. Play it boring. Boring closes matches.",
        "We're on match point. Do not get cute. Cute is how teams lose match points.",
        "Listen up. Match point. Anybody planning a hero play, don't.",
        "This is the close-out. Hold your angles, trade properly, take zero dumb fights. That's the whole list.",
        "Smell that? That's the win. Don't fumble it on some highlight-reel bullshit. Clean round.",
      ])
    : pick("matchPointThem", [
        "They have match point. Nobody saves a thing. Win or go down shooting.",
        "Must-win round. Use every nade you own. You can't take them with you.",
        "Lose this and we're queueing again. No saving guns for a round that won't fucking exist.",
        "Match point against us. So what. Win this round, then shut them the hell up.",
        "Saving is canceled. Take the round or the guns won't matter anyway.",
        "Backs against the wall. Fine. I coach better annoyed. Full send, drag them back.",
      ]);
}

export function matchEndLine(won: boolean | undefined, ourScore: number, theirScore: number): string {
  if (won === true) {
    return pick("matchWon", [
      `We won, ${ourScore}-${theirScore}. I'm a little proud. It'll pass.`,
      `Match over, ${ourScore}-${theirScore}, our way. I'd say I never doubted you, but I was there.`,
      `GG, ${ourScore}-${theirScore}. You won, I aged ten years. Fair trade, I guess.`,
      `That's a W, ${ourScore}-${theirScore}. You played some actual damn CS today. Briefly, but still.`,
      `Scoreboard reads ${ourScore}-${theirScore}. That was good, damn it. There, I said it. Never again.`,
      `Dub secured. ${ourScore}-${theirScore}. Screenshot it. Future you won't believe it.`,
    ]);
  }
  if (won === false) {
    return pick("matchLost", [
      `Match lost. ${ourScore}-${theirScore}. I've seen worse losses. Give me a minute, I'll remember one.`,
      `${ourScore}-${theirScore}. That's a loss. The queue button still works, thank god.`,
      `We lost ${ourScore}-${theirScore}. The game gave us chances. We said no thanks. Again soon.`,
      `Well, that was shit. ${ourScore}-${theirScore}. Sip of water, shake it off, queue again.`,
      `Final's ${ourScore}-${theirScore}, them. Don't queue angry, queue focused. There's a difference, allegedly.`,
      `That one's over, ${ourScore}-${theirScore}. Brutal. One more game. Spite is excellent fuel.`,
    ]);
  }
  return pick("matchOver", [
    `Match is over, ${ourScore}-${theirScore}. I showed up late, so you tell me how to feel.`,
    `That's a wrap at ${ourScore}-${theirScore}. Missed most of it, so I'll assume you were incredible. Next game.`,
    `Game's done, ${ourScore}-${theirScore}. No idea how that went, which might be a blessing.`,
  ]);
}
