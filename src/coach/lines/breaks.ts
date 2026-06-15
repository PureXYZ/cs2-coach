import type { MatchContext } from "../../gsi/tracker.js";
import { pick } from "./pick.js";
import { mapDisplayName } from "./maps.js";

/**
 * Canned fallback for the tactical-timeout call (LLM-less setups): loss-bonus level
 * 4+ (GSI's loss counter, which decays on a win rather than being a literal streak)
 * with a timeout in the bank. With the LLM enabled the freezetime prompt folds the
 * timeout into the buy call instead.
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
