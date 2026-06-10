import type { MatchContext } from "../gsi/tracker.js";

function pick(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)];
}

export function matchStartLine(map: string): string {
  return pick([
    `Alright team, we're on ${map}. Comms tight, win your duels, let's go!`,
    `Here we go — ${map}. Play smart, play together!`,
    `Match is live on ${map}. Deep breaths, trust your crosshair!`,
  ]);
}

/** Economy advice for freezetime, from own money/equipment + team loss streak. */
export function economyLine(ctx: MatchContext): string | null {
  const money = ctx.money;
  if (money === undefined) return null;
  const equip = ctx.equipValue ?? 0;
  const losses = ctx.ourLossStreak ?? 0;

  if (equip >= 3500) {
    return pick([
      "You're kitted — protect that gun and play for picks.",
      "Full equipment already. Play your life, don't throw it away.",
    ]);
  }
  if (money >= 4700) {
    return pick([
      "Full buy! Rifle, armor, util — take everything.",
      "You're rich — full buy and don't skimp on the grenades.",
    ]);
  }
  if (money >= 3700) {
    return pick([
      "You can buy — rifle and armor, grab util if you can.",
      "Buy round. Get your rifle, helmet if it fits.",
    ]);
  }
  if (money <= 1800) {
    if (losses >= 2) {
      return pick([
        "Save this one — loss bonus is building, full buy next round.",
        "Eco it. Stack the money, hit them hard next round.",
      ]);
    }
    return pick([
      "Low on cash — save or grab a cheap pistol and play for exits.",
      "Eco round. Stack together, look for a pick and get out.",
    ]);
  }
  return pick([
    "Awkward money — force together or full save, just match your team.",
    "Half-buy territory. Whatever you do, do it as a five.",
  ]);
}

export function bombPlantedLine(ourSide: string | undefined): string {
  if (ourSide === "CT") {
    return pick([
      "Bomb's down! Regroup and hit the retake together — about forty seconds.",
      "It's planted — don't trickle in! Group up, trade into the site.",
    ]);
  }
  if (ourSide === "T") {
    return pick([
      "Bomb planted, nice! Get to your crossfires and play the clock.",
      "Plant's down — spread out, play time, make them come to you.",
    ]);
  }
  // Side unknown (e.g. just reconnected) — stay neutral.
  return pick(["Bomb is down — play this one smart.", "Plant's in — heads up, clock's ticking."]);
}

export function bombDefusedLine(ourSide: string | undefined): string {
  if (ourSide === "CT") {
    return pick(["Defused! Huge round, that's how you retake!", "Ninja vibes — defuse secured, great work!"]);
  }
  if (ourSide === "T") {
    return pick(["They got the defuse — shake it off, reset and refocus.", "Defused. Tough one — next round, tighter post-plant."]);
  }
  return pick(["Defuse on the bomb — that round's decided. Reset and go again."]);
}

export function bombExplodedLine(ourSide: string | undefined): string {
  if (ourSide === "T") {
    return pick(["Boom! Site taken, bomb down, round banked!", "That's the explosion we like to hear. Great execute!"]);
  }
  if (ourSide === "CT") {
    return pick(["It blew — happens. Talk through what you saw and reset.", "Lost that one to the clock. Faster retake call next time."]);
  }
  return pick(["Bomb's gone off — round's over. Reset and refocus."]);
}

export function roundWonLine(ourScore: number, theirScore: number): string {
  return pick([
    `Round secured! ${ourScore}-${theirScore} — keep the momentum!`,
    `That's ours! ${ourScore} to ${theirScore}. Stay hungry!`,
    `Great round! ${ourScore}-${theirScore}, don't let off the gas.`,
  ]);
}

export function roundLostLine(ourScore: number, theirScore: number): string {
  return pick([
    `Lost it, ${ourScore}-${theirScore}. Heads up — next round is the only one that matters.`,
    `${ourScore}-${theirScore}. Shake it off, fix the spacing, go again.`,
    `Tough round. ${ourScore} to ${theirScore} — reset, refocus.`,
  ]);
}

export function killLine(roundKills: number, headshot: boolean, name?: string): string | null {
  const who = name ? `${name}` : "you";
  if (roundKills >= 5) return `ACE! ${who.toUpperCase()} WITH THE ACE! UNBELIEVABLE!`;
  if (roundKills === 4) return `Four kills — one more for the ace, ${who}!`;
  if (roundKills === 3) return pick([`Triple kill! ${who} is on fire!`, `That's a trip-le! Keep it rolling!`]);
  if (roundKills === 2) return Math.random() < 0.5 ? pick(["Double up! Nice work!", "Two down — keep going!"]) : null;
  if (headshot) return Math.random() < 0.25 ? pick(["Beautiful headshot!", "One tap! Clean."]) : null;
  return null; // single kills mostly stay quiet — don't spam
}

export function deathLine(): string | null {
  // Speak rarely on death; nobody wants narration of every death.
  if (Math.random() > 0.3) return null;
  return pick([
    "Unlucky — call what you saw, your team can still win this.",
    "You're down — give the info, watch and learn for the retake.",
  ]);
}

export function mvpLine(name?: string): string {
  return pick([
    `MVP ${name ?? ""}! Star of the round!`.replace("  ", " "),
    "That's an MVP performance right there!",
  ]);
}

export function halftimeLine(ctx: MatchContext): string {
  const our = ctx.ourScore;
  const their = ctx.theirScore;
  const score = our !== undefined && their !== undefined ? ` ${our}-${their} at the half.` : "";
  if (our !== undefined && their !== undefined && our > their) {
    return `Halftime!${score} Great half — don't get comfortable, new side, fresh focus.`;
  }
  if (our !== undefined && their !== undefined && our < their) {
    return `Halftime.${score} It's one half of Counter-Strike — new side, clean slate. We claw this back.`;
  }
  return `Halftime!${score} Everything to play for. Hydrate and lock in.`;
}

export function matchPointLine(forUs: boolean): string {
  return forUs
    ? pick(["MATCH POINT! Close it out — no hero plays, just solid Counter-Strike!", "This is the one. Match point — full focus!"])
    : pick(["They're on match point. Backs to the wall — win this round, start the comeback.", "Season's on the line — one round at a time."]);
}

export function matchEndLine(won: boolean | undefined, ourScore: number, theirScore: number): string {
  if (won === true) return `VICTORY! ${ourScore}-${theirScore}! GG team, that's how it's done!`;
  if (won === false) return `${ourScore}-${theirScore}. Tough loss — review it, learn it, queue again stronger.`;
  return `Match over, ${ourScore}-${theirScore}. GG!`;
}
