import type { MatchContext } from "../../gsi/tracker.js";
import { pick } from "./pick.js";

export const PLANTED_CT = [
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
      "They got the plant down. Now we get it back together, util first, guns second. Don't freelance.",
      "Forty seconds is a lifetime if you stop sprinting in solo to get traded by nobody.",
      "Five of you, one site. Walk in as a wall, not a damn conga line of corpses.",
      "I see one of you creeping in early. Hold. We don't retake until all five are stacked.",
      "Throw the flash, throw the molly, then swing. Naked dry peeks just gift them the kill.",
      "This is a coordinated retake, not whoever-gets-bored-first. Wait for the call and go as one.",
      "Slow it down. The bomb's not going anywhere and neither should you without your four buddies.",
      "Whoever lurks in alone here is just a free frag with extra steps. Group up and push it clean.",
      "We've got the time, so use it. Stack at the entry, count down, swing together, trade hard.",
      "Quit peeking the same angle one by one. They love it. Hit it five-wide and make them choose.",
      "You've got util for a reason, so throw the damn nades before you walk into their crossfire.",
      "Stop staring at the timer and start staging the retake. Util ready, stacked up, then we go.",
];

export const PLANTED_T = [
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
      "Bomb's in the ground. Now glue yourself to an angle and let them sweat it.",
      "The hard part's done, so don't go inventing a new one. Sit on your crossfire.",
      "They gotta come to you now. So hold tight and make them eat the doorway.",
      "Quit itching to peek. The clock's already killing them, you don't have to.",
      "You got the plant. Don't trade it back for a dumb solo swing into nothing.",
      "Anchor on the bomb and shut up. Every tick you stay alive is theirs to panic over.",
      "Round's basically won if you just don't die being a hero. So don't.",
      "Let the beeps work on them. You sit still and hold what you got.",
      "Hold the line and let them rush in panicked. Patience wins this, not your trigger.",
      "Plant's down, so flip the brain off hunt mode and lock onto an angle.",
      "Don't peek out looking for heroics. Let them come find the barrel instead.",
      "Time's bleeding their side dry. So park it, watch the lane, and do nothing pretty.",
      "You did your job planting. Now do the boring one and just stay alive on it.",
      "Sit in your crossfire and wait. The round comes to you if you quit chasing it.",
];

export const PLANTED_NEUTRAL = [
      "Bomb's down. Forty seconds. Someone's about to have a shit day.",
      "That's a plant. Clock's live. Look alive.",
      "Plant's in. Clock's the boss from here.",
      "Bomb's planted. Forty on the clock, and it's counting for somebody.",
      "Plant went in. Just gotta survive the beeping now.",
      "That's the plant. Whoever blinks first loses this one.",
];

export function bombPlantedLine(ourSide: string | undefined): string {
  if (ourSide === "CT") {
    return pick("plantedCT", PLANTED_CT);
  }
  if (ourSide === "T") {
    return pick("plantedT", PLANTED_T);
  }
  // Side unknown (e.g. just reconnected) — stay neutral.
  return pick("plantedNeutral", PLANTED_NEUTRAL);
}

export const DEFUSED_CT = [
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
      "Defused. They spent their whole buy planting us a free round.",
      "Snipped it under the timer. Fine, that defuse was clean. Don't get used to it.",
      "Defused, and we walked off with it. Thanks for the carry, guys.",
      "Defuse landed. Their util, their entry, our scoreboard. Math checks out.",
      "Stole that one clean off the plant. Somebody over there is uninstalling.",
      "Took the wire off it. They did everything but win the round.",
      "Defused dry, nobody even contested. They just gave it away.",
      "That defuse held with no kit and no time. Okay, that one was filthy.",
      "Defused it out from under their nose. They planted, we collected. Simple.",
      "Wire's snipped, round's stolen. They bought that gun just to hand it over.",
];

export const DEFUSED_T = [
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
      "Heard the defuse beeps the whole time and still nobody peeked back. Round's gone.",
      "Post-plant is your job and you all ran off to find a fight somewhere else. Defused.",
      "You let them sit on that bomb the entire defuse. Hold an angle on it, damn.",
      "Seven seconds to swing the defuser and not one of you came back. That's a loss.",
      "They walked up and tapped it like nobody was even on the server. Watch the post-plant.",
      "You hear that wire cut? That's what no crossfire on the bomb sounds like.",
      "You pushed for picks and gave up the whole post-plant. Defused. Round wasted.",
      "You planted and treated it like the round was already over. It wasn't. It is now.",
      "Not a single nade thrown to stop that defuse. They strolled in and cut it.",
      "Stop chasing frags and watch the damn bomb. They just defused it in peace.",
];

export const DEFUSED_NEUTRAL = [
      "Bomb's defused. Somewhere, a T player is screaming into a pillow.",
      "Defuse went through. Round's settled either way.",
      "Wire's cut. Somebody won, somebody whiffed.",
      "That's a defuse. The plant didn't pay out for one side.",
      "Defused. Round's decided on the wire.",
];

export function bombDefusedLine(ourSide: string | undefined): string {
  if (ourSide === "CT") {
    return pick("defusedCT", DEFUSED_CT);
  }
  if (ourSide === "T") {
    return pick("defusedT", DEFUSED_T);
  }
  return pick("defusedNeutral", DEFUSED_NEUTRAL);
}

export const EXPLODED_T = [
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
      "Detonation. Sat on it and let the clock do the killing. Smart, for once.",
      "Bomb cooked. Nobody got greedy and threw it on a dry peek. Wild.",
      "That's the tick running out on them. We just shut up and let it pop.",
      "Round's ours. You held your corner instead of chasing a frag. Took you long enough.",
      "Plant held, bomb popped, round won. Three things in a row, who are you.",
      "Bomb did the heavy lifting. All you had to do was not screw it up, and damn, you didn't.",
      "Site's smoke. We never gave up the post-plant, so they never got a swing. Round's done.",
      "That's it ticking down to nothing. We let them come to us and it cost them the round.",
      "Boom. They wanted a retake, we wanted to stand still and win. We won.",
      "Round's in the bag. Played the clock instead of your ego for once and look what happens.",
];

export const EXPLODED_CT = [
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
      "Bomb beat us to the site. Retake's supposed to get there first, genius.",
      "We let the timer do the killing for them. Swing the damn site next time.",
      "You peeked the post-plant one at a time. They thanked you. Round's done.",
      "That's a CT loss because nobody committed to the take. We trickle, we die.",
      "Bomb's up, we're scattered, and now it's down. Stack and hit it together.",
      "You waited for the perfect retake and got the loud one instead. Gone.",
      "We had the numbers and used none of them. That's on the slow swing.",
      "Site's a crater and so's the round. Retake means go, not gather.",
      "You saved your util for the highlight reel. Should've spent it on the take.",
      "They sat on that plant rent-free. Punish the post-plant or lose it.",
];

export const EXPLODED_NEUTRAL = [
      "That was the bomb. Somebody's payday, somebody's problem.",
      "Big boom. Round's decided one way or another.",
      "Detonation. The clock ran out on somebody.",
      "That's the bomb going off. Round's locked.",
      "Big one. Somebody won that exchange, somebody ate it.",
];

export function bombExplodedLine(ourSide: string | undefined): string {
  if (ourSide === "T") {
    return pick("explodedT", EXPLODED_T);
  }
  if (ourSide === "CT") {
    return pick("explodedCT", EXPLODED_CT);
  }
  return pick("explodedNeutral", EXPLODED_NEUTRAL);
}

export const LATE_ROUND_CARRIER = [
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
      "You specifically have the bomb. Yeah, you. Thirty-five seconds. Walk it onto a site and plant.",
      "That bomb isn't getting any warmer in your hands. Half a minute. Pick a site and stick it.",
      "Whole round's riding on your back right now. Thirty-five. Quit stalling, get the bomb down.",
      "You can keep wandering or you can win. The C four's on you. Hit a site and plant.",
      "Thirty seconds and the bomb's still just luggage. Drop it on a site, not in spawn.",
      "Stop window shopping for an angle. You've got the C four. Walk it in and plant, now.",
      "Round ends in your hands if you don't move. Thirty-five seconds, bomb's yours. Pick a site.",
      "Thirty-five on the clock and you're babysitting the bomb. Quit it. Site. Plant. Now.",
      "Every second you hold that thing is a second you're not winning. Pick a site and plant it.",
      "You wanted the C four, now use it. Thirty-five seconds. Commit to a site and plant it.",
];

export const LATE_ROUND_T = [
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
      "Picks are nice. A planted bomb is nicer. Get to a site.",
      "You're not gonna frag your way to a win here. Site, bomb, now.",
      "Roaming around solo isn't a strat. Group up and take a site.",
      "Five of you, zero plants. Funnel into a site and stick it.",
      "Stop poking corners and go own a site. The clock's not waiting.",
      "Thirty-five seconds of dicking around the map. Pick a bombsite. Go.",
      "You've been hunting kills for thirty seconds. Hunt a damn site instead.",
      "Nobody's coming to win this for you. Crash a site and plant.",
      "The map's not the objective. The site is. Get there and stick the bomb.",
      "Spread out doing nothing. Collapse on one site and bury the bomb.",
];

export const LATE_ROUND_CT = [
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
      "Timer's a CT main weapon. Use it. Don't peek it away.",
      "They blink first, not us. Hold your spot and wait it out.",
      "Bomb's still in their bag. Every second it stays there, we win. Sit.",
      "You move, you lose the round. Plant your ass and hold.",
      "Quietest player wins this one. Be boring. Hold the angle.",
      "Nothing's down, so do nothing. Crosswalk peeks lose this round.",
      "We're up on the clock. Don't refund it with some hero swing.",
      "Make them walk into you. Wandering off donates the round to them.",
      "Hold the choke. Force them to commit late and trade ugly.",
      "Stop hunting. The kill comes to your crosshair if you just wait.",
];

export const LATE_ROUND_NEUTRAL = [
      "Thirty seconds, no plant. Somebody's about to panic. Don't be them.",
      "Clock's getting loud, no bomb down. Someone make a damn decision.",
      "Thirty left and the bomb's still in a pocket somewhere. Sort it out.",
      "No plant, clock's draining. Whatever the call is, make it now.",
      "Half a minute, nothing down. Stop drifting and lock in a play.",
];

/** Locally-derived clock callout: ~35 seconds left, no plant yet. */
export function lateRoundLine(side: string | undefined, hasBomb = false): string {
  // The player is personally carrying the C4 — the generic "someone plant"
  // nudge lands very differently when the someone is them.
  if (side === "T" && hasBomb) {
    return pick("lateRoundCarrier", LATE_ROUND_CARRIER);
  }
  if (side === "T") {
    return pick("lateRoundT", LATE_ROUND_T);
  }
  if (side === "CT") {
    return pick("lateRoundCT", LATE_ROUND_CT);
  }
  return pick("lateRoundNeutral", LATE_ROUND_NEUTRAL);
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

export const BOMB_TEN_CT_FIGHTING = [
      "Ten seconds, finish him fast. The bomb's not waiting for style points.",
      "Ten on the clock, drop him quick then kit or quit.",
      "Ten left, you're winning the duel, so win it now and bail.",
      "Ten seconds, close it out fast. Pretty doesn't beat the timer.",
      "Ten on the clock, clap him and get the hell out, no time to admire it.",
      "Ten left, you're swinging, so swing fast and don't eat the tick.",
      "Ten seconds, one more frag and reset. Make it quick.",
      "Ten on the bomb, win the fight now or the round wins for them.",
];

export const BOMB_TEN_CT = [
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
      "That bomb's cooked in ten and you're not defusing it, so stop loitering and walk your rifle out of here.",
      "You've got maybe ten ticks and zero defuse. Turn around, the gun's the only thing worth keeping now.",
      "Nobody's making you hug that bomb. Ten left, no kit, no defuse, so peel out and live.",
      "Round's lost in ten, but the rifle doesn't have to be. Off the site, now.",
      "Standing there for ten more seconds just hands them a free body. Bail and keep the gun, genius.",
      "Ten left and that defuse was never happening. Quit hovering and save the damn rifle.",
      "You're not in a fight and you're not on the bomb, so what's the plan, eat it? Ten left, leave, keep the gun.",
      "Clock says ten, your hands say no defuse. Easy math. Walk away with the rifle.",
      "No defuse in ten, so don't make it a funeral too. Slide off site and hold that rifle.",
      "Ten and you're parked too far to do a thing. Unpark, take the rifle, reset for next.",
];

export const BOMB_TEN_T_FIGHTING = [
      "Ten seconds, drop him then plant your ass back on the bomb.",
      "Ten left, that's probably the defuser. Kill him and sit on it.",
      "Ten on the clock, win that duel fast then freeze. The bomb does the rest.",
      "Ten seconds, one more and it's over. Trade him, then hold the bomb.",
      "Ten left, finish him, don't chase. Park back on the C four.",
      "Ten on the clock, drop him quick and let the timer close it.",
      "Ten seconds, clap him then hold tight. Don't wander, the bomb wins it.",
      "Ten left, you're already swinging. Drop him and get back on the C four.",
];

export const BOMB_TEN_T = [
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
      "Ten seconds. Bomb starts whining, that's a defuse, go end it. Quiet means quiet, hold.",
      "Ten on the clock. You hear scratching on the C four, peek and gun him. Nothing? Glue yourself to that angle.",
      "Ten left. A defuse noise is your green light, swing it. No noise, no hero swing, just hold.",
      "Ten seconds. Defuse kicks in, kill it before the wire drops. Dead air, plant your feet and wait.",
      "Ten on the bomb. Hear him working it, lean out and drop him. Hear jack, hold and let it tick.",
      "Ten left. That tapping's a CT signing his own death cert, go peek it. Silence, sit and ride the clock.",
      "Ten seconds. Catch a defuse and you swing, simple. Catch nothing and you do nothing but hold.",
      "Ten on the clock. Bomb talking back means a defuse, shut him up. Bomb's silent, so are you, hold.",
      "Ten seconds. A tap on the C four, swing and trade it out. No tap, no swing, the timer carries you.",
      "Ten left. Someone's prying it, peek and drop him fast. Nobody's prying, then nobody peeks, hold.",
];

export const BOMB_TEN_NEUTRAL = [
      "Ten on the bomb. This ends loud or it ends quiet.",
      "Ten seconds, no more waffling. Finish the damn round.",
      "Ten left. Whatever the play is, commit and close it out.",
      "Ten on the clock, quit dithering and make the call.",
      "Ten seconds left, do whatever you're doing, just do it faster.",
      "Ten on the bomb, it's decided in the next breath. Commit.",
      "Ten left, no time to think twice. Pick a play and end it.",
      "Ten seconds, the round's basically over. Make it count.",
];

/** Locally-derived bomb-timer callout: roughly ten seconds left on the C4. */
export function bombTenLine(side: string | undefined, fighting = false): string {
  if (side === "CT") {
    // Mid-fight: the player just got a kill — give them the clock, not a
    // "back off" order aimed at someone who's clearly winning the exchange.
    if (fighting) {
      return pick("bombTenCTFighting", BOMB_TEN_CT_FIGHTING);
    }
    return pick("bombTenCT", BOMB_TEN_CT);
  }
  if (side === "T") {
    // Just got a kill near the planted bomb — almost certainly fighting a CT
    // going for the defuse. Back the play; a "freeze" order would be wrong here.
    if (fighting) {
      return pick("bombTenTFighting", BOMB_TEN_T_FIGHTING);
    }
    // GSI never tells a T player whether a CT is defusing, so the only honest
    // call is BOTH branches: peek to stop a defuse, hold if it's clear. (A live
    // session flatly said "freeze, don't peek" while CTs were mid-defuse.)
    return pick("bombTenT", BOMB_TEN_T);
  }
  return pick("bombTenNeutral", BOMB_TEN_NEUTRAL);
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
