import type { MatchContext } from "../gsi/tracker.js";

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
 */
function pick(poolName: string, pool: string[]): string {
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
      "Alright team, match is live. Comms tight, win your duels, let's go!",
      "Here we go! Play smart, play together!",
      "Match is live. Deep breaths, trust your crosshair!",
    ]);
  }
  const map = mapDisplayName(rawMap);
  return pick("matchStart", [
    `Alright team, we're on ${map}. Comms tight, win your duels, let's go!`,
    `Here we go — ${map}. Play smart, play together!`,
    `Match is live on ${map}. Deep breaths, trust your crosshair!`,
    `${map} time. First rounds set the tone — sharp from the jump!`,
    `New match, ${map}. Clean comms, smart trades, good energy. Let's take it!`,
  ]);
}

/** Economy advice for freezetime, from own money/equipment + team loss streak. */
export function economyLine(ctx: MatchContext): string | null {
  const money = ctx.money;
  if (money === undefined) return null;
  const equip = ctx.equipValue ?? 0;
  const losses = ctx.ourLossStreak ?? 0;

  if (equip >= 3500) {
    return pick("ecoKitted", [
      "You're kitted — protect that gun and play for picks.",
      "Full equipment already. Play your life, don't throw it away.",
      "Gear's already in your hands — now make it count.",
      "You're set this round. Smart positions, let them make the mistakes.",
      "Loadout's full. Don't force anything — your gun wins this round if you let it.",
      "Still holding that loadout — make their push expensive.",
      "Equipment's there. Win the duel you choose, not the one they force.",
    ]);
  }
  if (money >= 4700) {
    return pick("ecoFullBuy", [
      "Full buy! Rifle, armor, util — take everything.",
      "You're rich — full buy and don't skimp on the grenades.",
      "Money's deep. Buy it all, don't leave anything in the bank.",
      "Wallet's loaded — full kit, full util, no excuses.",
      "Spend it! Rifle, head armor, every grenade you can carry.",
      "Big bank this round — buy the works and play confident.",
      "Healthy economy. Full loadout — now put it to work.",
    ]);
  }
  if (money >= 3700) {
    return pick("ecoBuy", [
      "You can buy — rifle and armor, grab util if you can.",
      "Buy round. Get your rifle, helmet if it fits.",
      "Enough for the rifle — armor first, then fill in util.",
      "Standard buy this round. Rifle up and find your spot.",
      "You've got rifle money. Buy it, and keep a flash in your pocket.",
      "Gun round — kit up and let your aim do the talking.",
      "The bank covers it. Spend smart, hit your timings.",
    ]);
  }
  if (money <= 1800) {
    if (losses >= 2) {
      return pick("ecoSaveStreak", [
        "Save this one — loss bonus is building, much better buy next round.",
        "Eco it. Stack the money, hit them harder next round.",
        "Keep the wallet shut — bonus money's coming, next round's the real fight.",
        "Discipline round. Bank it now so the rifles come back sooner.",
        "Hold the buy. One more save and the bonus does the heavy lifting.",
      ]);
    }
    return pick("ecoSave", [
      "Low on cash — save or grab a cheap pistol and play for exits.",
      "Eco round. Stack together, look for a pick and get out.",
      "Money's thin. Stay alive, steal a gun if one's free.",
      "Light buy at most — play sneaky, make their round expensive.",
      "Save round. Group up, take what they give you, nothing crazy.",
      "Broke round. Pistols and patience — punish anyone who peeks lazy.",
      "Not much to spend — keep it cheap, play for damage and exits.",
    ]);
  }
  return pick("ecoAwkward", [
    "Awkward money — force together or full save, just match your team.",
    "Half-buy territory. Whatever you do, do it as a five.",
    "In-between money. Commit with the team — all in or all save.",
    "Tricky wallet this round. Don't solo-force — follow the team's call.",
    "Middle-of-the-road money. Match the team's call and commit to it.",
  ]);
}

export function bombPlantedLine(ourSide: string | undefined): string {
  if (ourSide === "CT") {
    return pick("plantedCT", [
      "Bomb's down! Regroup and hit the retake together — about forty seconds.",
      "It's planted — don't trickle in! Group up, trade into the site.",
      "Plant's in — gather up, use your util, retake as a unit.",
      "Bomb's ticking. Go in together or don't go — make the retake count.",
      "It's down — breathe, regroup, hit the site as one.",
    ]);
  }
  if (ourSide === "T") {
    return pick("plantedT", [
      "Bomb planted, nice! Get to your crossfires and play the clock.",
      "Plant's down — spread out, play time, make them come to you.",
      "Good plant! Hold your angles, let the clock do the work.",
      "Bomb's in — post-plant time. Patience wins this one.",
      "Planted! Cross them up and punish the retake.",
    ]);
  }
  // Side unknown (e.g. just reconnected) — stay neutral.
  return pick("plantedNeutral", [
    "Bomb is down — play this one smart.",
    "Plant's in — heads up, clock's ticking.",
    "Bomb's planted — sharp from here on out.",
  ]);
}

export function bombDefusedLine(ourSide: string | undefined): string {
  if (ourSide === "CT") {
    return pick("defusedCT", [
      "Defused! Huge round, that's how you retake!",
      "That's the defuse! Calm hands when it counted.",
      "Sticks the defuse! Massive round — carry that energy forward.",
      "Defuse is in — that's a stolen round, love it!",
    ]);
  }
  if (ourSide === "T") {
    return pick("defusedT", [
      "They got the defuse — shake it off, reset and refocus.",
      "Defused. Tough one — next round, tighter post-plant.",
      "Lost it on the stick. Better crossfire next plant — move on.",
      "They snuck the defuse. Learn from it, shake it, next round.",
    ]);
  }
  return pick("defusedNeutral", ["Defuse on the bomb — that round's decided. Reset and go again."]);
}

export function bombExplodedLine(ourSide: string | undefined): string {
  if (ourSide === "T") {
    return pick("explodedT", [
      "Boom! Site taken, bomb down, round banked!",
      "That's the explosion we like to hear. Great execute!",
      "Up in smoke — full round in the bank!",
      "Detonation! Textbook post-plant, take a bow.",
    ]);
  }
  if (ourSide === "CT") {
    return pick("explodedCT", [
      "It blew — happens. Talk through what you saw and reset.",
      "Lost that one to the clock. Faster retake call next time.",
      "Round's gone with the blast — quicker decisions next time.",
      "It exploded. Reset — figure out where the retake stalled.",
    ]);
  }
  return pick("explodedNeutral", ["Bomb's gone off — round's over. Reset and refocus."]);
}

export function roundWonLine(ourScore: number, theirScore: number): string {
  return pick("roundWon", [
    `Round secured! ${ourScore}-${theirScore} — keep the momentum!`,
    `That's ours! ${ourScore} to ${theirScore}. Stay hungry!`,
    `Great round! ${ourScore}-${theirScore}, don't let off the gas.`,
    `Winner! ${ourScore}-${theirScore} — same focus next one.`,
    `${ourScore}-${theirScore}! Stack those rounds, this is working.`,
    `Round in the bag — ${ourScore} to ${theirScore}. More of that!`,
    `Clean round! ${ourScore}-${theirScore} — reset, re-buy, repeat.`,
  ]);
}

export function roundLostLine(ourScore: number, theirScore: number): string {
  return pick("roundLost", [
    `Lost it, ${ourScore}-${theirScore}. Heads up — next round is the only one that matters.`,
    `${ourScore}-${theirScore}. Shake it off, fix the spacing, go again.`,
    `Tough round. ${ourScore} to ${theirScore} — reset, refocus.`,
    `That one slipped, ${ourScore}-${theirScore}. Breathe — fresh round coming.`,
    `${ourScore} to ${theirScore}. Flush it — your next decision is the one that counts.`,
    `Lost the round, not the match. ${ourScore}-${theirScore} — tighten up and go.`,
    `Rough one. ${ourScore}-${theirScore} — talk it out and move forward.`,
  ]);
}

export function killLine(roundKills: number, headshot: boolean, name?: string): string | null {
  // Third-person fallback so templates like "${who} is on fire" stay grammatical.
  const who = name ?? "our star";
  if (roundKills >= 5) {
    return pick("killAce", [
      `ACE! ${who.toUpperCase()} WITH THE ACE! UNBELIEVABLE!`,
      `${who.toUpperCase()} JUST ACED! ARE YOU KIDDING ME?!`,
      `FIVE FOR FIVE — ${who.toUpperCase()} CLEARS THE WHOLE TEAM!`,
    ]);
  }
  if (roundKills === 4) {
    return pick("killQuad", [
      `Four kills — one more for the ace, ${who}!`,
      `That's four! One left — go write the highlight!`,
      `Quad kill! The ace is right there, ${who}!`,
    ]);
  }
  if (roundKills === 3) {
    return pick("killTriple", [
      `Triple kill! ${who} is on fire!`,
      "Three quick ones! Keep it rolling!",
      `Three down! ${who} is heating up!`,
      "That's three! The lobby's in trouble now.",
    ]);
  }
  if (roundKills === 2) {
    if (Math.random() >= 0.5) return null;
    return pick("killDouble", [
      "Double up! Nice work!",
      "Two down — keep going!",
      "Two for two — clean!",
      "Double! Keep that rhythm.",
    ]);
  }
  if (headshot) {
    if (Math.random() >= 0.25) return null;
    return pick("killHeadshot", [
      "Beautiful headshot!",
      "One tap! Clean.",
      "Dink and done — lovely.",
      "Crispy headshot, keep them coming!",
    ]);
  }
  return null; // single kills mostly stay quiet — don't spam
}

export function knifeKillLine(name?: string): string {
  const who = name ?? "our star";
  return pick("knifeKill", [
    `KNIFE KILL! ${who} just humiliated someone!`,
    "THE KNIFE! Oh that's going in the highlight reel!",
    `Stabbed! ${who}, you menace — fifteen hundred bonus too!`,
    "A knife kill in competitive?! Disrespect level: maximum!",
  ]);
}

export function zeusKillLine(): string {
  return pick("zeusKill", [
    "ZEUS! ZAPPED HIM! That's the funniest kill in Counter-Strike!",
    "The taser connects! Absolutely shocking behavior!",
    "Zeus kill! Two hundred dollars well spent!",
  ]);
}

export function nadeKillLine(nade: "he" | "fire"): string {
  if (nade === "fire") {
    return pick("mollyKill", [
      "Burned them alive! Molotov kill!",
      "Cooked! That molly found a home!",
      "The fire did the work — beautiful utility kill!",
    ]);
  }
  return pick("heKill", [
    "HE GRENADE KILL! Right on their head!",
    "Boom — the nade finishes it! Great damage!",
    "Grenade kill! That's just rude!",
  ]);
}

export function lowHpKillLine(hp: number): string {
  return pick("lowHpKill", [
    `On ${hp} HP and still winning fights — nerves of steel!`,
    `${hp} health! That's a one-tap away from disaster and you took the fight anyway!`,
    `Clutching duels at ${hp} HP — ice cold!`,
  ]);
}

export function teamkillLine(): string {
  return pick("teamkill", [
    "Whoa whoa — wrong team! Say sorry and buy them something nice.",
    "That was a TEAMMATE! New plan: shoot the other guys.",
    "Team kill! The enemies are the ones shooting back, for reference.",
    "Friendly fire is not friendly! Apologize in chat, quick.",
  ]);
}

/** Cheer for the teammate the dead player is spectating; quiet for routine kills. */
export function teammateKillLine(name: string | undefined, kills: number, health?: number): string | null {
  const who = name ?? "your teammate";
  if (kills >= 5) {
    return pick("specAce", [
      `${who.toUpperCase()} WITH THE ACE! You're watching greatness!`,
      `ACE for ${who}! Best seat in the house!`,
    ]);
  }
  if (kills === 4) {
    return pick("specQuad", [
      `${who} has four! One more, you can do it!`,
      `Four kills for ${who} — the ace is loading!`,
    ]);
  }
  if (kills === 3) {
    return pick("specTriple", [
      `${who} is going off — that's three!`,
      `Triple for ${who}! Cheer them on!`,
      `${who} just cleaned up three — your exit was worth it!`,
    ]);
  }
  if (health !== undefined && health > 0 && health <= 20 && kills >= 1) {
    return pick("specClutch", [
      `${who} is doing it on ${health} HP — hold your breath!`,
      `${who} clutching on fumes! Don't backseat, just believe!`,
    ]);
  }
  return null;
}

/** Locally-derived clock callout: ~35 seconds left, no plant yet. */
export function lateRoundLine(side: string | undefined): string {
  if (side === "T") {
    return pick("lateRoundT", [
      "Thirty-five seconds — if there's no plan, make one now. Get the bomb working!",
      "Clock's running, about thirty-five left. Commit somewhere — late hits need to be NOW.",
      "Half a minute! Pick a site and go together — don't die to the clock.",
    ]);
  }
  if (side === "CT") {
    return pick("lateRoundCT", [
      "Thirty-five seconds and no plant — the clock's on your side. Hold angles, no hero peeks.",
      "Time's your friend now. Stay patient, they have to come to you.",
      "Late round, no bomb down — discipline wins this. Don't chase.",
    ]);
  }
  return pick("lateRoundNeutral", ["About thirty seconds left this round — play the clock smart."]);
}

/** Locally-derived bomb-timer callout: roughly ten seconds left on the C4. */
export function bombTenLine(side: string | undefined): string {
  if (side === "CT") {
    return pick("bombTenCT", [
      "TEN SECONDS on the bomb — if you're not on the stick already, back off and live!",
      "Ten left! Kit defuse only territory — otherwise save your gun!",
      "Bomb's about to pop — clear out if the defuse isn't happening!",
    ]);
  }
  if (side === "T") {
    return pick("bombTenT", [
      "Ten seconds — it's almost yours, hold the angles, don't peek!",
      "Almost there! Let the bomb finish the job!",
      "Ten on the clock — stay disciplined, this round is banked!",
    ]);
  }
  return pick("bombTenNeutral", ["About ten seconds on the bomb — heads up!"]);
}

/**
 * Rule-based CT retake-or-save call when Claude isn't available (or too slow):
 * a coarse read of the player's own gear — the honest subset of what we know.
 */
export function retakeDecisionLine(ctx: MatchContext): string {
  // Dead (spectating): gear fields describe the teammate or nothing — talk to
  // the team instead of advising a corpse about its loadout.
  if (!ctx.playerIsSelf || (ctx.health ?? 0) <= 0) return bombPlantedLine("CT");
  const thinGear = (ctx.armor ?? 0) === 0 || (ctx.equipValue ?? 0) < 1500 || (ctx.health ?? 100) < 40;
  if (ctx.defuseKit) {
    return pick("retakeKit", [
      "Bomb's down and you've got the kit — your retake. Group up, you're on the stick!",
      "Plant's in — you carry the kit, so rally the team and hit it together. Kit makes this winnable.",
      "It's planted. Kit's in your pocket — trade in with the team and get on that bomb.",
    ]);
  }
  if (thinGear) {
    return pick("retakeThin", [
      "Bomb's down and you're thin — if the retake isn't clearly there, keep what you've got alive for next round.",
      "Plant's in. Light gear on you — only go if the team commits together, otherwise live for next round.",
      "It's planted — with that loadout, don't force a bad retake. Clean entry together or save.",
    ]);
  }
  return pick("retakeGo", [
    "Bomb's down! Regroup and hit the retake together — about forty seconds.",
    "It's planted — don't trickle in! Group up, trade into the site.",
    "Plant's in — gather up, use your util, retake as a unit.",
    "Bomb's ticking. Go in together or don't go — make the retake count.",
  ]);
}

export function deathLine(): string | null {
  // Speak rarely on death; nobody wants narration of every death.
  if (Math.random() > 0.3) return null;
  return pick("death", [
    "Unlucky — call what you saw, your team can still win this.",
    "You're down — give the info, keep your eyes on the round.",
    "Dead, not done — get your team the info.",
    "Tough exit. Watch the round, take notes for the next one.",
  ]);
}

export function mvpLine(name?: string): string {
  const who = name ? ` ${name}` : "";
  return pick("mvp", [
    `MVP${who}! Star of the round!`,
    "That's an MVP performance right there!",
    "Clip it — that round's going on the highlight reel!",
    `Round MVP${who}! More of that, please!`,
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
      `Halftime!${score} Don't get comfortable — new side, fresh focus.`,
      `Halftime!${score} You earned that lead — now defend it with the same energy.`,
      `Halftime!${score} Lead's ours — reset like it's zero-zero and stay hungry.`,
    ]);
  }
  if (our !== undefined && their !== undefined && our < their) {
    return pick("halftimeBehind", [
      `Halftime.${score} New side, clean slate — we claw this back.`,
      `Halftime.${score} Deep breath — new side, new plan. Plenty of rounds left.`,
      `Halftime.${score} Forget the scoreboard — win the first one back and build from there.`,
    ]);
  }
  return pick("halftimeEven", [
    `Halftime!${score} Everything to play for. Hydrate and lock in.`,
    `Halftime!${score} Big pistol round coming — lock in and take it.`,
    `Halftime!${score} Stretch, sip some water, come back sharp.`,
  ]);
}

export function matchPointLine(forUs: boolean): string {
  return forUs
    ? pick("matchPointUs", [
        "MATCH POINT! Close it out — no hero plays, just solid Counter-Strike!",
        "This is the one. Match point — full focus!",
        "Match point us! Play it clean — discipline finishes this.",
        "One round from the win. Same Counter-Strike that got you here!",
      ])
    : pick("matchPointThem", [
        "They're on match point. Backs to the wall — win this round, start the comeback.",
        "Their match point — deny it. One round at a time.",
        "Match point against — nothing to lose now, play free and take it back.",
        "They need one. Don't give it cheap — make this round a war.",
      ]);
}

export function matchEndLine(won: boolean | undefined, ourScore: number, theirScore: number): string {
  if (won === true) {
    return pick("matchWon", [
      `VICTORY! ${ourScore}-${theirScore}! GG team, that's how it's done!`,
      `That's the win! ${ourScore}-${theirScore} — what a performance, GG!`,
      `${ourScore}-${theirScore}, match closed! Enjoy that one, you earned it!`,
    ]);
  }
  if (won === false) {
    return pick("matchLost", [
      `${ourScore}-${theirScore}. Tough loss — review it, learn it, queue again stronger.`,
      `${ourScore}-${theirScore}. Not the result we wanted — but losses teach. GG, run it back.`,
      `Final, ${ourScore}-${theirScore}. Heads high — take the lessons, leave the tilt.`,
    ]);
  }
  return pick("matchOver", [
    `Match over, ${ourScore}-${theirScore}. GG!`,
    `That's the match — ${ourScore}-${theirScore}. GG everyone!`,
    `Final score ${ourScore}-${theirScore}. Good games all around!`,
  ]);
}
