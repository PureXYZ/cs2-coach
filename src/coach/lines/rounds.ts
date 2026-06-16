import type { MatchContext } from "../../gsi/tracker.js";
import { pick } from "./pick.js";
import { mapDisplayName } from "./maps.js";

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

/**
 * Canned fallback for the warmup scouting speech (LLM off or failed) — a longer,
 * multi-sentence cousin of matchStartLine for the pre-round-1 dead air. No Leetify
 * data here (that only feeds the LLM prompt); just a dry pre-match brief in character.
 */
export function warmupSpeechLine(rawMap: string): string {
  if (!rawMap || rawMap === "unknown") {
    return pick("warmupSpeechNoMap", [
      "Alright, warming up. Map's still a mystery, your bad habits aren't. Whatever we land on, win the pistol, trade your deaths, and stop peeking like you're immortal. Low bar. Clear it.",
      "Here we go again. Don't know where yet, doesn't matter — same three things every map: armor on pistol, swing together, and quit dying first for free. Let's see if it sticks this time.",
      "Loading in. I've watched enough of these to know how it goes, so let's skip the part where you forget the basics. Crosshair at head height, trade everything, and play the round in front of you.",
      "Warmup's running. New lobby, fresh chance to disappoint me. Keep it simple — win pistol, hold your angles, don't lone-wolf. I'll yell about the rest when you inevitably ignore that.",
    ]);
  }
  const map = mapDisplayName(rawMap);
  return pick("warmupSpeech", [
    `${map} it is. Warmup's the easy part, try not to peak here. Win the pistol, trade your deaths, and play the map you've theoretically practiced. Keep it boring and we steal a few.`,
    `We drew ${map}. You know this map, so act like it for once. Group up on pistol, hold your crossfires, and stop entry-fragging yourself into the void. Simple plan. Execute it.`,
    `Loading into ${map}. Here's the whole brief: armor on pistol, swing as a team, and don't give them first blood for free every round. Do that and I'll find something else to complain about.`,
    `${map}. Cute. Last thing I need is you treating warmup like the highlight reel. Lock in — win pistol, trade, hold angles, and play the actual map instead of the one in your head.`,
    `Back on ${map}. Same map, same shot at not embarrassing us. Take the pistol seriously, keep your util for the round that matters, and trade every kill. Crosshair up, ego down.`,
    `Fresh game on ${map}. Warmup's for stretching, not for whiffing your whole match early. Win the pistol, play together, and quit dying in the opening five seconds. That's the bar. It's low.`,
    `We're on ${map}. Good map to look competent on, big ask I know. Group up, win pistol, hold your angles and trade. Keep it disciplined and the rounds come. Get fancy and they bury us.`,
    `${map} again. I remember how this usually goes, so let's rewrite it. Armor and util on pistol, swing the same fight together, and for the love of god stop dry-peeking. Set the bar at not-a-disaster.`,
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
      `Won it ${ourScore}-${theirScore}. Now wipe the grin, the match isn't done.`,
      `Round's in the bag, ${ourScore}-${theirScore}. One round means nothing, keep your head down.`,
      `Cute, ${ourScore}-${theirScore}. They handed you that one, so don't act like you earned it.`,
      `There it is, ${ourScore}-${theirScore}. Save the celebration, the match isn't won.`,
      `Took the round, ${ourScore}-${theirScore}. Reset the angles and do it clean again.`,
      `Up ${ourScore}-${theirScore}. Good. Now play like you actually want the next one.`,
      `Round goes to us, ${ourScore}-${theirScore}. Settle down, the scoreboard's not finished.`,
      `Yeah, ${ourScore}-${theirScore}. Pocket it and shut up, we want the next one too.`,
      `Banked, ${ourScore}-${theirScore}. Don't blow the lead getting cocky.`,
      `Damn, that was actually clean. ${ourScore}-${theirScore}. Hate that I'm impressed, do it again.`,
      `Eat the round, ${ourScore}-${theirScore}, and chase the next one before you start gloating.`,
      `Hey, a win, ${ourScore}-${theirScore}. Hold the angles and quit overpeeking on the next.`,
      `Number went up, ${ourScore}-${theirScore}. Doesn't mean you're good, means you held on.`,
      `Round's done, ${ourScore}-${theirScore}. Reload the brain, we run the same setup again.`,
      `Sure, ${ourScore}-${theirScore}. Now trade your teammates so the next one isn't a coin flip.`,
      `Decent, ${ourScore}-${theirScore}. Now stack your util on the bombsite and close it out.`,
      `You took it, ${ourScore}-${theirScore}. Big deal. Refrag clean and don't gift it back, dipshit.`,
      `Stamp it, ${ourScore}-${theirScore}, and quit the victory lap, nobody's watching but me.`,
      `Hell of a hold there, ${ourScore}-${theirScore}. Don't get used to me saying that, lock in.`,
      `Got the round, ${ourScore}-${theirScore}. Now play it slow and don't gift the next one back.`,
      `That's a point, ${ourScore}-${theirScore}. Save the swagger, your spray still scares nobody.`,
      `On the board, ${ourScore}-${theirScore}. Breathe, set your crosshairs, go take another one.`,
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
      `${ourScore}-${theirScore}. You dropped a rifle and reset with a pistol. That math never works.`,
      `Saved a gun, lost the round, helped nobody. ${ourScore}-${theirScore}. All the way in or all the way out, not the worst of both.`,
      `Burned all your time deciding, then forced it. ${ourScore}-${theirScore}. Make the call early next round.`,
      `${ourScore}-${theirScore}. First contact, instant death, no trade behind you. Stagger it, don't all die solo.`,
      `Lost the man advantage doing nothing with it. ${ourScore}-${theirScore}. Trade hard when you're up bodies.`,
      `${ourScore}-${theirScore}. You peeked three guys with a pistol out. Pick smarter fights.`,
      `Solo entry, no flash, instant death. ${ourScore}-${theirScore}. Pop a flash before you swing, idiot.`,
      `Backpedaled into your own teammate and both died. ${ourScore}-${theirScore}. Hold your damn lane.`,
      `${ourScore}-${theirScore}. You reloaded mid-fight and ate the dink. Bank your shots, then reload.`,
      `Chased one frag across the map and got cut off. ${ourScore}-${theirScore}. Stay with the group.`,
      `${ourScore}-${theirScore}. You sat full HP in spawn the whole round. Get in the fight next time.`,
      `Flashed your own team blind and walked into the trade. ${ourScore}-${theirScore}. Aim those flashes deep.`,
      `${ourScore}-${theirScore}. You jiggled that corner ten times and still got picked. Just hold it.`,
      `Plant went down, then everyone forgot to play post-plant. ${ourScore}-${theirScore}. Crossfire the retake.`,
      `${ourScore}-${theirScore}. Bought a deagle on a full buy, missed, died. A whole rifle budget, wasted on a hand cannon.`,
      `Last alive, panicked, ran straight at the bomb. ${ourScore}-${theirScore}. Play the clock, not your nerves.`,
      `${ourScore}-${theirScore}. You triple-peeked the same window. They knew. Vary it up.`,
      `Saved your gun, ran into a knife, died anyway. ${ourScore}-${theirScore}. Save means leave, not sightsee.`,
      `${ourScore}-${theirScore}. Whole team rushed one door and got mollied. Spread out before you commit.`,
      `Dropped your nades on the floor and shot air instead. ${ourScore}-${theirScore}. Lineups exist, use them.`,
      `${ourScore}-${theirScore}. You swung the AWPer dry, no smoke, no trade. Smoke him off first.`,
      `${ourScore}-${theirScore}. You all stacked one site and they hit the other. Watch the map.`,
      `Bomb was down and you went hunting exit frags. ${ourScore}-${theirScore}. Babysit the bomb, win the round.`,
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

export const MATCH_POINT_US = [
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
      "One round and we're showered. So don't free them a kill. Hold tight, trade, walk it in.",
      "This round's already won if you don't get greedy. Default, hold angles, no dry peeks.",
      "You want the win or the highlight? Pick the win. Crosshair up, trade, take no dumb fights.",
      "Last round of the night if you behave. Play off your buddies, trade everything, zero solo swings.",
      "Final stretch. Slow it down, let them come to you, and trade the second one of us drops.",
      "Nobody peeks first this round. Make them come dry, trade clean, and it's over.",
      "We do not need a play, we need a round. Park on your angle and let them lose it for you.",
      "Don't overthink the close-out. Tight angle, good trade, no chasing. That's the whole round.",
      "Last one. Crossfire it, trade the entry, and do not go fishing for some clutch you don't need.",
      "Close it like a pro, not a streamer. Hold, trade, save the heroics for a round that doesn't matter.",
];

export const MATCH_POINT_THEM = [
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
      "This is the last one if you blow it, so dump the whole bank and go win.",
      "No save here. Save for what, the menu screen? Full buy and take it.",
      "They need one round. Don't hand it over. Buy it all, throw it all, fight.",
      "Stop fishing for a save. Nothing to save for. Full util, full send, win it.",
      "They smell the win. Take it off them. Buy everything, use everything, no holding back.",
      "Lose and we're done, so play like the money's worthless. Full buy, win the round.",
      "Hold your nades for next round and there won't be one. Throw it all, take this.",
      "Quit eyeing the exit. No saving, no eco, just full buy and win this round.",
      "They're banking on you folding. Don't. Spend it all, throw every flash, take it.",
      "Whole match comes down to now. Don't save a damn thing, full send and close it out.",
];

export function matchPointLine(forUs: boolean): string {
  return forUs
    ? pick("matchPointUs", MATCH_POINT_US)
    : pick("matchPointThem", MATCH_POINT_THEM);
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
