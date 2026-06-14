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
 * Returns "" for an empty pool (callers guard against falsy text).
 */
export function pick(poolName: string, pool: string[]): string {
  if (pool.length === 0) return "";
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
      "Match found. No map yet. Whatever it is, you'll find a way to whiff on it.",
      "We're in. No clue where yet. Surprise me. Pleasantly, for once.",
      "Queue popped. Wherever we land, buy armor and aim at heads.",
      "Here we go again. Map unknown. Wake the hell up, warmup's over.",
      "Match found. Map's a mystery. Your bad habits aren't, though.",
      "We're in. Don't know the map. Crosshair up, brain on, ego off.",
      "Queue's done. Wherever this lands, play it like the score matters. It does.",
      "Loaded in. No map yet. Lock in now so I don't have to yell later.",
    ]);
  }
  const map = mapDisplayName(rawMap);
  return pick("matchStart", [
      `${map}. Great. Let's see what we ruin today.`,
      `Match found. ${map}. God help us all.`,
      `We're on ${map}. Pistol first. Don't do anything weird.`,
      `Oh good, ${map}. Home of your worst whiffs. Let's add to the collection.`,
      `Here we go, ${map}. Crosshair at head height. It's free and you still won't do it.`,
      `New match on ${map}. Keep it simple and maybe we steal a few.`,
      `Back on ${map}. Same shit, new lobby.`,
      `Fresh game on ${map}. Zero deaths so far. Career best. Don't fuck it up.`,
      `${map} it is. You know this map. Act like it for once.`,
      `We drew ${map}. Trade your deaths, hold your angles, win pistol.`,
      `${map}. Cute. Try not to feed first blood every single round.`,
      `Match up on ${map}. Warmup's over and so are my low expectations.`,
      `${map} again. Last time was a horror show. Anything's better than that, so clear the bar.`,
      `We're loaded on ${map}. Play the map, not the highlight reel in your head.`,
      `${map}. Good map to look competent on. Big ask, I know.`,
    ]);
}

/** B6 — append a named-drop coda to a buy line when the primary is already kitted
 *  with spare cash and a wired teammate is broke and ALIVE. Keyed on MONEY only (a
 *  friend's equipValue is never reported — only the primary's own gear is readable),
 *  beneficiary-framed. LLM-off parity with the freezetime prompt's drop logic;
 *  returns the line unchanged when there's no clean drop to call. */
function appendDrop(line: string, ctx: MatchContext, droppedTo?: Set<string>): string {
  if (ctx.roundKind === "pistol") return line; // pistols: everyone's at 800, no drops
  const econ = ctx.team?.econ;
  if (!econ || econ.length < 2) return line;
  // The donor must be the PRIMARY (their own gear is the only readable gear),
  // already kitted (won't spend the cash on themselves) with enough to spare a rifle.
  const me = econ.find((e) => e.isPrimary);
  if (!me || (me.equipValue ?? 0) < 3500 || (me.money ?? 0) < 2700) return line;
  const broke = econ
    .filter((e) => !e.isPrimary && e.alive !== false && typeof e.money === "number" && e.money < 2000 && e.name)
    .sort((a, b) => (a.money as number) - (b.money as number))[0];
  if (!broke) return line;
  const who = broke.name as string;
  // Anti-repeat: the economy cooldown is shorter than a round, so without a latch
  // this would re-name the same broke friend freezetime after freezetime. The caller
  // owns the per-match set (cleared at matchStart), mirroring weakLinkCalled.
  if (droppedTo?.has(who)) return line;
  droppedTo?.add(who);
  return `${line} ${pick("dropCoda", [
      `And ${who}'s broke, sling them a rifle, you can afford it.`,
      `${who}'s got nothing. Drop them a gun, quit hoarding.`,
      `You're loaded, ${who} isn't. Drop them something that shoots.`,
      `${who}'s running a pistol. Drop them a rifle, you've got the cash.`,
      `Spare a gun for ${who} while you're rich. Drop one, don't be cheap.`,
      `${who} can barely afford ammo. Sling them a rifle and even the buy out.`,
    ])}`;
}

/** Economy advice for freezetime, from own money/equipment + team loss streak.
 *  `droppedTo` (optional, owned by the engine, cleared at matchStart) latches the
 *  named-drop coda to once per recipient per match. */
export function economyLine(ctx: MatchContext, droppedTo?: Set<string>): string | null {
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
      "Pistol time. Buy armor or buy a flash. Then walk in together, not in a conga line.",
      "Eight hundred each. Armor or util on top of the Glock. Stack up and hit the same fight.",
      "It's a pistol round. Kevlar or util, not both, you can't afford both. Five-man it.",
      "Opening pistol. Grab armor or a nade, then play together. Solo entries die for nothing here.",
      "Glock round. One purchase, armor or util, then group up and trade every kill.",
      "Pistols only, obviously. Armor or a flash each. Now move as one and don't lone-wolf it.",
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
      "Their match point. Save a dollar and the game's over. So don't. Full buy.",
      "This is the round. Lose it and you save for nothing. Buy everything, win it.",
      "One more and they win the whole thing. Drain the wallet. Gun, armor, nades, go.",
      "Last stand. There's no next round to fund. Spend it all and take this one.",
    ]);
  }
  // Last round before a money wipe (half end, overtime boundaries): saved cash
  // and gear evaporate, so the only wrong buy is no buy.
  if (ctx.moneyResetsNextRound) {
    return pick("ecoSpendReset", [
      "It's all gone at the end of this round anyway. Spend every damn cent. Force it.",
      "The bank resets after this one. Saving now just throws the money away. Buy it all.",
      "Saving into a reset. Bold plan. Terrible plan. Buy everything you can carry.",
      "Your wallet dies with this round. Take it down with you. Full force.",
      "This cash doesn't carry over. Force the buy. Dying rich is for idiots.",
      "Money zeroes out after this either way. Max the buy. Spend it angry.",
      "No point hoarding, it's all getting wiped. Empty the account, buy stupid shit, win loud.",
      "Cash wipes at the buzzer. Force everything. There's no next round to save it for.",
      "Whatever you keep, you lose anyway. So keep nothing. Full force, all five.",
      "The reset eats your savings either way. Beat it to the punch. Buy the whole menu.",
      "Wallet's getting wiped after this. Blow it all. Force the round.",
      "It all resets, so saving's pointless. Empty it now, gun and util, go win.",
    ]);
  }

  if (equip >= 3500) {
    return appendDrop(pick("ecoKitted", [
      "Wallet stays shut, you've got everything. Bring that rifle home alive.",
      "Nothing to buy. Keep the gun. That's it. That's the whole damn speech.",
      "Kitted. Zero shopping. Try dying less, it's free.",
      "Shop's closed. Don't gift-wrap the AK for them on the way out.",
      "Everything's bought. Treat the rifle like it's insured. Then remember it isn't.",
      "Geared up, util and all. The only way to fuck this up is dying for free.",
      "Inventory's full, skip the store. Dead bodies with full kits make me physically ill.",
      "Fully equipped. Per my last timeout, we do not hand out free rifles to strangers.",
      "You're loaded already. Donating rifles to their broke asses is not a strat.",
      "All set. Spend zero. A dry peek right now just hands them the gun.",
      "Full kit, no buy. Just don't throw it dying for a stat nobody asked for.",
      "You've got it all. Spend nothing and survive. Wild combo for you, I know.",
      "Geared to the teeth. Close the menu. Win the round, keep the gun.",
      "Locked and loaded. Buy zero. Play smart and that rifle sees next round.",
    ]), ctx, droppedTo);
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
      "Wallet's loaded. And util means buying it, not admiring it.",
      "Spend it. Gun, armor, grenades, all of it. Your bank account isn't winning shit this round.",
      "Big money, big buy. And get the smokes, you cheap bastard.",
      "You can afford the whole shop, so buy the whole shop. Rifle, plates, full util.",
      "Loaded wallet. Rifle and armor isn't a full buy, the nades are part of it. Get them.",
      "Max money round. Gun, kevlar, every grenade. Leave nothing in the bank.",
      "Rich and out of excuses. Full kit, full util, then go actually use it.",
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
      "Mid money. Lock the rifle and armor first. Squeeze in a nade only if it fits.",
      "Rifle and plates, that's the round. Spare cash buys a flash, not a hole in the wallet.",
      "Enough for gun and armor. Util's optional, the kevlar isn't. Buy in that order.",
      "Comfortable buy. Rifle, armor, done. One grenade if the math says yes.",
    ]);
  }
  if (money <= 1800) {
    if (losses >= 2) {
      return pick("ecoSaveStreak", [
      "Full save. The loss bonus is cooking. Next round we're rich. Touch nothing.",
      "Hands off the buy menu. Bonus is maxed. Full buy next round. Trust the math.",
      "Zero spending. That loss bonus is the only thing going right all half. It pays next round.",
      "Pistols out, dignity away. Next round it's rifles for everyone.",
      "This round's a write-off, save everything. Next round the bank opens. Don't ruin it forcing a Deagle.",
      "Don't buy shit. The bonus maxes after this. Eat this round, feast the next.",
      "Nobody buys. Bonus money lands next round, and then we shop like adults.",
      "Save this one. I know it hurts like hell. Real buy next round, promise.",
      "Full save, all five. The loss bonus pays a real buy next round. Don't blow it on a forced pistol.",
      "Park the wallet. We eat this round, the bonus funds rifles next. Buy nothing now.",
      "Save it. Forcing now wrecks the rifle round you've earned. Pistols only, no buys.",
      "Everyone saves. The bonus turns into a full buy next round if you don't touch it.",
    ]);
    }
    return pick("ecoSave", [
      "Eco. Pistols at most. Take a pick if it's free, then get out alive.",
      "Full eco. Die holding nothing, fine. Don't die holding their next damn rifle.",
      "Stack up, take one shot, leave. An eco's a robbery, not a shootout.",
      "You're broke, so pistols only. Pick or no pick, you exit breathing. No arguing.",
      "Broke-ass round. Cheap pistol, sneaky angles, and run when it goes bad. It will go bad.",
      "That money won't buy you shit. Eco, grab a pick, exit alive.",
      "Bank's empty. One lucky pistol kill beats a half-assed force. Play for that, then walk.",
      "Budget round. Spend nothing, annoy them, get out. Real guns come back later.",
      "Plan's simple. One pick, one exit, no hero movie.",
      "Eco round. Pistol only. Steal a kill if it falls in your lap, then get the hell out.",
      "You're broke. Play broke. Cheap pistol, grab a free frag, leave before it falls apart.",
      "No buy. Hunt one pick with the pistol, then exit. Don't trade your life for nothing.",
      "Eco. You can't buy aim, so don't bother buying a rifle either. Pistol, pick, leave.",
      "Wallet's dry. Buy a pistol and pray your hands work for once. Free frag if it's there, then run.",
      "Save round. One pistol, one chance at a pick, one clean exit. That's the whole plan.",
      "Broke. Spend nothing, grab a cheeky pick if it's free, and live to buy next round.",
      "Eco. Don't go down swinging on a save. Pistol, take a pick if it's there, exit alive.",
      "No money, no buy. Snag a free kill, then walk. Feeding doesn't help the bonus.",
      "Pistol round by force, not choice. Get a pick if you can, then get out clean.",
      "Bank's tapped. Cheap pistol, play for one frag, save your skin. Rifles come back next round.",
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
      "Lone-wolfing the buy menu helps exactly fucking nobody. Force or save, just do it as five.",
      "In-between money. Match the team or sit it out. A half-buy alone just feeds them.",
      "Not broke, not loaded. Force together or save together, but pick one and all five commit.",
      "No-man's-land money. Whatever the team does, you do too. Solo buys lose rounds.",
      "Awkward stack. Don't be the one guy with a rifle on a save. Match the boys, period.",
    ]);
}

export function bombPlantedLine(ourSide: string | undefined): string {
  if (ourSide === "CT") {
    return pick("plantedCT", [
      "Plant's down. Forty seconds. Quit standing there like it's a moment of silence.",
      "They planted. Shocking. Regroup and hit it together, not one at a time like lemmings.",
      "Bomb's beeping, geniuses. Group up CT side and hit as five, nobody dies being a hero.",
      "Forty on the clock, plenty of time to die alone if you rush it. So don't.",
      "Site's lit. Don't dry peek it solo, wait for the five-man, please.",
      "Stop trickling in one by one to feed them. Wait up, stack, retake the damn site together.",
      "Down a bomb, not down a brain. Group up, util ready, retake as one push.",
      "Quit the hero retake fantasy. Stack up and we take this site together or not at all.",
      "Regroup. Stop wandering off solo. We hit it together or we don't hit it at all.",
      "Forty seconds, five players, one bomb. Do the math and group the hell up.",
      "It's a retake, not a footrace. Wait for the team, throw the util, then go.",
      "Forty on the clock means there's no rush. Group up and trade your damn teammates.",
      "Nobody peeks alone here. Five guns or we just hand them the round.",
      "Pop the util, breathe, push as one. The solo entry just feeds them a free kill.",
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
      "Sit right on the bomb and don't budge. Let them come dig you out.",
      "Stop re-peeking. Hold the angle, let them walk into it. That's the whole job.",
      "Watch the choke, don't touch it. Make them come pry you off the bomb.",
      "Post-plant means patience, not some dumbass solo re-peek that throws the round.",
      "Time's on our side now. Every second you don't move is a second they panic.",
      "You planted it, so stop playing like you're the one who needs a kill.",
      "No hunting, no re-peeking. Just hold and trade. Let the timer do the work.",
      "Crossfire's set, now don't blow it by wandering off looking for a frag.",
    ]);
  }
  // Side unknown (e.g. just reconnected) — stay neutral.
  return pick("plantedNeutral", [
      "Bomb's down. Forty seconds. Someone's about to have a shit day.",
      "That's a plant. Clock's live. Look alive.",
      "Plant's in. Clock's the boss from here.",
      "Bomb's planted. Forty on the clock, and it's counting for somebody.",
      "Plant went in. Just gotta survive the beeping now.",
      "That's the plant. Whoever blinks first loses this one.",
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
      "Defuse went clean. They did all the work, we kept the round. Rude of us.",
      "Cut the wire, took the round. They planted that thing for our benefit.",
      "Defused. Their plant, our W. I love a good robbery.",
      "That's a clean defuse. Whoever planted it just donated it to us.",
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
      "Defused. We planted it and then forgot it existed. Round gone.",
      "Free defuse for them. Not one of you kept eyes on it.",
      "They cut the wire uncontested. The bomb was begging for one babysitter.",
      "Plant down, eyes off, round lost. Watching the bomb is not optional.",
    ]);
  }
  return pick("defusedNeutral", [
      "Bomb's defused. Somewhere, a T player is screaming into a pillow.",
      "Defuse went through. Round's settled either way.",
      "Wire's cut. Somebody won, somebody whiffed.",
      "That's a defuse. The plant didn't pay out for one side.",
      "Defused. Round's decided on the wire.",
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
      "Boom. We held the angles and let it tick. That's how it's done.",
      "Detonation. Turns out patience pays better than a hero peek.",
      "There's the payday. Held the post-plant and never blinked.",
      "Bomb went off. Nobody re-peeked it away for once. Miracle.",
    ]);
  }
  if (ourSide === "CT") {
    return pick("explodedCT", [
      "Boom. That was ours. Retake was fucking late.",
      "It exploded. That retake never actually started. Round over.",
      "There goes the site. That retake was way too damn slow.",
      "That sound means the retake never happened. Round over.",
      "Explosion, our side. You can't out-wait a bomb, it always wins.",
      "Round's gone. Next time the retake starts before the beeping does.",
      "Boom, and it's on us. We just stood there watching the clock and lost.",
      "Boom. That's what dragging your feet on a retake gets you.",
      "It went off. The retake was a rumor, not a plan.",
      "There it goes. We had forty seconds and used zero of them. Round's done.",
    ]);
  }
  return pick("explodedNeutral", [
      "That was the bomb. Somebody's payday, somebody's problem.",
      "Big boom. Round's decided one way or another.",
      "Detonation. The clock ran out on somebody.",
      "That's the bomb going off. Round's locked.",
      "Big one. Somebody won that exchange, somebody ate it.",
    ]);
}

export function roundWonLine(ourScore: number, theirScore: number): string {
  return pick("roundWon", [
      `That's a round. Cool. ${ourScore}-${theirScore}, try not to throw a parade.`,
      `Round's ours, ${ourScore}-${theirScore}. Don't expect applause.`,
      `Congrats, ${ourScore}-${theirScore}, you cleared the bar I set on the floor.`,
      `Nice, ${ourScore}-${theirScore}. Wake me when you string two together.`,
      `One round won, ${ourScore}-${theirScore}. Whoop-de-shit, run it back.`,
      `Calm down, it's ${ourScore}-${theirScore}, not match point.`,
      `That's one, ${ourScore}-${theirScore}. Stack util, hit it again, no ego peeks.`,
      `Don't get cocky, it's ${ourScore}-${theirScore}, not a damn trophy.`,
      `Do it again, but on purpose this time. ${ourScore}-${theirScore}. That's progress, barely.`,
      `We're up ${ourScore}-${theirScore}. Lock in, your aim's still all over the place.`,
      `Won it ${ourScore}-${theirScore}. Now bank the cash and quit grinning.`,
      `Round's in the bag, ${ourScore}-${theirScore}. One round means nothing, keep your head down.`,
      `Cute, ${ourScore}-${theirScore}. They handed you that one, so don't act like you earned it.`,
      `There it is, ${ourScore}-${theirScore}. Save the celebration, the match isn't won.`,
      `Took the round, ${ourScore}-${theirScore}. Reset the angles and do it clean again.`,
      `Up ${ourScore}-${theirScore}. Good. Now play like you actually want the next one.`,
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
      `Whiffed it, lost it, ${ourScore}-${theirScore}. Reset and actually hold an angle.`,
      `We're ${ourScore}-${theirScore}. Stop lurking solo and dying, play with the team.`,
      `That was a clown round, ${ourScore}-${theirScore}. Quit ego peeking and refrag for once, damn it.`,
      `${ourScore}-${theirScore}. You whiffed a full mag at one guy. Reset, trade.`,
      `${ourScore}-${theirScore}. You just stood there holding that angle. Swing or save.`,
      `No trade, no util, just a body. ${ourScore}-${theirScore}. Wake the hell up.`,
      `That clutch was yours and you choked it. ${ourScore}-${theirScore}. Slow down, use your util.`,
      `You ego peeked, got dinked, gave them the round. ${ourScore}-${theirScore}. Hold your angle.`,
      `Down ${ourScore}-${theirScore} and your nades are still in your pocket. Throw them next round.`,
      `${ourScore}-${theirScore}. You W-keyed straight into the open. Slow it down, take it on your terms.`,
      `Five seconds left and you panic-sprayed it away. ${ourScore}-${theirScore}. Breathe, count your shots.`,
      `${ourScore}-${theirScore}. Nobody was near you when you died. Stop overpeeking, play with the squad.`,
      `Bled the round, never got the plant down. ${ourScore}-${theirScore}. Get the bomb planted, then fight.`,
      `${ourScore}-${theirScore}. You dropped a rifle and reset with a pistol. That math never works. Save properly.`,
      `Saved a gun, lost the round, helped nobody. ${ourScore}-${theirScore}. Pick a fight or pick a save, not the worst of both.`,
      `Burned all your time deciding, then forced it. ${ourScore}-${theirScore}. Make the call early next round.`,
      `${ourScore}-${theirScore}. First contact, instant death, no trade behind you. Stagger it, don't all die solo.`,
      `Lost the man advantage doing nothing with it. ${ourScore}-${theirScore}. Trade hard when you're up bodies.`,
    ]);
}

export function killLine(roundKills: number, name?: string): string | null {
  // Third-person fallback so templates like "${who} drops a triple" stay grammatical.
  const who = name ?? "our star";
  if (roundKills >= 5) {
    return pick("killAce", [
      `An ace. Five for five. Don't you dare frame it.`,
      `Five kills, zero deaths, one inflated ego. Sit down, hotshot.`,
      `Gave them a gun, took it back five times. Fine. Ace. Whatever, ${who}.`,
      `Sit down, ${who}. Five kills. My standards are still on the floor.`,
      `Oh look, ${who} found all five. Somebody mark the calendar.`,
      `Well damn, ${who}, an ace. Didn't expect competence today of all days.`,
      `${who} aced it, won the round. I'll allow it. Don't get used to me being nice.`,
      `Where was this last round, ${who}? Oh, now you wanna hit your shots. Five up.`,
      `Fine. That was filthy. Shut up about it. Ace.`,
      `Didn't trade, didn't die, just ran it down their throat. ${who} with all five.`,
      `Hate that I gotta say it. ${who} aced it. Now do that literally ever again.`,
      `Dry peeked four of 'em and lived. The hell. ${who} aced it, round's over.`,
      `An ace from ${who}. Took you all map to remember the gun shoots.`,
      `Five frags, ${who}. Mute the mic before you start narrating it, I'm begging.`,
      `All five to ${who}. Reset your crosshair and pretend this is normal for you.`,
      `Damn it, ${who}, that's an ace and I've got nothing snide. Round's banked, move.`,
    ]);
  }
  if (roundKills === 4) {
    return pick("killQuad", [
      `That's four, ${who}. One more and it's an ace, which I assume we'll find a way to ruin.`,
      `Look at you, ${who}, four kills. Now go whiff the ace like we both know you will.`,
      `That's four, ${who}, one off the ace. No pressure, just everything you'll choke on later.`,
      `Quad, ${who}. One left, hold the angle, don't ego peek it into the bin.`,
      `Four down, one off the ace, ${who}. Refrag him clean. Or don't, I'm braced either way.`,
      `Four kills, ${who}. Don't shit the bed on the fifth.`,
      `Nice quad, ${who}. Blow the ace and I'll never let it go.`,
      `Holy shit, four for ${who}. Trade the last clown and it's an ace.`,
      `Damn, ${who}'s got the quad. Don't dry peek the ace away like an idiot.`,
      `Four bodies, ${who}. Swing wide, find the last one, finish the ace.`,
      `Quad locked, ${who}. Now reload before you go hunting, don't click empty.`,
      `That's four, ${who}. There's one left somewhere. Go close it, don't get cute.`,
      `Four kills, ${who}, and one survivor between you and an ace. Slow it down.`,
      `Quad for ${who}. One man left. Don't W-key it and hand him the freebie.`,
      `Four frags, ${who}. The ace is right there. Don't ego peek and fumble it.`,
      `${who} on four. Last guy's the only thing standing. Patience, not bravado.`,
      `Four down, ${who}. Reset, breathe, take the trade. Don't throw the ace away.`,
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
      `${who} got three, congrats you absolute clown. Now refrag with your team and shut up.`,
      `Look at ${who}, three kills before the inevitable whiff. Hold the angle, don't W-key it.`,
      `Look at ${who} not whiffing for once, that's three. Hold it, don't dry-peek the fourth.`,
      `A triple from ${who}? Hell froze over. Play it slow and don't overstay the round.`,
      `Three down, ${who}. That's the loud part over. Slow down, hold, let them come to you.`,
      `${who}'s on three and grinning. Trade it next time, don't run it solo and feed it back.`,
      `Huh. ${who} got a triple. Now sit on the angle and don't W-key into the rest.`,
      `Three for ${who}. Don't blow the lead chasing a fourth you don't need. Hold.`,
      `Triple, ${who}. You've done your part. Now quit the hero shit and trade with the team.`,
      `${who} with three, color me shocked. Reset, hold your angle, let them walk in.`,
      `Three frags, ${who}. Cash that in, don't gamble it on a greedy peek.`,
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
      `Filthy knife kill, ${who}. Tell that guy to Get Leetify and weep.`,
      `${who} stabbed him. Somebody go tell that guy to Get Leetify.`,
      `He brought a rifle, ${who} brought a knife. Get Leetify, buddy, the gun didn't help.`,
      `Knife kill from ${who}. Hey loser, Get Leetify and see what just happened to you.`,
      `${who} knifed his ass clean. Go Get Leetify and explain that one, pal.`,
      `Poor bastard walked into ${who} and a knife. Get Leetify, it won't make it better.`,
      `${who} carved that dude up. Tell him to Get Leetify and book a therapist.`,
      `${who} ran him down and knifed him. Get Leetify, champ, that's a permanent stain.`,
      `${who} pulled the knife on him. Get Leetify and live with it, dude.`,
      `Knifed at full HP by ${who}. Get Leetify, that stat's gonna haunt you.`,
      `Pure disrespect from ${who}. Get Leetify, my guy, the whole server saw that.`,
      `${who} traded a gun for a knife and still won. Get Leetify and rage quit.`,
      `${who} stuck the knife in. Get Leetify, you got out-aimed by a blade.`,
      `That guy had every advantage and ${who} knifed him anyway. Get Leetify.`,
      `Knife kill, ${who}. Tell that clown to Get Leetify before he uninstalls.`,
      `${who} just embarrassed him with the knife. Get Leetify and stay humble, victim.`,
      `Brutal knife from ${who}. Get Leetify, dude, your aim clearly took the round off.`,
    ]);
}

export function zeusKillLine(): string {
  return pick("zeusKill", [
      "Zeus kill. A hundred dollars of disrespect, paid in full.",
      "He had a rifle. You had a battery. Damn.",
      "Zapped. He's gonna hear that crackle in his sleep.",
      "That's a Zeus kill. He's never telling anyone about this.",
      "The Zeus connects. His ego just fucking flatlined.",
      "Tased. He died embarrassed, exactly as intended.",
      "Hundred dollar taser, one dead guy. Cheapest humiliation on the server.",
      "Zeus to the dome. That's a guy who's gonna alt-F4 out of shame.",
      "You zapped a guy holding a rifle. He is never recovering from that.",
      "Battery kill. Dude got deleted by a glorified flashlight.",
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
      "Two plus down to a puddle of fire. You just stood there and watched, huh.",
      "One molly, the whole group toasted. Shit, they walked right into the oven.",
      "More than one went down to the fire. Beautiful burn, lazy as hell.",
      "The flames did the whole multi-frag. You threw it and took a coffee break.",
      "Stacked up and cooked together. That's a campfire, not a clutch.",
      "Multiple guys burned off one molly. The fire out-fragged your rifle, no contest.",
      "You chucked one molly and two of them melted. Disgusting and effortless.",
      "That fire ate the whole group. Don't you dare call that a skill round.",
    ]);
    }
    return pick("mollyKill", [
      "Fire did all the heavy lifting and you grabbed the kill. Cute.",
      "One molly kill. Standing in a fire pit is not a frag.",
      "The molotov got an assist on its own kill. You just spectated.",
      "Cooked one alive. Real high-skill stuff, sitting there in the flames.",
      "Congrats, the incendiary outfragged you that round.",
      "No fucking way you let the fire trade for you. Pathetic and lazy.",
      "Molly does the damage and you take the bow. Embarrassing.",
      "You threw a puddle and a guy died in it. Hell of an aim diff, champ.",
      "Dude stood in your fire till he died. You barely had to be there.",
      "That kill came from a campfire, man. You just happened to be nearby.",
      "One molly, one crispy guy. Your rifle's collecting dust over there.",
      "A free frag off a thrown puddle. Take it, but don't brag about it.",
      "Guy burned down standing still and you call that a kill. Sure.",
      "The fire did your job. Send it a thank-you note, dipshit.",
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
      "Nice nade. Real impressive, killing guys who couldn't shoot back.",
      "Two plus off one grenade. The blast carried you that round, not your aim.",
      "Whole group ate that nade. Cheapest multi-kill you'll ever steal.",
      "One throw, a pile of bodies. Your rifle's somewhere crying about it.",
      "Grenade does a triple and you act like that's a play. Bold.",
    ]);
  }
  return pick("heKill", [
      "One kill off a nade. That's the whole highlight reel, huh.",
      "Aw, the grenade did your aiming for you. Cute.",
      "The nade outfragged your rifle this round. Noted.",
      "Threw a nade, killed a guy. Cheapest kill on the server, want a medal?",
      "Cooked one with the nade. Dude got deleted by physics, embarrassing for him.",
      "Tossed a frag and it did more work than your rifle does all game.",
      "Hell of a throw, that nade ate his whole health bar.",
      "Beautiful, you killed him with a nade you panic-chucked at a wall.",
      "A grenade frag. Pat yourself on the back for the laziest kill of the round.",
      "One dead guy, zero bullets fired. Real gunfighter you are.",
      "The nade clipped him for the kill and you didn't even see him. Lucky shit.",
      "Frag kill. You blew a guy up and called it skill. Adorable.",
    ]);
}

export function lowHpKillLine(hp: number): string {
  return pick("lowHpKill", [
      `${hp} HP and you swung anyway. Shit worked. Somehow.`,
      `Clutched a duel at ${hp} HP. One dink and you were dust.`,
      `You had ${hp} HP and an ego. The ego won, you didn't earn it.`,
      `That was a coin flip at ${hp} HP. It landed your way. Don't make a habit of it.`,
      `He lost to a guy on ${hp} HP. He's never recovering. Lucky for you.`,
      `Won that on ${hp} HP, peeking like you forgot bullets exist. One whiff and it's over.`,
      `${hp} HP and you took the duel cold. Brave or brainless, hard to tell.`,
      `Survived on ${hp} HP. That's not skill, that's the other guy whiffing harder.`,
      `Down to ${hp} HP and you still clicked first. Now go kit up before you push your luck.`,
      `${hp} HP and a prayer. The prayer hit. Stop relying on it.`,
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
      "You just fragged your own teammate. Type sorry before he opens his mic.",
      "Same team, dipshit. Drop a sorry in chat and pretend it was lag.",
      "That's a teammate down by your hand. Chat. Sorry. Make it quick.",
      "Lit up your own guy. Least you can do is type sorry in chat.",
    ]);
}

/** Narrate the teammate the dead player is spectating; quiet for routine kills. */
export function teammateKillLine(name: string | undefined, kills: number, health?: number): string | null {
  const who = name ?? "your teammate";
  if (kills >= 5) {
    return pick("specAce", [
      `Ace. ${who} killed everybody. You contributed a death.`,
      `That's an ace for ${who}. I'm annoyed at how impressed I am.`,
      `Five for five. ${who} aced it while you watched from the floor. Teamwork, technically.`,
      `${who} aced it. You fed the opener and called it a sacrifice. Sure.`,
      `Whole enemy team gone and ${who} did it. You set the table by dying first.`,
      `${who} bailed your dead ass out with an ace. You'll never hear the end of it.`,
      `Five kills, ${who}, zero help from the corpse spectating. Filthy round.`,
      `${who} cleaned all five solo. You'll take the round win and pretend you earned it.`,
      `Damn. ${who} aced it. You whiffed your duel and got carried. Numbers checked out.`,
    ]);
  }
  if (kills === 4) {
    return pick("specQuad", [
      `Four for ${who}. One more and you owe them dinner for carrying your corpse.`,
      `${who}'s on four. You're watching a carry from the floor, exactly where you parked yourself.`,
      `That's a quad from ${who}. The ace watch is on, and you're useless to it.`,
      `${who} hit four while you respawn-watch. One of you's playing this round.`,
      `Four bodies for ${who}. Shame you whiffed your duel and can't help close it.`,
      `${who}'s hunting the fifth alone because you're dead. Cheer quietly, ghost.`,
      `Quad for ${who}. They're doing the work you died trying to fake.`,
      `Four down, ${who}. You died early so you could get a good seat, right? Right.`,
    ]);
  }
  if (kills === 3) {
    return pick("specTriple", [
      `Triple for ${who}. Your death really set that up nicely.`,
      `${who}'s got three. Turns out staying alive helps. You should try it.`,
      `There's the triple. ${who}'s cleaning up your mess. Stay dead, you've earned the rest.`,
      `Three kills for ${who} while you watch. So that's what trading looks like.`,
      `${who} woke up for a triple. You woke up for the spectator cam. Different games.`,
      `Three for ${who}. They're refragging the fights you fed. Cute.`,
      `${who}'s on three carrying the round you exited early. Enjoy the view, corpse.`,
      `Triple, ${who}. One of you committed to the round. It wasn't the dead one.`,
    ]);
  }
  if (health !== undefined && health > 0 && health <= 20 && kills >= 1) {
    return pick("specClutch", [
      `${who} is clutching this on ${health} HP. Filthy, and I hate that I'm impressed. You're on zero, so shut up and watch.`,
      `${health} HP and ${who}'s still winning fights you couldn't win on full. Embarrassing for the corpse.`,
      `${who}'s alive on ${health} HP and going for it while you spectate. One of you has a pulse.`,
      `${health} HP on ${who} and still swinging. You died on a hundred. Sit with that, ghost.`,
      `Look at ${who}, ${health} HP, somehow not dead. You managed to die with health to spare.`,
      `${who}'s clutching on ${health} HP. Hold your breath for them, it's the most help you've offered all round.`,
      `${health} HP and ${who} won't fold. You folded at the first peek. Watch and learn.`,
      `${who} on ${health} HP, one mistake from joining you on the floor. Don't jinx it, dead weight.`,
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
      `An ace from ${who}. I'm impressed and I hate it. Where's yours?`,
      `${who} cleared the whole enemy team while you were busy doing whatever that was.`,
      `Five for ${who}. One-man army shit. So what exactly were you adding?`,
      `${who} aced it. Frame that one, then explain why they're doing your job.`,
      `Whole enemy side gone, courtesy of ${who}. You held a wall.`,
      `${who} aced the round you were supposed to be helping win. Awkward.`,
      `Five kills, ${who}, no thanks to you. Trade next time so it doesn't fall on one guy.`,
      `${who} ran the table solo. Maybe peek something next round so they don't have to.`,
      `Ace for ${who}. They carried the dead weight, and the dead weight's still alive. That's you.`,
    ]);
  }
  if (kills === 4) {
    return pick("teamQuad", [
      `${who}'s on four. Somebody's cooking, and it sure isn't you.`,
      `Four kills for ${who}. Back them up and close it out, don't leave them solo.`,
      `${who} with a quad. The ace is right there. Trade for them instead of watching.`,
      `That's four for ${who}. Don't let it go to waste, get in there and refrag.`,
      `${who}'s hunting the fifth. Stop spectating your teammate and back the swing.`,
      `Damn, ${who}'s got four. Feed them info and stop being scenery.`,
      `Four for ${who}. They're carrying. Least you can do is trade the next duel.`,
      `Quad locked for ${who}. Help close it before you find a way to lose it for them.`,
      `${who}'s on four, one off the ace. Get in there and make yourself useful for once.`,
      `Four down, ${who}. Back them up. Don't let your guy bag the round alone while you idle.`,
    ]);
  }
  // 3 is the floor — the aggregate-not-multiply rule mutes anything smaller.
  return pick("teamTriple", [
      `${who} with a triple. Nice. Now back them up before you waste it.`,
      `Triple for ${who}. They're awake. Are you? Trade for the next one.`,
      `${who}'s got three and doing your job. Get over there and help close it.`,
      `That's a triple from ${who}. Don't let them swing the rest solo.`,
      `${who} popped three. Don't let it go quiet now, refrag with them.`,
      `Three for ${who} while you do the bare minimum. Back the play.`,
      `${who}'s on three. Least you can do is trade so it isn't a one-man show.`,
      `Triple, ${who}. They're carrying the round. Pitch in before it's gift-wrapped back.`,
      `${who} got three. Stop watching your own teammate and back them up.`,
      `Three down for ${who}. Don't make them clean the whole round while you spectate.`,
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
      "Whole crew's cooking and you're the burnt one. Feed the info, back the plays.",
      "Everybody's hitting their shots for once. Don't be the one who lets it go quiet.",
      "The squad's on a heater. Keep the trades coming and shut the round down.",
      "Half the team's lighting them up. Get in there and refrag instead of admiring it.",
      "Crew's carrying hard right now. Pull your weight, trade, and close the damn round.",
    ]);
  }
  if (real.length === 1) return teammateMultiKillLine(real[0], 3);
  const [a, b] = real;
  return pick("teamDuo", [
      `${a} and ${b} are both going off while you stand there. Trade for them, help close it.`,
      `${a} and ${b} are both cooking. Get in and refrag before you waste it.`,
      `${a} and ${b} are popping off together. Don't let either of them swing alone.`,
      `Both ${a} and ${b} on a tear. Feed the info and stop watching the show.`,
      `${a} and ${b} carrying at the same damn time. Back them up, dead weight.`,
      `${a} and ${b} are doing your job in stereo. Trade for one of them, close it out.`,
      `Two of them cooking, ${a} and ${b}, and one of you idling. Pitch in.`,
      `${a} and ${b} both off. Hell of a round. Don't be the reason it slips.`,
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
      "You're the last one breathing and that's the bad news. Use the clock, no hero rush.",
      "Everybody's dead but you. Clutch it or don't, just make it ugly for them.",
      "Last man. Take your time, trade your shots, no hero rush. It's yours to lose, so don't.",
      "You're alone up there. Don't W-key it. Use the clock, pick one fight, win it.",
      "Squad's wiped, you're it. Quiet, slow, deadly. Don't ego peek it away.",
      "Down to you. Try not to panic-rush into all of them like you usually do.",
      "Last alive. Burn the clock, take them one at a time, no dumb hero swing.",
      "It's on you, the worst possible option. Play it slow, don't gift it away.",
      "You're the last one standing. Shocking. Hold an angle, use the time, don't throw it.",
    ]);
  }
  return pick("lastManMate", [
      `${name}'s the last one alive. Everybody else dead, so give one callout then zip it.`,
      `It's on ${name} now. Last man up. Feed them what you saw, then shut up and let them cook.`,
      `${name}'s last alive, and for once it's not you watching from the grave. One callout, then shut up.`,
      `Down to ${name}. Last breath on the team. Quick info, then keep your dead mouth shut.`,
      `${name} alone now. One clean callout each, then let them work. No backseating from the grave.`,
      `All on ${name}, last one standing. Better them than you. One callout, then quiet.`,
      `${name}'s it. You're dead, so be useful for once. One thing you saw, then shut up.`,
      `Last man's ${name}. Give them the info and stop chattering, you're not helping by talking.`,
      `${name} clutching alone. The dead don't get a vote. One callout, then let them cook.`,
      `It's ${name} or nothing. Toss one callout, then sit there quietly like the corpse you are.`,
    ]);
}

/** Locally-derived clock callout: ~35 seconds left, no plant yet. */
export function lateRoundLine(side: string | undefined, hasBomb = false): string {
  // The player is personally carrying the C4 — the generic "someone plant"
  // nudge lands very differently when the someone is them.
  if (side === "T" && hasBomb) {
    return pick("lateRoundCarrier", [
      "That's a bomb on your back, not a camera. Thirty-five seconds. Go plant.",
      "Walking the bomb around like a dog on a leash. Thirty seconds. It needs a site, now.",
      "A or B, your pick, but pick one. You're carrying. Thirty-ish seconds.",
      "You've got the bomb and thirty seconds. Quit stalling and get it down on a site.",
      "Holy shit, you still have the bomb. Half a minute. Get it down somewhere.",
      "The bomb doesn't plant from your pocket. Find a site, walk it in.",
      "You've got the C four. That makes you the plan. Clock's at thirty-five. Plant.",
      "Quit sightseeing. You're holding the bomb and the round's bleeding out. Any site. Go.",
      "Thirty-five and you're still ferrying the bomb around. Plant it on a site, now.",
      "You're the carrier, not a tourist. Half a minute. Plant the C four in the ground.",
      "Bomb's on you, clock's at thirty-five. Stop dancing, commit to a site and plant.",
      "Nobody plants it for you, hero. You've got the C four. Hit a site before the clock does.",
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
      "Quit lurking for frags. Get to a site and put the bomb down.",
      "Thirty-five left and nothing's planted. You don't win this round until that bomb's down.",
      "Bomb in the ground beats one more pick. Hit a site and stick it.",
      "Default's done, clock's loud. Pick a site as five and plant the thing.",
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
      "Thirty-five and no plant. Every tick is ours. Don't give it back with a dumb peek.",
      "Clock's doing the work for us. Hold tight and make them force it.",
      "No bomb, no rush. Sit on your angle and let the timer squeeze them.",
      "We win if nothing happens. So make nothing happen. Hold.",
    ]);
  }
  return pick("lateRoundNeutral", [
      "Thirty seconds, no plant. Somebody's about to panic. Don't be them.",
      "Clock's getting loud, no bomb down. Someone make a damn decision.",
      "Thirty left and the bomb's still in a pocket somewhere. Sort it out.",
      "No plant, clock's draining. Whatever the call is, make it now.",
      "Half a minute, nothing down. Stop drifting and lock in a play.",
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
      `Clock's bleeding and ${name}'s still holding the C four. Plant it, find them a way in.`,
      `${name} is the plan, they've got the bomb. Half a minute. Get it down.`,
      `Thirty-five left, ${name}'s carrying. Quit defaulting, walk the bomb in.`,
      `Bomb's on ${name} and the clock doesn't care. Pick a site, escort them.`,
      `${name}'s holding the C four and the round's running out. Any site. Get them there.`,
      `Thirty-five and ${name}'s still ferrying the bomb. Open a site, send them in.`,
      `It's on ${name} to plant. Half a minute. Clear them a path and stick it.`,
      `${name} has the bomb, nobody's planting it for them. Pick a site and walk them on.`,
      `Clock's at thirty-five with ${name} on the C four. Stop waiting, get them to a site.`,
    ]);
}

/** Locally-derived bomb-timer callout: roughly ten seconds left on the C4. */
export function bombTenLine(side: string | undefined, fighting = false): string {
  if (side === "CT") {
    // Mid-fight: the player just got a kill — give them the clock, not a
    // "back off" order aimed at someone who's clearly winning the exchange.
    if (fighting) {
      return pick("bombTenCTFighting", [
      "Ten seconds, finish him fast. The bomb's not waiting for style points.",
      "Ten on the clock, drop him quick then kit or quit.",
      "Ten left, you're winning the duel, so win it now and bail.",
      "Ten seconds, close it out fast. Pretty doesn't beat the timer.",
      "Ten on the clock, clap him and get the hell out, no time to admire it.",
      "Ten left, you're swinging, so swing fast and don't eat the tick.",
      "Ten seconds, one more frag and reset. Make it quick.",
      "Ten on the bomb, win the fight now or the round wins for them.",
    ]);
    }
    return pick("bombTenCT", [
      "Ten seconds and you're nowhere near the bomb. Run, save the rifle.",
      "Ten on the clock, nobody's shooting you, so quit babysitting it and bail with the gun.",
      "Ten left, you can't defuse from there. Back out, keep the rifle.",
      "Ten seconds, no defuse, no fight. Bail, don't be a stat.",
      "Ten and that bomb's about to blow. Don't eat it, peel out with your rifle.",
      "Ten seconds, get the hell off site. Dying to the clock is pathetic. Save the gun.",
      "Ten left, get away from that thing now. Keep the rifle.",
      "Ten on the clock and you're too far. Eating a tick with a full rifle is dumb as hell. Leave.",
      "Ten seconds, no chance at the defuse. Take the gun and live to buy next round.",
      "Ten left, that's not your bomb to save. Disappear and keep the rifle alive.",
      "Ten and you're stranded off it. Quit staring, run, the gun's worth more than the round.",
      "Ten seconds, you ain't defusing in time. Bail clean, don't gift them a free kill.",
      "Ten left, nothing you can do on that bomb. Get out, save the kit, reset.",
      "Ten on the clock, no defuse coming. Leave the site, keep your gun, don't eat the blast.",
    ]);
  }
  if (side === "T") {
    // Just got a kill near the planted bomb — almost certainly fighting a CT
    // going for the defuse. Back the play; a "freeze" order would be wrong here.
    if (fighting) {
      return pick("bombTenTFighting", [
      "Ten seconds, drop him then plant your ass back on the bomb.",
      "Ten left, that's probably the defuser. Kill him and sit on it.",
      "Ten on the clock, win that duel fast then freeze. The bomb does the rest.",
      "Ten seconds, one more and it's over. Trade him, then hold the bomb.",
      "Ten left, finish him, don't chase. Park back on the C four.",
      "Ten on the clock, drop him quick and let the timer close it.",
      "Ten seconds, clap him then hold tight. Don't wander, the bomb wins it.",
      "Ten left, you're already swinging. Drop him and get back on the C four.",
    ]);
    }
    // GSI never tells a T player whether a CT is defusing, so the only honest
    // call is BOTH branches: peek to stop a defuse, hold if it's clear. (A live
    // session flatly said "freeze, don't peek" while CTs were mid-defuse.)
    return pick("bombTenT", [
      "Ten on the clock. Hear a tap, peek and kill it. Hear nothing, just hold.",
      "Ten left. Someone tapping the bomb? Swing and stop it. Quiet? Sit tight.",
      "Ten seconds. If you hear a defuse, go clap him. If it's silent, hold your angle.",
      "Ten on the bomb. Beep going? Peek and trade it. No beep? Don't give a free pick, just hold.",
      "Ten left. Defuse sound, stop it now or we lose. Dead quiet, the bomb does the work, hold.",
      "Ten seconds. You hear tapping, swing right now. Otherwise hold and let it cook.",
      "Ten on the clock. A defuse means peek and frag him. Silence means stay put.",
      "Ten left. If something's on that bomb, go shut it up. If not, just watch your angle.",
      "Ten seconds. Hear a tap, you peek. Hear nothing, you hold. Don't overthink it.",
      "Ten on the bomb. Defuse running, stop it. No sound, no peek, let it tick down.",
      "Ten left. Catch a beep, swing and kill the defuse. Catch nothing, sit on your spot.",
      "Ten seconds. If a CT's tapping it, peek and trade. If it's dry, hold and wait for the boom.",
      "Ten on the clock. Hear a defuse, end it. Hear quiet, hold tight, the timer's our friend.",
      "Ten left. Tap on the bomb means swing it. No tap means stay home and let it pop.",
    ]);
  }
  return pick("bombTenNeutral", [
      "Ten on the bomb. This ends loud or it ends quiet.",
      "Ten seconds, no more waffling. Finish the damn round.",
      "Ten left. Whatever the play is, commit and close it out.",
      "Ten on the clock, quit dithering and make the call.",
      "Ten seconds left, do whatever you're doing, just do it faster.",
      "Ten on the bomb, it's decided in the next breath. Commit.",
      "Ten left, no time to think twice. Pick a play and end it.",
      "Ten seconds, the round's basically over. Make it count.",
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
      "Still losing, huh? Timeout. Stop and figure out where this went sideways.",
      "Timeout won't fix your aim, but breathing might. Hit it. Right now.",
      "We've burned through plans A, B, and C. Timeout. Go find us a damn D.",
      "Good news: timeouts are free. Bad news: everything else. Call it, regroup, run it back.",
      "Call the tac. We're not losing rounds, we're gift-wrapping them. Stop the bleeding.",
      "Hit the timeout. Whatever you're doing isn't working, so quit doing it faster.",
      "Burn the timeout now. Thirty seconds to think beats another round of running it solo into nothing.",
      "Timeout. Let's actually talk before we feed them one more free round, yeah?",
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
      "Lead's nice. Don't get cute and toss it back. Lock the next buy as five, hold your angles, trade your teammates. We win boring, not flashy.",
      "Thirty seconds, don't waste it congratulating yourselves. We're ahead because we played together — so keep doing that. One buy call, everyone in, no solo heroics.",
      "We're up, so the only way to screw this is to start freelancing. Match the buy, hold your spots, trade the duels. Stay disciplined and this stays easy.",
      "Decent spot, don't get comfortable. Pick the next call, all five buy the same, and nobody goes hunting for a highlight. Keep it tight and run it back.",
    ]);
  }
  return pick("ourTimeoutSpeech", [
      "Look at me. Whatever that was, it's over. Quit dry-peeking AWPs and expecting to live — wait for a flash or don't peek. Everyone buys next round, same time, same plan. The bleeding stops this round.",
      "Huddle up. They're not better than us, we're just dying one at a time in five different spots. Stick together: one pack, one site, every swing. Buy as a team next round, same call, all five. Now go act like you've played together before.",
      "Timeout's ours, use it. We keep getting picked off solo because we're playing solo. Buddy up and trade — nobody dies for free anymore. Match the buy next round, all five, same plan. Still a winnable damn game.",
      "Eyes up. We keep throwing every grenade in the first twenty seconds, then trying to retake with nothing left. Hold your util for when it matters. Next buy is a team decision, five voices, one answer. Water break's over, back to work.",
      "Nobody panic, it's a rough patch, not a funeral. We die in ones and twos because we play in ones and twos. Five bodies, one fight. Match buys next round, everyone or no one. Go be a team for once.",
      "Same clip on loop: dry peek, instant trip to spectator cam. Cut it out — somebody flashes before anybody swings. Next round we make one money call and everybody honors it. Unclench, we're still in this.",
      "Stop. We're hemorrhaging rounds because everybody's got their own plan. There's one plan, and I'm about to say it: buy together, push together, trade together. No lone-wolf nonsense. We claw this back as five or not at all.",
      "Listen up. We force-bought into a full setup and got mowed down, again. Next round we buy right, all five matched, no half-eco hero swings. Flash for each other, trade the entry, and quit handing them free kills. Reset starts now.",
      "Breathe. The problem's not your aim, it's that you're all swinging the same angle thirty seconds apart. Pace it. One nade, one flash, one swing, together. Lock the buy as a team and we stop losing rounds we should win.",
      "Quit ego-peeking and feeding them the round on a plate. We're alive at the end when we play off each other, dead when we don't. So next round: matched buy, traded duels, util saved for the fight that counts. Let's go.",
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
      "They're in there scrambling for a plan. Stay loose.",
      "They need a breather, we don't. Keep that trigger finger twitchy.",
      "Timeout's theirs. We just stand here looking dangerous. Stay ready.",
      "They hit the brakes. That means it's working. Don't let off now.",
      "Their pause, not ours. Don't cool down out of politeness. Stay sharp.",
      "They're regrouping because you're winning. Weird flex, keep doing it.",
      "Thirty seconds for them to find a plan. Make sure it doesn't matter. Stay ready.",
    ]);
}

/**
 * Wrapper for the spoken Leetify recap — the canned fallback when the LLM is
 * off. The {stats} slot takes a comma-separated numbers sentence verbatim; an
 * optional squad sentence (the crew comparison) is appended verbatim too.
 */
export function leetifyRecapLine(
  map: string | undefined,
  statsSentence: string,
  squadSentence?: string,
): string {
  const where = map ? mapDisplayName(map) : "that last one";
  // Result-agnostic on purpose: the wrapper doesn't know if the numbers are
  // good or bad, so no loss-coded verdicts and no claims about what the
  // player's been doing while Leetify chewed on the demo.
  const base = pick("leetifyRecap", [
      "Match report time — Leetify scored {map} for us. {stats}. Now everybody give me a damn lap.",
      "Leetify finished chewing through the {map} demo. {stats}. Don't shoot the messenger.",
      "Verdict's in from Leetify on {map}. {stats}. Numbers don't give a shit about feelings.",
      "Leetify says the {map} tape doesn't lie. {stats}. Take it up with the spreadsheet.",
      "Here's Leetify's {map} numbers. {stats}. I'm choosing not to comment.",
      "Took a minute, but Leetify coughed up the {map} numbers. {stats}. Frame it or burn it, your call.",
      "Leetify did the math on {map} so I don't have to. {stats}. Make of that what you will.",
      "Here's what Leetify pulled off the {map} demo. {stats}. The robot's not lying, so don't ask.",
      "Leetify ran the {map} tape back. {stats}. That's the receipt, no editorializing from me.",
      "Fresh out of Leetify, your {map} breakdown. {stats}. Read it and weep, or don't, whatever.",
    ])
    .replace("{map}", where)
    .replace("{stats}", statsSentence);
  return squadSentence ? `${base} And the crew: ${squadSentence}.` : base;
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
      "That's one. Next, please.",
      "Filthy. Stay on it, don't choke it now.",
      "One down. Stop admiring it and finish.",
      "Nice. Now finish what you started.",
      "Okay, you can shoot. Keep going.",
      "Good frag. Don't get cute, just finish it.",
      "Live one for once. Stay on it.",
      "One kill in and I'm still nervous. Finish the job.",
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
      "Lose this and it's over, nothing left to save. Whole team retakes, go.",
      "Bank a gun for what? Match's done if we drop it. Retake, all of us.",
      "No hiding, no saving. Send the whole team at the site or we pack it up.",
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
      "Freeroll, basically. A loss costs nothing. Take it back only if it's clean, otherwise bank the gun.",
      "Match point, so relax. Can't see your numbers from here. Clean retake, take it. Not clean, save it and we win the next.",
      "We're ahead and it's match point. Save is totally fine here. Only swing if the retake's actually there.",
      "No need to be a hero. Clean read, retake it. Anything sketchy, keep the gun and we close it next round.",
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
      "Last one up. No dry swing. Play the clock and the kit, one fight at a time.",
      "You're the only one alive. No hero retake. Bait a peek, trade if you can, otherwise save the gun.",
      "One left, and it's you. Numbers are trash. Play the kit, take it one fight at a time.",
      "Solo now. Don't go running in. Make them come to you, win one duel, then think.",
      "Just you breathing. Use the clock, pick your fight, and quit gambling on a dry peek.",
      "You're it. No swinging blind. One angle, one fight, and let the timer do the work.",
    ]);
    }
    if (alive === 2) {
      return pick("retakeNumbers2", [
      "Two of you up. Hit it together, same choke, trade everything. If they swing first, back off and save.",
      "Just the 2 of you. No solo entries, one flashes, one swings, refrag clean. Bail if it's not there.",
      "Two-man retake. Pair up tight, take the same fight. Dunno their numbers, so don't overcommit.",
      "It's a 2-man job. Same angle, same time. One peeks, one trades. No splitting up.",
      "Two of you, so stick together. Can't see how many they've got, so don't go diving in solo.",
      "Two alive. Buddy up, swing as a pair, trade the second one falls. Not clean? Save it.",
    ]);
    }
    return pick("retakeNumbers3", [
      "Numbers are good. Hit it as a group, every entry gets a trade. Drown the site.",
      "Three plus alive. Stack a choke, swing together, refrag everything. Take it back as a unit.",
      "Healthy numbers. Coordinate the hit, trade hard. Can't see them, but the count's ours.",
      "You've got plenty up. Don't waste them, swing together, drown the site in trades.",
      "Numbers advantage. Pile into one choke, refrag every entry. Group hit or nothing.",
      "Loads of you alive. Hit as a group, trade everything, walk all over the site.",
    ]);
  }
  // Events ITEM 8 (partial): NOT roster-complete, but some wired teammates' OWN
  // alive state is visible — name the fresh-alive ones for a hedged minimum-bodies
  // call. Read from members[] directly (aliveWired is undefined without
  // rosterComplete), so this never asserts a whole-team count.
  if (team && !team.rosterComplete) {
    const up = team.members.filter((m) => m.alive === true && m.tier === "fresh" && !m.isPrimary && m.name);
    if (up.length > 0) {
      const names =
        up.length === 1
          ? (up[0].name as string)
          : `${up.slice(0, -1).map((m) => m.name).join(", ")} and ${up[up.length - 1].name}`;
      return pick("retakePartial", [
      `At least you and ${names} are up. Pair the swing, trade hard, can't see the rest so don't overcommit.`,
      `You've got ${names} with you for sure. Same fight, refrag clean. Dunno about the others, so bail if it's not there.`,
      `You and ${names} for certain. Take the site together, no solo entries. No read on the rest, play safe if it stalls.`,
      `Confirmed it's you and ${names}. Swing as a pair, trade the entry. The rest I can't see, so don't overcommit.`,
      `Know you and ${names} are alive, that's it. Hit the same choke, trade everything, no solo dives past what you can back up.`,
    ]);
    }
  }
  const thinGear = (ctx.armor ?? 0) === 0 || (ctx.equipValue ?? 0) < 1500 || (ctx.health ?? 100) < 40;
  if (ctx.defuseKit) {
    return pick("retakeKit", [
      "You've got the kit. They clear, you stick. That's the job.",
      "Kit carrier. Congrats, you're important now. Get on the damn bomb.",
      "One job: the bomb. They shoot, you defuse.",
      "You're the defuser today. Everyone else is furniture. Get to work.",
      "Forget kills. Stick that shit and win.",
      "Kit's on you. Don't go hunting frags, get to the bomb and stick it.",
      "You've got the cutters. Let the team trade, you do the only thing that matters.",
      "Defuser's you. Park the ego, plant yourself on the bomb, win the round.",
    ]);
  }
  if (thinGear) {
    return pick("retakeThin", [
      "You're paper right now. All five go or you save.",
      "No armor, no hero shit. Group retake or keep the gun.",
      "That loadout's held together with tape. Everyone goes, or you don't.",
      "One bad peek ends you. Retake with the whole team or just hide.",
      "Broke and brave is just broke. Five-man retake or walk away.",
      "You'd lose a fistfight with that kit. Pile in together or bank it.",
      "Low health, light gear. Don't peek alone. Whole team or save it.",
      "You're a wet paper bag this round. Retake as a group or keep the gun for next.",
    ]);
  }
  return pick("retakeGo", [
      "Gear's good. Retake as five. Trade everything.",
      "Nobody solos this shit. Pair up, swing together, punish every peek.",
      "Stack up and go. Whoever entries, refrag him. That's the plan.",
      "You're geared. Walk in with friends. Nobody dies for free.",
      "Retake time. Buddy system. Anyone entering alone gets benched.",
      "Full kit, no excuses. Hit the site as a unit.",
      "Money's there, gear's there. Five-man hit, trade the opener, take it back.",
      "Loaded up. Swing the same choke together and refrag every single peek.",
    ]);
}

/**
 * C3 — the squad's entry-trade weak link: a wired teammate who keeps dying on the
 * opening. The roster code-gates this (once per offender per match, at freezetime),
 * so the line names them directly and roasts the habit (friends are fair game) while
 * staying number-free (no teammate count, per the K/D guardrail).
 */
export function squadOpeningDeathsLine(name: string): string {
  return pick("squadOpeningDeaths", [
      `${name}'s been first to die a few rounds running. Trade them, or ${name}, quit swinging first.`,
      `We keep losing ${name} on the opening. Refrag them this round, or rethink who's entrying.`,
      `${name}, you're getting picked the second the round starts. Wait for a trade or let someone else open.`,
      `Somebody babysit ${name} on entry — they keep going in alone and dying. That's free rounds we're gifting.`,
      `${name} keeps running in and dying first like it's the assigned role. Trade the poor bastard or stop ego-peeking.`,
      `${name}'s feeding the opening like it's a chore. Trade off them or sit ${name} back this round.`,
      `${name}'s the warm-up kill every round. Stop peeking first, ${name}, or stack a trade behind them.`,
      `${name} runs in first and dies first every damn time, no flash, no trade, no brain. Babysit him or ${name}, hold your swing.`,
      `${name}'s entry is just a donation drive for the enemy. Trade him this round or ${name}, let someone with a pulse open.`,
      `${name} keeps swinging first like the round's gonna wait for them. It's not. Trade ${name}, or quit ego-peeking the entry.`,
      `${name} opens every round face-first into a gun and gives it right back. Babysit the trade, or take entry off ${name} completely.`,
      `${name} sprints in and feeds first every round like it's a side quest. Refrag them, or sit ${name} on the bench till they learn to wait.`,
      `${name} dies on entry with no util every round. Flash for them or ${name}, stop dry-peeking the open.`,
      `Stack up behind ${name} so the trade's free, 'cause god knows they're dying first again.`,
      `${name} keeps trading themself for nothing. Someone refrag off them, or ${name}, hang back and let the team go first.`,
      `Whoever's entrying with ${name}, glue yourself to them — they keep dying alone and we get nothing back.`,
      `${name}'s the opening pick on repeat. Either trade them instantly or ${name}, quit being the first body out.`,
      `${name} eats the entry every round like clockwork. Babysit the swing or sit ${name} second man this round.`,
    ]);
}

/**
 * One-shot freezetime jab when the player is on an opening-deaths spiral (three-
 * plus rounds dying in the first ten seconds). Roasts the over-peeking and tells
 * them to slow down THIS round — hold an angle, let the fight come, reset the
 * head. Fired as a short canned ADD alongside the buy call, gated by a long
 * cooldown upstream so it scolds once, not every freezetime.
 */
export function tiltLine(): string {
  return pick("tilt", [
      "Third round straight you have died in the first ten seconds. Stop W-keying into them — hold an angle and let them come.",
      "You keep dying the second the round starts. Take a breath. Hold a spot, don't go hunting. Let them peek you for once.",
      "Same death every round — first ten seconds, dry peek, gone. Slow the hell down. Park on an angle and wait.",
      "You're feeding openers like it's a job. Quit running it down. Hold your angle, trade, reset your damn head.",
      "Every round you sprint out and die before I finish talking. Stop. Hold a corner, let the fight come to you.",
      "That's a pattern now: peek, die, repeat. Break it. Sit on an angle this round and make them earn it.",
      "You die first every single round 'cause you can't stop W-keying. Hold. Wait. Let some other idiot peek first.",
      "Dying in the opening ten again. Breathe, hold an angle, and for once let them come to your crosshair.",
      "Opening ten seconds, dead again. The map's not going anywhere. Hold a spot and let it come this round.",
      "You keep face-planting on the first peek. Just don't peek. Sit tight, hold the angle, win a fight standing still.",
      "Quit throwing yourself at them off spawn. Hold your position, keep your crosshair up, let them walk into it.",
      "You can't stop dry-peeking and it keeps killing you. Plant your feet this round. The fight comes to you for once.",
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
      "You burned to death in there. The fire wasn't a suggestion, move out.",
      "Walked into the molly and just stood there cooking. Step out next time.",
      "Burned down standing still like a dumbass. You step out of fire, that's the whole tip.",
      "Held an angle inside a molly. The fire was killing you, genius, not the enemy. Step out.",
      "You stood in flames long enough to die to them. Two steps. That's all it ever takes.",
      "Roasted in the open like you didn't see the floor glowing. Move out the fire, every time.",
      "Molly went down and you stayed put. That's not holding, that's self-immolation. Step the hell out.",
      "Died to a grill, not a gun. When the floor's on fire you leave it, simple as that.",
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
      "Full white screen and you held the fight anyway. Turn away, wait it out, then peek.",
      "Flash pops and you go forward? Backwards, every time. You don't win blind.",
      "Died swinging while you couldn't see a thing. The flash did half their job for them.",
      "You got popped and stood still in the open. Flashed means you reposition, not gift them a kill.",
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
      "Dead, but useful — call the spot and the gun before you tilt.",
      "You're down. Spend the death well: how many, what they're holding.",
      "Another one bites it. Talk before you respawn in your head — where, what weapon.",
      "Dead weight now, so be light weight: drop the callout, then shut it.",
    ]);
}

export function mvpLine(name?: string): string {
  const who = name ?? "our star";
  return pick("mvp", [
      `MVP, ${who}. The bar was on the floor. You cleared it.`,
      `Our MVP, everybody. One good round and the ego's already loading.`,
      `Round MVP. Frame that shit. Might not happen twice.`,
      `Look who's MVP. Same guy I yelled at all damn half. Growth.`,
      `${who} gets the MVP. You get five seconds of smugness, max.`,
      `Star on the scoreboard. Enjoy it. Rent's due next round.`,
      `That star's yours, ${who}. Don't ask what the competition looked like.`,
      `Hell must be chilly today. ${who} got the MVP star.`,
      `MVP, ${who}. Broken clock, right twice a day, and so on.`,
      `Look at ${who}, top of the round. Now do it without me begging.`,
      `${who} with the star. One round of competence, don't pull a muscle.`,
      `MVP goes to ${who}. Soak it up, the scoreboard forgets fast.`,
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
      `Buzzer-beater, ${ourScore}-${theirScore}. Don't let it go to your head. Heads are broke now anyway. New side, pistol.`,
      `Took the last one, ${ourScore}-${theirScore}. Half's in the books. We flip sides and start poor. Win the pistol, keep the momentum.`,
      `${ourScore}-${theirScore} at the half, our round to close it. Sides swap, banks empty out. Earn the other half too.`,
    ]);
  }
  return pick("halfEndLost", [
      `Lost the last one, ${ourScore}-${theirScore}. Money resets. Pistols don't give a shit about first halves.`,
      `That's the half, ${ourScore}-${theirScore}. Ugly ending. Good news: it all resets. Even that.`,
      `${ourScore}-${theirScore} at the break, and yeah, that last round was ass. Wipe it. New side, new bank.`,
      `Half's over, ${ourScore}-${theirScore}. Cash resets, and that whole side can't hurt you anymore.`,
      `Rough finish, ${ourScore}-${theirScore}. New side, fresh money. My halftime speech is two words: do better.`,
      `Dropped the closer, ${ourScore}-${theirScore}. Whatever. Sides flip, everyone's broke, the slate's clean. Take the pistol.`,
      `${ourScore}-${theirScore} into the break. That ending was a clown show, but it's wiped now. Fresh side, fresh start.`,
      `Gave that one back, ${ourScore}-${theirScore}. Half done. Money's gone for both of us, so go win the pistol and reset the mood.`,
    ]);
}

/** Round-end react when a TIED reset boundary sends the match to (more) overtime. */
export function otNextLine(ourScore: number, theirScore: number): string {
  return pick("otNext", [
      `${ourScore}-${theirScore}. Overtime. Everyone gets ten grand and a fresh shot at disappointing me.`,
      `Couldn't finish it. ${ourScore}-${theirScore}. Overtime now. Ten K each. Try not to piss it away.`,
      `Tied at ${ourScore}-${theirScore}, so it's OT. Fresh ten thousand, full buys, zero excuses.`,
      `Overtime, ${ourScore}-${theirScore}. Twenty years and these still take time off my life. Everyone's rich again. Buy proper.`,
      `All level, ${ourScore}-${theirScore}. Overtime. Ten grand a head, full kit, no eco nonsense. Just win rounds.`,
      `${ourScore}-${theirScore} and we're in OT. Wallets back to ten K. Whoever cracks first loses. Don't be them.`,
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
      `OT half flips, ${ourScore}-${theirScore}. Everyone's back to ten grand. Buy full, no heroes, take rounds.`,
      `Still in OT, ${ourScore}-${theirScore}. Sides swap, money's ten K again. Lock in and end it this time.`,
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
      `Lead's ${score} going into the break. Nice. Now it's a new side and an empty bank. Take the pistol and stretch it.`,
      `${score}, we're in front at the half. The cushion stays, the cash doesn't. Win the pistol or watch it shrink.`,
      `Ahead ${score} at the swap. Good half. Half a job. New money, new side, go win the opener.`,
    ]);
  }
  if (our !== undefined && their !== undefined && our < their) {
    return pick("halftimeBehind", [
      `Halftime, down ${score}. Could be worse. Barely. Fresh side, fresh money. Win the damn pistol.`,
      `We're losing ${score}. Were. Half's over, everything resets. Comeback starts at the pistol.`,
      `Down ${score} at the break. Good news: money resets. Bad news: you still have to aim.`,
      `That half was dogshit, ${score}. It's also over. New money, new side. Go take the pistol.`,
      `Break time, ${score} against us. Everyone's broke now, both teams. They've got to beat us all over again.`,
      `Behind ${score} at the half. So claw it back. Clean slate, fresh side, the comeback's a pistol away.`,
      `${score} down. Not dead. Money wipes, sides flip, the deficit's the only thing they keep. Win the opener.`,
      `Trailing ${score} into the break. New half wipes the cash, not the score. Take the pistol and start digging out.`,
    ]);
  }
  return pick("halftimeEven", [
      `A whole half and we learned nothing. ${score}. Money resets, pistol decides.`,
      `Halftime, ${score}. Dead even. We're exactly as average as them. Fix that after the swap.`,
      `All square at the break, ${score}. New half, new money. First to blink loses.`,
      `${score} at half, a coin flip. Cash resets. Win the damn pistol and stop flipping coins.`,
      `Tied ${score} at the swap. Nobody's better yet. New side, fresh bank, the pistol breaks the tie.`,
      `${score}, level at the half. Forty rounds and we're nowhere. Reset the money and go win the opener.`,
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
      "Match point. One clean round and we're done. No ego peeks, no clutch fantasies, just play it safe.",
      "Win this and it's over. So play scared. Trade everything, dry-peek nothing, let them throw it away.",
      "Closing time. Match point. Default it, hold, trade. The boring round is the winning round.",
      "We need one. Don't go chasing frags for the clip. Play slow, play tight, take the dub.",
    ])
    : pick("matchPointThem", [
      "They have match point. Nobody saves a thing. Win or go down shooting.",
      "Must-win round. Use every nade you own. You can't take them with you.",
      "Lose this and we're queueing again. No saving guns for a round that won't fucking exist.",
      "Match point against us. So what. Win this round, then shut them the hell up.",
      "Saving is canceled. Take the round or the guns won't matter anyway.",
      "Backs against the wall. Fine. I coach better annoyed. Full send, drag them back.",
      "It's win-or-go-home. Empty the bank, throw every util, leave nothing on the table.",
      "They're a round from done. So don't give it to them. Full buy, full send, fight for every inch.",
      "Do or die. No eco, no save, no half-measures. Spend it all and take the round.",
      "One loss ends it, so there is no next round to save for. Buy everything and go win this one.",
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
      `${ourScore}-${theirScore}, we took it. Against my expectations and probably yours. Good win.`,
      `Won it, ${ourScore}-${theirScore}. You traded, you held, you didn't feed for once. Look at that.`,
      `That's the match, ${ourScore}-${theirScore}, ours. I'm not crying, smoke got in my eyes twenty rounds ago and never left.`,
      `Final's ${ourScore}-${theirScore} and it's a W. Enjoy it. Tomorrow we go back to fixing your aim.`,
    ]);
  }
  if (won === false) {
    return pick("matchLost", [
      `Match lost. ${ourScore}-${theirScore}. I've seen worse. Not by much. Re-queue.`,
      `${ourScore}-${theirScore}. That's a loss. The queue button still works, thank god.`,
      `We lost ${ourScore}-${theirScore}. The game gave us chances. We said no thanks. Again soon.`,
      `Well, that was shit. ${ourScore}-${theirScore}. Sip of water, shake it off, queue again.`,
      `Final's ${ourScore}-${theirScore}, them. Don't queue angry, queue focused. There's a difference, allegedly.`,
      `That one's over, ${ourScore}-${theirScore}. Brutal. One more game. Spite is excellent fuel.`,
      `Dropped it, ${ourScore}-${theirScore}. The aim wasn't there, the trades weren't there. Next queue, both better.`,
      `${ourScore}-${theirScore}, loss. You whiffed the rounds that mattered. Re-queue and whiff fewer.`,
      `Lost ${ourScore}-${theirScore}. Not your finest. Don't sulk, hit requeue and run it back.`,
      `${ourScore}-${theirScore} and it's an L. Forget it before it lives in your head. New game, clean slate.`,
    ]);
  }
  return pick("matchOver", [
      `Match is over, ${ourScore}-${theirScore}. I showed up late, so you tell me how to feel.`,
      `That's a wrap at ${ourScore}-${theirScore}. Missed most of it, so I'll assume you were incredible. Next game.`,
      `Game's done, ${ourScore}-${theirScore}. No idea how that went, which might be a blessing.`,
      `It's over, ${ourScore}-${theirScore}. I blinked and missed it. You'll have to live with whatever that was.`,
      `Final says ${ourScore}-${theirScore}. I caught none of it, so I'm withholding judgment. For once.`,
      `Match wrapped, ${ourScore}-${theirScore}. Couldn't tell you a thing about it. Shake it off, queue up.`,
    ]);
}
