import { pick } from "./pick.js";

/**
 * C3 — the squad's entry-trade weak link: a wired teammate who keeps dying on the
 * opening. The roster code-gates this (once per offender per match, at freezetime),
 * so the line names them directly and roasts the habit (friends are fair game) while
 * staying number-free (no teammate count, per the K/D guardrail).
 */
export function squadOpeningDeathsLine(name: string): string {
  return pick("squadOpeningDeaths", [
      `${name}'s getting picked early over and over. Trade them, or ${name}, quit swinging out so soon.`,
      `We keep losing ${name} on the opening. Refrag them this round, or rethink who's entrying.`,
      `${name}, you keep getting picked early. Wait for a trade or let someone else open.`,
      `Somebody babysit ${name} on entry — they keep going in and dying early. That's free rounds we're gifting.`,
      `${name} keeps dying early on the opening like it's the assigned role. Trade the poor bastard or stop ego-peeking.`,
      `${name}'s feeding the opening like it's a chore. Trade off them or sit ${name} back this round.`,
      `${name}'s an early casualty too often. Quit peeking out so soon, ${name}, or stack a trade behind them.`,
      `${name} keeps dying early with no trade behind them. Babysit him or ${name}, hold your swing.`,
      `${name}'s entry is just a donation drive for the enemy. Trade him this round or ${name}, let someone else open.`,
      `${name} keeps swinging out too early like the round's gonna wait for them. It's not. Trade ${name}, or quit ego-peeking the entry.`,
      `${name} keeps opening up and giving it right back. Babysit the trade, or take entry off ${name} completely.`,
      `${name} keeps dying on the opening this match. Refrag them, or sit ${name} back till they learn to wait.`,
      `${name} keeps dying on entry with nothing behind them. Flash for them or ${name}, stop dry-peeking the open.`,
      `Stack up behind ${name} so the trade's free, 'cause they keep going down early.`,
      `${name} keeps trading themself for nothing. Someone refrag off them, or ${name}, hang back and let the team go first.`,
      `Whoever's entrying with ${name}, glue yourself to them — they keep dying early and we get nothing back.`,
      `${name}'s an early pick way too often. Either trade them instantly or ${name}, quit being the one who opens.`,
      `${name} keeps eating the entry this match. Babysit the swing or sit ${name} second man this round.`,
      `${name} keeps dying early before the round even gets going. Trade behind ${name} or tell them to quit peeking blind.`,
      `Enemy barely has to aim, they just wait for ${name} to walk out. Refrag off ${name} or hold that swing back.`,
      `${name}, you keep getting caught early and it's never on your terms. Wait for a flash or let the team go.`,
      `Pop a flash for ${name} before they swing, 'cause raw-dogging that angle keeps getting ${name} folded.`,
      `Whoever's nearest ${name}, swing on their hip — they keep going down early and someone better trade it.`,
      `${name} keeps dying on contact this match like the angle's personal. Refrag off ${name} or quit dry-swinging it.`,
      `Trade ${name} the second they peek, 'cause ${name} keeps going down on entry whether we're ready or not.`,
      `We're a man down early too often 'cause ${name} keeps dying on the opening. Babysit ${name} or sit them deep.`,
      `${name}, the enemy's got your peek timed. Change it up — wait on a flash or let the team open first.`,
      `${name} keeps swinging into them and we get jack back. Stack a trade on ${name} or pull them off point.`,
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
      "You keep dying early 'cause you can't stop W-keying. Hold. Wait. Let some other idiot peek first.",
      "Dying in the opening ten again. Breathe, hold an angle, and for once let them come to your crosshair.",
      "Opening ten seconds, dead again. The map's not going anywhere. Hold a spot and let it come this round.",
      "You keep face-planting on the first peek. Just don't peek. Sit tight, hold the angle, win a fight standing still.",
      "Quit throwing yourself at them off spawn. Hold your position, keep your crosshair up, let them walk into it.",
      "You can't stop dry-peeking and it keeps killing you. Plant your feet this round. The fight comes to you for once.",
      "Four peeks, four trips back to spawn. Knock it off. Pick an angle, hold it, let them come to you this round.",
      "First contact and you're already dead, every time. Take a damn beat. Stand still on a corner and make them find you.",
      "You're allergic to standing still and it's getting you killed. Glue your feet down this round. Wait the peek out.",
      "Dead before the bomb's even out the bag again. Slow it way down. Hold a spot, let them walk into your crosshair.",
      "You sprint into the same gun every round like it'll change. It won't. Hold the angle and let him come to you.",
      "Stop treating the round timer like a countdown to your own death. Take it slow. Sit on an angle, trade, breathe.",
      "That W key is gonna get you benched. Ease off it this round. Hold tight, crosshair up, wait them out.",
      "Off spawn and into a body bag, same story. Pump the brakes. Camp an angle and let them peek into you.",
      "Your first fight keeps being your last one. Slow your ass down. Hold an angle, trade it out, stop the bleeding.",
      "Stop swinging wide into nothing the second you spawn. Hold inside an angle. Make them come and trade when they do.",
    ]);
}
