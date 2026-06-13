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
export function mapDisplayName(raw: string): string {
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
      "Plant's down, forty seconds, so quit standing there like it's a moment of silence.",
      "They planted. Shocking. Regroup and hit it together, not one at a time like lemmings.",
      "Bomb's beeping, geniuses. Group up CT side and hit as five, nobody dies being a hero.",
      "Forty on the clock, plenty of time to die alone if you rush it. So don't.",
      "Site's lit. Don't dry peek it solo, wait for the five-man, please.",
      "Stop trickling in one by one to feed them. Wait up, stack, retake the damn site together.",
      "Down a bomb, not down a brain. Group up, util ready, retake as one push.",
      "Quit the hero retake fantasy. Stack up and we take this site together or not at all.",
      "Regroup, stop wandering off like a cat that heard a can opener. Hit it together.",
      "Forty seconds, five players, one bomb. Do the math and group the hell up.",
    ]);
  }
  if (ourSide === "T") {
    return pick("plantedT", [
      "Bomb's down. Try not to undo that in the next ten seconds.",
      "Crossfires up, breathe through the timer, no hero peeks. A body on the bomb wins it.",
      "Hold your angles, let the clock cook them. You don't gotta find anybody.",
      "Nice plant. Now sit on it instead of running off to die alone.",
      "Clock's ticking for them now, not us. So quit re-peeking like an idiot.",
      "We planted, dipshit. That means you stop peeking and let them come.",
      "Living beats fragging right now. Park your ass on the crossfire.",
      "Don't go hunting. They need the site, you just need a pulse and a watched angle.",
      "Pinch the C four so tight it leaves a fingerprint, then just chill.",
      "Sit on your crossfire like a cat on a warm laptop. Nobody peeks out.",
      "Treat that doorway like a hot stove. Don't touch it, just watch it.",
      "Post-plant means patience, not some dumbass solo re-peek that throws the round.",
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
    `Do it again, but on purpose this time, and we'll call it ${ourScore}-${theirScore} progress.`,
    `That's a round. Cool. ${ourScore}-${theirScore}, try not to throw a parade.`,
    `Round's ours, ${ourScore}-${theirScore}. I'd clap but my hands are busy.`,
    `Congrats, ${ourScore}-${theirScore}, you cleared the bar I set on the floor.`,
    `Nice, ${ourScore}-${theirScore}. Wake me when you string two together.`,
    `One round won, ${ourScore}-${theirScore}. Whoop-de-shit, run it back.`,
    `Calm your tits, it's ${ourScore}-${theirScore}, not match point.`,
    `That's one, ${ourScore}-${theirScore}. Stack util, hit it again, no ego peeks.`,
    `Don't get cocky, it's ${ourScore}-${theirScore}, not a damn trophy.`,
    `Look at that, ${ourScore}-${theirScore}, you stumbled into that round like a cat onto a keyboard.`,
    `You won that like a vending machine dropping two snacks, ${ourScore}-${theirScore}. Pure accident.`,
    `We're up ${ourScore}-${theirScore} and your aim's still wandering like a lost Roomba. Lock in.`,
  ]);
}

export function roundLostLine(ourScore: number, theirScore: number): string {
  return pick("roundLost", [
    `Reset. We're ${ourScore}-${theirScore}, not exactly a highlight reel.`,
    `Lost it. ${ourScore}-${theirScore} now, try to surprise me next round.`,
    `Onto the next. ${ourScore}-${theirScore}, and no, that whiff wasn't bad luck.`,
    `Alright, ${ourScore}-${theirScore}. I'd say tighten up, but I've met you.`,
    `Dropped that one. ${ourScore}-${theirScore}, breathe, stop ego peeking into four guys.`,
    `Cool gun you just gave them. ${ourScore}-${theirScore}. Reset, play for the trade.`,
    `Gone. ${ourScore}-${theirScore}, regroup, and quit throwing your damn nades at the wall.`,
    `That round was donated. ${ourScore}-${theirScore}. Trade your teammates next time, dipshit.`,
    `Down ${ourScore}-${theirScore} and you're still dry peeking into three? Wake up.`,
    `Whiffed it, lost it, ${ourScore}-${theirScore}. Reset and actually hold an angle.`,
    `We're ${ourScore}-${theirScore}. Stop lurking solo and dying, play with the team.`,
    `That was a clown round, ${ourScore}-${theirScore}. Quit ego peeking and refrag for once, damn it.`,
  ]);
}

export function killLine(roundKills: number, name?: string): string | null {
  // Third-person fallback so templates like "${who} drops a triple" stay grammatical.
  const who = name ?? "our star";
  if (roundKills >= 5) {
    return pick("killAce", [
      "An ace. Damn it. That was clean.",
      "Five for five. Shit. Okay. Respect.",
      `Gave them a gun, took it back five times. Fine. Ace. Whatever, ${who}.`,
      `Sit down, ${who}. Five kills. My standards are still on the floor.`,
      `Oh look, ${who} found all five. Somebody mark the calendar.`,
      `Well damn, ${who}, an ace. Didn't expect competence today of all days.`,
      `${who} aced it, won the round. I'll allow it. Don't get used to me being nice.`,
      `Where was this last round, ${who}? Oh, now you wanna hit your shots. Five up.`,
      "Fine. That was filthy. Shut up about it. Ace.",
      `Didn't trade, didn't die, just ran it down their throat. ${who} with all five.`,
      `Hate that I gotta say it. ${who} clutched the ace. Clean.`,
      `Dry peeked four of 'em and lived. The hell. ${who} aced it, round's over.`,
    ]);
  }
  if (roundKills === 4) {
    return pick("killQuad", [
      `That's four, ${who}. One more and it's an ace, which I assume we'll find a way to ruin.`,
      `Look at you, ${who}, four kills. Now go whiff the ace like we both know you will.`,
      `That's four, ${who}, one off the ace. No pressure, just everything you'll choke on later.`,
      `Quad, ${who}. Last guy's low, hold the angle, don't ego peek it into the bin.`,
      `Four down, one off the ace, ${who}. Refrag him clean. Or don't, I'm braced either way.`,
      `Four kills, ${who}. Don't shit the bed on the fifth.`,
      `Nice quad, ${who}. Blow the ace and I'll never let it go.`,
      `Holy shit, four for ${who}. Trade the last clown and it's an ace.`,
      `Damn, ${who}'s got the quad. Don't dry peek the ace away like an idiot.`,
      `Four bodies, ${who}. Swing wide, find the last rat, finish the ace.`,
      `Quad locked, ${who}. Now reload and go hunt the survivor.`,
      `That's four, ${who}. Fifth one's hiding like the last fry in the bag. Go dig him out.`,
    ]);
  }
  if (roundKills === 3) {
    return pick("killTriple", [
      `Grudging respect, ${who} — that's a triple. Now try not to throw it.`,
      `Three frags, ${who}. Statistically that's your peak, so quit while you're ahead.`,
      `Oh look, ${who} can play. Three down. Don't ruin it with an ego peek.`,
      `Not bad, ${who}, a triple. Low bar, but you cleared it. Play it out.`,
      `Triple for ${who}. I'm stunned. Play safe and bank the round.`,
      `Fine, ${who}, you got three. Trade with your teammate, don't solo it.`,
      `Three kills, ${who}, useful for once. Now stop dry peeking.`,
      `Well damn, ${who} woke up — that's three. Now lurk smart and close it out.`,
      `Who knew ${who} had a triple in them. Play the retake, don't overstay.`,
      `Three down and I bet ${who} thinks he's god now. Just trade the next one and shut up.`,
      `Oh shit, ${who} can shoot. Three down. Hold an angle, quit running it down mid.`,
      `Look at this asshole going off — three kills. Don't overstay and hand it back, ${who}.`,
      `Beautiful, ${who}, a triple. Crosshair placement works. Hold here, don't throw the lead.`,
      `Holy shit, a triple. Now park your ass on cover and don't gift them the refrag, ${who}.`,
    ]);
  }
  // Singles and doubles stay silent: play-by-play of routine kills is noise —
  // the multikill escalation and the special-kill stories carry the hype.
  return null;
}

export function knifeKillLine(name?: string): string {
  const who = name ?? "our star";
  // "Get Leetify" is the CS in-joke for telling a humiliated victim to go look
  // up their stats — knife kills are exactly the moment for it (user request).
  return pick("knifeKill", [
    `Filthy knife kill, ${who}. Tell that guy to go check his Leetify.`,
    `${who} stabbed him. Somebody go tell that guy to get Leetify.`,
    `He brought a rifle, ${who} brought a butter knife. Guess who's on Leetify tonight.`,
    `Knife kill from ${who}. That guy's downloading Leetify as we speak.`,
    `Cute. ${who} got the knife. Hope it was worth giving away the gun.`,
    `${who} knifed his ass. Pure disrespect, no notes.`,
    `Poor bastard. Walked into ${who} and a knife. Rough.`,
    `Blade out, body down. ${who} just humiliated that guy.`,
    `${who} carved that dude up. Run it back, you absolute psycho.`,
    `Damn, ${who} just turned a gunfight into a petting zoo. Knife kill.`,
    `${who} went full caveman and knifed him. Somehow it worked.`,
    `Knifed him so clean his crosshair filed for divorce. Nice one, ${who}.`,
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

export function nadeKillLine(nade: "he" | "fire", kills = 1): string {
  if (nade === "fire") {
    // A molotov that burned a clustered group — the area-denial multi-kill.
    if (kills >= 2) {
      return pick("mollyKillMulti", [
        "A couple of them stacked up right in the fire. Easiest kills you'll get all map.",
        "Look at that, the molly did your aiming for you. Whole group cooked.",
        "Damn, that molly cooked more than one of them. Area denial my ass, that's a frag.",
        "Whole group bunched up in the flames. They gift-wrapped that one for ya.",
        "They walked into the molly together like a damn group tour. Roasted.",
        "One molly, the whole group toasted. Shit, they walked right into the oven.",
        "More than one went down to the fire. That's a beauty of a burn off util.",
        "They huddled in your fire like it was a free space heater. Group toasted.",
      ]);
    }
    return pick("mollyKill", [
      "Fire did all the heavy lifting and you grabbed the kill. Cute.",
      "One molly kill. Standing in a fire pit is not a frag.",
      "Wow. The molotov got an assist on its own kill. You just watched.",
      "Cooked one alive. Real high-skill stuff, sitting in flames.",
      "Congrats, the incendiary outfragged you that round.",
      "No fucking way you let the fire trade for you. Pathetic and lazy.",
      "Molly does the damage and you're out here taking the bow. Embarrassing.",
      "You threw a puddle and a guy died in it. Hell of an aim diff.",
      "Dude burned to death standing still, like a hot dog nobody flipped.",
      "That kill came from a campfire, man. You just happened to be nearby.",
    ]);
  }
  // "Nade"/"grenade", never a bare "HE" — TTS reads that as the pronoun.
  if (kills >= 2) {
    return pick("heKillMulti", [
      "Couple bodies off that nade. Don't let it go to your head.",
      "So the nade does the fragging now. Good to know.",
      "Wiped the whole stack with a nade. Imagine doing that with a gun.",
      "Damn, the whole group huddled up and you cooked the lot.",
      "Multiple frags off one toss. That's just rude as shit.",
      "Nice nade. Real impressive, killing guys who can't shoot back.",
    ]);
  }
  return pick("heKill", [
    "One kill off a nade. That's the whole highlight reel, huh.",
    "Aw, the grenade did your aiming for you. Cute.",
    "Damn, the nade outfragged your rifle this round. Tracking.",
    "Look at that, didn't even need to aim. One nade, one body.",
    "Threw a nade, killed a guy. Get a goddamn medal for the cheapest kill on the server.",
    "Cooked one with the nade. Dude got deleted by physics, embarrassing for him.",
    "Tossed a frag and it did more work than your rifle does all game.",
    "Hell of a throw, that nade ate his whole health bar.",
    "Beautiful, you killed him with a nade you panic-chucked at a wall.",
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

/**
 * Live hype when a WIRED teammate (their OWN feed, multi-feed setups) racks up a
 * big round — distinct from teammateKillLine, which narrates from the grave while
 * the user spectates. Here the listener is usually still alive watching a friend
 * cook, so the angle is "a teammate's doing your job" rather than "your death set
 * it up". Singles/doubles never reach this (aggregated to silence upstream).
 */
export function teammateMultiKillLine(name: string | undefined, kills: number): string | null {
  const who = name ?? "your guy";
  if (kills >= 5) {
    return pick("teamAce", [
      `${who} just aced the round. Absolutely filthy. Clip it.`,
      `An ace from ${who}. I'm impressed and I hate it.`,
      `${who} cleared the whole enemy team solo. Disgusting work.`,
      `Five for ${who}. One-man army shit, and it actually worked.`,
      `${who} aced it. Frame that one before they deny it.`,
      `Whole enemy side gone, courtesy of ${who}. Hell of a round.`,
    ]);
  }
  if (kills === 4) {
    return pick("teamQuad", [
      `${who}'s on four. Somebody's cooking out there.`,
      `Four kills for ${who}. Back them up and close it out.`,
      `${who} with a quad. The ace is right there — help if you can.`,
      `That's four for ${who}. Trade for them, don't let it go to waste.`,
      `${who}'s hunting the fifth. Don't leave them swinging alone.`,
      `Damn, ${who}'s got four. Give them the info and let them work.`,
    ]);
  }
  // 3 is the floor — the aggregate-not-multiply rule mutes anything smaller.
  return pick("teamTriple", [
    `${who} with a triple. Nice. Keep it rolling.`,
    `Triple for ${who}. They're awake, finally.`,
    `${who}'s got three. Back them up out there.`,
    `That's a triple from ${who}. Help them close the round.`,
    `${who} popped three. Don't let it go quiet now.`,
    `Three for ${who}. So somebody can aim. Good to know.`,
  ]);
}

/**
 * TWO wired teammates went off in the same beat — one merged hype line instead of
 * two stepping on each other in the shared 'teammate' channel. Caps at TWO names;
 * 3+ collapses to a crowd line; 1 falls back to the single-name hype (defensive).
 */
export function teammateMultiKillDuo(names: string[]): string | null {
  const real = names.filter((n): n is string => !!n);
  if (real.length >= 3 || real.length === 0) {
    return pick("teamDuoSquad", [
      "The squad's popping off out there. Trade for whoever's swinging and close it.",
      "Whole crew's cooking right now. Feed the info, let them work.",
      "Everybody's hitting their shots for once. Don't let it go quiet — back the plays.",
      "The squad's on a heater. Keep the trades coming and shut the round down.",
    ]);
  }
  if (real.length === 1) return teammateMultiKillLine(real[0], 3);
  const [a, b] = real;
  return pick("teamDuo", [
    `${a} AND ${b} both going off. Hell of a round. Help close it out.`,
    `Double trouble — ${a} and ${b} are both cooking. Trade for them.`,
    `${a} and ${b} are popping off together. Don't let either of them swing alone.`,
    `Both ${a} and ${b} on a tear. Feed the info and let it ride.`,
    `${a} and ${b} carrying at the same damn time. Back them up.`,
  ]);
}

/**
 * Last-man-standing clutch call (multi-feed, whole-team certainty only — the
 * roster won't emit the event unless the full squad is wired in, so the line can
 * commit to "last one alive" instead of hedging). Names the survivor; addresses
 * them directly when it's the listener's own primary feed.
 */
export function lastManStandingLine(name: string | undefined): string {
  if (!name) {
    return pick("lastManSelf", [
      "It's all you now. Last one up. Win it and I'll shut up for a round.",
      "You're the last one breathing. No backup coming. Make them work for it.",
      "Everybody's dead but you. Clutch it or don't — just make it ugly for them.",
      "Last man. Take your time, trade your shots, no hero rush. It's yours to lose.",
      "You're alone up there. Use the clock, pick the fight, win the damn round.",
      "Squad's wiped, you're it. Quiet, slow, deadly. Go.",
    ]);
  }
  return pick("lastManMate", [
    `${name}'s the last one alive. Everybody dead give one callout, then zip it.`,
    `It's on ${name} now. Last man up. Feed them what you saw and let them cook.`,
    `${name}'s clutching for all of us. Eyes on, mouths shut.`,
    `Down to ${name}. Last breath on the team — quick info, then silence.`,
    `${name} alone now. One clean callout each, then let them work.`,
    `All on ${name}, last one standing. Make us look good.`,
  ]);
}

/** Locally-derived clock callout: ~35 seconds left, no plant yet. */
export function lateRoundLine(side: string | undefined, hasBomb = false): string {
  // The player is personally carrying the C4 — the generic "someone plant"
  // nudge lands very differently when the someone is them.
  if (side === "T" && hasBomb) {
    return pick("lateRoundCarrier", [
      "That's a bomb on your back, not a camera. Thirty-five seconds. Go plant.",
      "Walking the bomb around like a dog. Thirty seconds. It needs a site, now.",
      "A or B, your pick, but pick one. You're carrying. Thirty-ish seconds.",
      "It's you, the bomb, and thirty seconds. One of you better fucking commit.",
      "Holy shit, you still have the bomb. Half a minute. Get it down somewhere.",
      "The bomb doesn't plant from your pocket. Find a site, walk it in.",
      "You've got the C4. That makes you the plan. Clock's at thirty-five. Plant.",
      "Quit scouting. You're the delivery guy and the package is late. Any site. Go.",
    ]);
  }
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

/**
 * Late-round T nudge naming the WIRED teammate personally carrying the C4 — used
 * when the primary is dead/spectating (so lateRoundLine's second-person carrier pool
 * would aim 'go plant' at a corpse). Quieter, third-person: one callout to the squad.
 */
export function lateRoundCarrierNamed(name: string): string {
  return pick("lateRoundCarrierNamed", [
    `${name}'s got the bomb and thirty-five seconds. Somebody get them onto a site.`,
    `Clock's bleeding and ${name}'s still holding the C4. Plant it, find them a way in.`,
    `${name} is the plan — they've got the bomb. Half a minute. Get it down.`,
    `Thirty-five left, ${name}'s carrying. Quit defaulting, walk the bomb in.`,
    `Bomb's on ${name} and the clock doesn't care. Pick a site, escort them.`,
    `${name}'s the delivery guy and the package is late. Any site. Get them there.`,
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
      "Bomb's down, ten seconds, you're nowhere near it. Run, save the rifle.",
      "Nobody's shooting you, so quit babysitting the bomb and bail with the gun.",
      "Walk away from that thing like it owes you money. Keep the rifle.",
      "You can't defuse from there, champ. Back out, save the gun.",
      "Get the hell off site. Dying to the timer is pathetic. Save the gun.",
      "That bomb's a cooking timer now. Don't be the dinner, peel out with your rifle.",
      "No defuse, no fight, ten on the clock. Bail, don't be a stat.",
      "Eating a tick with a full rifle is the dumbest way to die, dipshit. Leave.",
    ]);
  }
  if (side === "T") {
    // Just got a kill near the planted bomb — almost certainly fighting a CT
    // going for the defuse. Back the play; a "freeze" order would be wrong here.
    if (fighting) {
      return pick("bombTenTFighting", [
        "You're already swinging — drop him and plant your ass back on the bomb.",
        "That's the defuser, probably. Kill him and sit on it.",
        "Win that duel fast, then freeze. The bomb does the rest.",
        "One more and it's over. Trade him, then hold the bomb.",
        "Finish him, don't chase. Park back on the C four.",
      ]);
    }
    // GSI never tells a T player whether a CT is defusing, so the only honest
    // call is BOTH branches: peek to stop a defuse, hold if it's clear. (A live
    // session flatly said "freeze, don't peek" while CTs were mid-defuse.)
    return pick("bombTenT", [
      "Hear a beep, go kill it. Hear nothing, do nothing. Ten on the clock.",
      "If anyone's tapping it, peek and stop the defuse. Otherwise just sit there and breathe.",
      "Defuse going? Peek and clap him. No defuse? Plant your ass down, don't give a free pick.",
      "If some CT's crouched on that bomb, ego peek and trade it. If it's dry, just hold.",
      "Someone defusing? Stop it now or we lose. Nobody there? Hold your angle, the bomb works.",
      "You hear tapping, swing it right now. Otherwise hold this damn angle and let it cook.",
      "Treat that bomb like a smoke alarm. CT poking it, go shut his ass up. Dead quiet, just hold.",
      "Picture a CT crouched there sweating. If that's real, swing and frag him. If the site's dead, hold and watch it pop.",
      "Ten left and you can't see if a CT's got their nose on it. Peek and check, kill the defuse, otherwise sit tight.",
    ]);
  }
  return pick("bombTenNeutral", [
    "Ten on the bomb. This ends loud or it ends quiet.",
    "Final seconds. Whatever you're doing, do it faster.",
  ]);
}

/**
 * Canned fallback for the tactical-timeout call (LLM-less setups): 4+ straight
 * losses with a timeout in the bank. With the LLM enabled the freezetime
 * prompt folds the timeout into the buy call instead.
 */
export function timeoutCallLine(): string {
  // No "N in a row" claims here: GSI's loss counter decays on a win instead of
  // resetting, so a literal streak number could be wrong out loud.
  return pick("timeoutCall", [
    "Take the timeout, please. Even I need a minute, and I'm sitting down.",
    "Scoreboard looks like a crime scene. Take the fucking tac and stop donating rounds.",
    "Vote the timeout, people. A short break where nobody dies. Imagine that.",
    "Saving the tactical for what, another ass-kicking? Use it. Catch your breath.",
    "Still digging, huh? Timeout. Shovels down, figure out where this went sideways.",
    "Timeout won't fix your aim, but breathing might. Hit it. Right now.",
    "We've burned through plans A, B, and C. Timeout. Go find us a damn D.",
    "Good news: timeouts are free. Bad news: everything else. Call it, regroup, run it back.",
  ]);
}

/**
 * Mini-speech for OUR tactical timeout — the canned fallback when the LLM is
 * off. 30 seconds of pause is the one mid-match moment with room for this.
 */
export function ourTimeoutSpeechLine(ctx: MatchContext): string {
  // The timeout event fires on ANY of our tactical timeouts — only frame it
  // as a crisis when the scoreboard actually says so (a team 10-3 up calls
  // pauses too, and "stop the bleeding" would just be wrong out loud).
  const behind =
    (ctx.ourScore !== undefined && ctx.theirScore !== undefined && ctx.ourScore < ctx.theirScore) ||
    (ctx.ourLossStreak ?? 0) >= 3;
  if (!behind) {
    return pick("ourTimeoutSpeechNeutral", [
      "Alright, thirty seconds. Nothing's broken, so don't fix it — same trades, same calls, no hero variance. Decide the next buy as five right now. Back to work.",
      "Our pause, our plan. Use the breather: pick the next site call and the buy, one voice, five players. Don't overthink a good thing.",
      "Use the thirty seconds. Water, breathe, one call for next round and everybody honors it. We're in a decent spot — let's not invent a problem.",
    ]);
  }
  return pick("ourTimeoutSpeech", [
    "Look at me. Whatever that was, it's over. Quit dry-peeking AWPs like the bullet's gonna apologize — wait for a flash or don't peek. Everyone buys next round, same time, same plan. The bleeding stops this round.",
    "Huddle up. They're not better than us — we're just dying in five different zip codes. Stick together: one pack, one site, every time. Buy as a team next round and play this game like we've met before. I believe in you, unfortunately.",
    "Timeout's ours, so use it. We're getting picked off one by one like a nature documentary. Buddy up and trade — nobody dies for free anymore. Match the buy next round, all five, same call. Still a winnable damn game.",
    "Eyes up. We keep throwing every grenade in the first twenty seconds, then retaking sites with harsh language. Hold your util for the retake. Next buy is a team decision, five voices, one answer. Water break's over, back to work.",
    "Nobody panic, it's a losing streak, not a funeral. We die in ones and twos because we play in ones and twos. Five bodies, one fight. Match buys next round, everyone or no one. Go be a team for once.",
    "Same clip on loop: dry peek, instant trip to spectator cam. Cut it out — somebody flashes before anybody swings. Next round we make one money call and everybody honors it. Unclench, we're still in this.",
  ]);
}

/** One dry jab when THEY burn their tactical timeout. */
export function theirTimeoutLine(): string {
  return pick("theirTimeout", [
    "Their timeout. That's panic with a thirty-second timer. Don't lose the rhythm.",
    "Somebody over there is getting an ass-chewing right now. Don't go cold waiting.",
    "They're calling a meeting about us. Flattering. Stay locked in.",
    "Oh look, a timeout. You did that. Finish the damn job.",
    "We're in their heads enough they need a pause. Don't fucking wander out.",
    "They're in there drawing arrows on a whiteboard. Stay loose.",
    "They need a breather, we don't. Keep that trigger finger twitchy.",
    "Timeout's theirs. We just stand here looking dangerous. Stay ready.",
  ]);
}

/**
 * Wrapper for the spoken Leetify recap — the canned fallback when the LLM is
 * off. The {stats} slot takes a comma-separated numbers sentence verbatim.
 */
export function leetifyRecapLine(map: string | undefined, statsSentence: string): string {
  const where = map ? mapDisplayName(map) : "that last one";
  // Result-agnostic on purpose: the wrapper doesn't know if the numbers are
  // good or bad, so no loss-coded verdicts and no claims about what the
  // player's been doing while Leetify chewed on the demo.
  return pick("leetifyRecap", [
    "Match report time — Leetify scored {map} for us. {stats}. Now everybody give me a damn lap.",
    "Leetify finished chewing through the {map} demo. {stats}. Brave little website.",
    "Verdict's in from Leetify on {map}. {stats}. Numbers don't give a shit about feelings.",
    "Leetify says the {map} tape doesn't lie. {stats}. Take it up with the spreadsheet.",
    "Stick this on the fridge: Leetify's {map} numbers. {stats}. I'm choosing not to comment.",
    "Took a minute, but Leetify coughed up the {map} numbers. {stats}. Frame it or burn it, your call.",
  ])
    .replace("{map}", where)
    .replace("{stats}", statsSentence);
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
  // OUR match point: a lost round keeps the gear AND the lead (still match point
  // next round), and we can't see alive counts — so the SAVE is a fully valid
  // call, not a thing to talk anyone out of. Present it as the equal option a
  // live session's pushy "retake it, close it out" failed to (the player was
  // last alive and correctly saving).
  if (ctx.matchPoint === "us") {
    return pick("retakeMatchPointUs", [
      "Match point's ours. A lost round keeps the gear and the lead. Clean retake if it's there, otherwise save it, no hero shit.",
      "We're on match point. Don't throw the kit on a dumb retake. Five-man clean, go. If not, save and close it next round.",
      "Freeroll round, basically. A loss costs nothing. Take it back only if it's clean, otherwise bank the gun.",
      "Match point, so relax. Can't tell your numbers from here. If it's clean, retake. If not, save it and we win the next.",
    ]);
  }
  // Events ITEM 8: whole squad wired (rosterComplete) — we know OUR alive count, so
  // make a numbers call instead of the gear-only hedge, but still hedge the enemy
  // (no kill feed). Falls through to the gear pools when team is absent/partial.
  const team = ctx.team;
  if (team?.rosterComplete && typeof team.aliveWired === "number") {
    const alive = team.aliveWired;
    if (alive <= 1) {
      return pick("retakeNumbers1", [
        "Last of us alive. Don't dry-swing it — use the kit if you've got it, play the clock, take one fight at a time.",
        "You're the only one up. No hero retake. Bait a peek, trade if you can, otherwise save the gun.",
        "One of us left. Numbers are bad. Play for the kit or the clock, not a 1-v-whatever.",
      ]);
    }
    if (alive === 2) {
      return pick("retakeNumbers2", [
        "Two of us up. Hit it together, same chok, trade everything. If they swing first, back off and save.",
        "Just the two of us. No solo entries — one flashes, one swings, refrag clean. Bail if it's not there.",
        "Two-man retake. Pair up tight, take the same fight. Dunno their numbers, so don't overcommit.",
      ]);
    }
    return pick("retakeNumbers3", [
      "Numbers are good, full squad up. Hit it as a group, every entry gets a trade. Drown the site.",
      "Three-plus of us alive. Stack a choke, swing together, refrag everything. Take it back as a unit.",
      "We've got the bodies. Coordinate the hit, trade hard. Can't see them, but the numbers are ours.",
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

export function deathLine(cause?: "fire" | "blind"): string | null {
  // A burned/blind death is a named, roast-worthy way to go — speak it reliably
  // (a live session burned to death and the coach said nothing). The 25s death
  // cooldown still keeps it from nagging on a string of deaths.
  if (cause === "fire") {
    return pick("burnedDeath", [
      "Standing in the molly, are we. Bold strategy.",
      "Cooked alive 'cause you couldn't take two steps. That's on you.",
      "That's a molly, not a campfire. You don't sit and roast marshmallows in it.",
      "Floor was literally orange and you parked there. Fire's not decorative, move out.",
      "Fried to death 'cause flames weren't a hint. Next time fucking move out the molly.",
      "You died medium-well in there. Damn near a rotisserie. The fire wasn't a suggestion.",
      "Walked into the molly like a warm bath, came out a brisket. Step out next time.",
      "Burned down standing still like a dumbass. You step out of fire, that's the whole tip.",
    ]);
  }
  if (cause === "blind") {
    return pick("blindDeath", [
      "Couldn't see a thing and still pushed. Bold. You were dead the second you blinked.",
      "Shooting at sound while blind, real veteran move. Turn away from the pop, every time.",
      "Knew you'd die there the second that flash popped. Spin away from it, dipshit.",
      "Spraying at nothing with a white screen, classy. You can't trade what you can't see.",
      "Why are you fighting fully flashed? Turn your ass around next time.",
      "You ate that flash and kept peeking. That's how you get dinked blind.",
    ]);
  }
  // Generic death: speak rarely; nobody wants narration of every death.
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
      `Half's done, ${ourScore}-${theirScore}, and we took the closer. New side, fresh money. Same standards.`,
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

/** Round-end react when a TIED reset boundary sends the match to (more) overtime. */
export function otNextLine(ourScore: number, theirScore: number): string {
  return pick("otNext", [
    `${ourScore}-${theirScore}. Overtime. Everyone gets ten grand and a fresh shot at disappointing me.`,
    `Couldn't finish it. ${ourScore}-${theirScore}. Overtime now. Ten K each. Try not to piss it away.`,
    `Tied at ${ourScore}-${theirScore}, so it's OT. Fresh ten thousand, full buys, zero excuses.`,
    `Overtime, ${ourScore}-${theirScore}. Twenty years and these still take time off my life. Everyone's rich again. Buy proper.`,
  ]);
}

/**
 * Round-end react at the MID-overtime side swap (round 27, 33, ...): OT is
 * already running and the score is never tied here — "tied, overtime now"
 * lines would be flatly wrong, but the money still resets to ten grand.
 */
export function otHalfLine(ourScore: number, theirScore: number): string {
  return pick("otHalfSwap", [
    `${ourScore}-${theirScore}. OT sides swap, money's back to ten grand. Stay locked in.`,
    `Overtime rolls on, ${ourScore}-${theirScore}. Swap sides, fresh ten K each. Finish this.`,
    `${ourScore}-${theirScore} in overtime. New half, wallets reset to ten grand. Close it out already.`,
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
