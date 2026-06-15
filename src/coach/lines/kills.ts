import { pick } from "./pick.js";

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
      `Five down, nobody traded you, round's yours. Banked. Don't let it go to your head, ${who}.`,
      `Ugh. All five, no deaths, ${who}. That's the bar now. Hit it again or I take it back.`,
      `Whole enemy team, gone, your name on every kill. Fine. It happened. Move to the next, ${who}.`,
      "Clean ace. No bait, no luck, just frags. I hate that I noticed. Reset and do it again.",
      `Yeah okay, ${who}, that was real. Five for nothing. Now make it boring instead of a fluke.`,
      "Spray, dink, repeat, five times. Round's banked. Don't you spend the next ten asking if I saw it.",
      `Aced the round, ${who}, didn't even get traded once. Cool. Prove it twice before I clap.`,
      `Nobody on that team's alive and it's all you. Respect, briefly. Next round, ${who}, same energy.`,
      `Every one of 'em ate your bullets, ${who}. Round's secured. Quit grinning and reload.`,
      `An ace that actually held the site. Annoying. You can do it, so now do it every round, ${who}.`,
      "Whole stack wiped by you. Okay. That counts. Don't get comfy, the next round's a coin flip again.",
      `Clutched the whole thing into an ace, ${who}. I'll allow exactly one victory lap. Then back to work.`,
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
      `Four for ${who}. Reload now, because finding the ace on an empty mag is peak you.`,
      `There's the quad. One guy left, ${who}. Swing him wide, trade clean, don't gift it back.`,
      `Four bodies down, ${who}. Top up that mag and pre-aim. The fifth doesn't tap itself.`,
      `${who} sitting on four. Reset your crosshair, hold the lane, let him walk into it.`,
      `Stack on the quad, ${who}. Reload, wide swing, refrag. Three steps you'll skip one of.`,
      `Four kills and a heartbeat to ruin it, ${who}. Patience. Take the angle, not the bait.`,
      `That's a quad, ${who}. Last clown's hiding. Clear it slow, don't W-key into his nade.`,
      `Grit my teeth, ${who}, that's four clean. Now reload and earn the fifth without choking.`,
      `${who} on a quad. One left. Wide swing, get the trade, don't ego it and blow the ace.`,
      `Damn, four for ${who}. Last guy's alone. Swing it like you mean it, just not like a moron.`,
      `${who} stacked four. Top off, hold tight, take the safe swing. Ace is yours unless you fumble it.`,
      `Quad's done, ${who}. Now slow the hell down. Reload, wide angle, close it. Don't hand back the fifth.`,
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
      `Three bodies, ${who}. Good. Now stop pushing your luck and just hold where you are.`,
      `Don't let it go to your head, ${who} — three kills means you're a target now, so back off and trade.`,
      `Damn, ${who}, you actually traded smart. Three down. Keep doing that, don't go solo hero now.`,
      `Triple, ${who}. The round's yours to lose, so play it boring and bank it.`,
      `Surprise, ${who} got three. Now play off the noise and call where they're coming from, don't wander.`,
      `That's a triple, ${who}, and I hate that I'm impressed. Hold the angle, no greedy peek.`,
      `Three kills in and ${who}'s feeling froggy. Don't. Anchor the bomb and let them walk into you.`,
      `Okay ${who}, three down, you cooked. Now stop cooking and just hold the crossfire with your team.`,
      `${who} with three and a death wish. Pull back, reload, let the last guy come to your angle.`,
      `Triple from ${who}. Shocking. You've got the man advantage, so play it like it and don't even it back up.`,
      `${who} on three. Good. Call the last spot and let your teammate trade if it goes wrong, don't solo it.`,
      `Three kills, ${who} — you earned a save if it turns, so don't blow your gun chasing the fourth.`,
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
      `Knife kill, ${who}. That guy can Get Leetify and find a brand new hobby.`,
      `${who} skipped the gun and stabbed him anyway. Get Leetify, the rifle was just decoration.`,
      "He heard the knife switch and froze. Get Leetify, pal, that's a fear response.",
      `${who} reached out and touched him. Get Leetify and feel that one for a week.`,
      `Whole magazine on his hip and ${who} knifed him. Get Leetify, hell of a way to die.`,
      `${who} closed the distance and gutted him. Get Leetify, you let a blade walk you down.`,
      `Bro got knifed in his own spot by ${who}. Get Leetify and learn what a check is.`,
      `${who} snuck up and shanked him. Get Leetify, your headphones clearly do nothing.`,
      `${who} backstabbed him so hard the chat felt it. Get Leetify and turn around once in a while.`,
      `He had time to shoot and chose to die. Get Leetify, ${who} thanks you for standing still.`,
    ]);
}

export const ZEUS_KILL = [
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
      "Taser kill. He's gonna stare at the wall for a sec, trust me.",
      "You tased him. That's the round he doesn't put in the highlight reel.",
      "Zeus connects. Hope his rifle was comfy doing absolutely nothing.",
      "That's a battery to the face. Man's deleting the demo as we speak.",
      "Tased a full buy. You just made his whole loadout pointless.",
      "Zeus kill, baby. He's muting his mic so nobody hears him sigh.",
      "Taser tag. He brought a gun, you brought a hundred bucks of spite.",
      "Damn, the Zeus landed. His rifle's still warm and useless on the floor.",
      "Zeus to a guy with a rifle. The audacity worked, somehow.",
      "You shocked him out of the round. His teammates are never letting that go.",
];

export function zeusKillLine(): string {
  return pick("zeusKill", ZEUS_KILL);
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
      "He had a whole second to walk out of that puddle and didn't. You did nothing, you got paid.",
      "That's not a frag, that's a guy losing a fight with the floor.",
      "Somebody cooked to death and your crosshair never even moved. Wild.",
      "Whoever taught that guy to stand in fire owes you a frag.",
      "He melted on his own and you just claimed the loot. Lazy as shit.",
      "Crackling sound, dead body, zero shots fired. Inspiring stuff.",
      "You lit a corner and waited for room service. It delivered.",
      "Pro tip's wasted on you, but most players leave the fire. He stayed, you cashed in.",
      "Threw it, looked away, came back to a corpse. Hell of a workflow.",
      "Guy sat in flames like it was a hot tub and you took the credit. Sure, champ.",
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
      "Nade kill. Your crosshair sat this round out and you're still taking credit.",
      "Killed him with a nade and your aim didn't even get out of bed.",
      "That nade did the entry for you. You just heard the ding and smiled.",
      "Damn, the nade carried that duel so you didn't have to. How relaxing.",
      "Free frag off a nade. Your rifle's still sitting full, just like your stats.",
      "Blew him up without a single click. Your trigger finger's getting paid to do nothing.",
      "You got a kill and never had to aim. Living the dream, putting in shit effort.",
      "Cooked a frag with a nade. Now go win a round where you actually shoot something.",
      "Grenade got the kill. You got lucky he stood in the worst spot on the map.",
      "One nade, one body, zero aim. Don't put that on the resume.",
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
      `You were a fart away from dead at ${hp} HP. Go grab armor before the next one finds you.`,
      `Took that fight at ${hp} HP like you had health to spare. You didn't. Reset and play it safe.`,
      `${hp} HP is not a fighting number, it's a hiding number. You got away with it once.`,
      `Lucky the enemy aimed like my grandma. ${hp} HP says don't push that next angle.`,
      `Whole half of one tap away from the buy menu, ${hp} HP, and you peeked anyway. Stop it.`,
      `You're running on ${hp} HP and pure hope. Fall back, get util, let the team trade for you.`,
      `${hp} HP and you dry peeked a held angle. That worked once. It won't twice, so cut it out.`,
      `He folded to a guy on ${hp} HP and now you think you're him. Play off your team, don't solo it.`,
      `Picking duels like a full health hero on ${hp} HP. Damn. Hold the angle next time.`,
      `That was less a clutch and more a robbery at ${hp} HP. Bank it and stop gambling rounds away.`,
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
      "Blue team, you absolute weapon. Get in chat and type sorry.",
      "You just handed the enemy a free kill we paid for. Chat. Sorry. Move.",
      "That crosshair found the one guy on your side. Apologize in chat, real quick.",
      "Beautiful flick. Dead teammate. Type sorry before he respawns furious.",
      "Pal, friendly outlines exist for a reason. Drop a sorry in chat.",
      "You domed your own guy clean. Mechanically perfect, brain off. Sorry in chat.",
      "Hell of a one-tap on a teammate. Type sorry and hope he doesn't read it.",
      "You fragged the green name. Apologize in chat and never speak of it.",
      "Sweet entry frag, wrong door, wrong guy. Type sorry in chat, fast.",
      "Exit-fragged a man who was still on your side. Chat. Sorry. Now.",
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
      `${who} just hit three off the round you bailed on. Funny how that works.`,
      `That's a triple, ${who}. Dying first wasn't the plan, but you sure committed to it.`,
      `Three down for ${who}. They're mopping up the guys who shared a gun with you. Watch close.`,
      `${who} found three while you found the floor. Stay there, you're finally useful.`,
      `${who}'s at three and you're at room temperature. One of you read the round right.`,
      `Damn, ${who} just cracked three. Your job, done by someone who lived long enough to do it.`,
      `There it is, three for ${who}. Keep spectating, it's the one role you can't whiff.`,
      `${who} just got three because they actually traded instead of dying solo like a hero.`,
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
      `${who} just bagged three on their own. Quit gawking and trade the next one.`,
      `Whole lotta nothing from you while ${who} racks up three. Swing in and refrag.`,
      `${who} did three of your kills for you. Go earn one back and close it.`,
      `You planning to help ${who}, or just watch them go three deep solo? Trade.`,
      `${who}'s on a triple and you're a passenger. Get in there and back the swing.`,
      `Three already from ${who}. Don't let them clutch your round, get over and help.`,
      `Damn, ${who} actually went three deep. Back them up before it slips, trade it.`,
      `${who}'s up three and dragging you along. Refrag the next one or it's wasted.`,
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
      "Everyone's in the dirt but you. So slow it down, eat the clock, one fight at a time.",
      "Just you left, God help us. Don't sprint into all of them. Hold an angle, make them come.",
      "Nobody's coming to save you. Play patient, take the trades you want, no hero swing.",
      "You're solo now, so stop acting like it's a five-stack. Slow peeks, burn the clock, no panic.",
      "Team's gone, it's the you show. Don't dry peek into a stack. One fight, win it, then breathe.",
      "It's just you up there, try not to throw it in the first three seconds. Slow, patient, one at a time.",
      "You're the last lifeline, so don't yank it. Hold your angle, make them peek you, pick the trades.",
      "Solo for the round, hell. Play it like you've got all the time in the world, because you do. One at a time.",
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
      `${name}'s the only one breathing. Hand them one piece of info, then get off the mic.`,
      `You whiffed yours, so now ${name} carries it. One callout, then choke on the silence.`,
      `Squad's wiped except ${name}. Feed them the count, then sit dead and quiet like you earned it.`,
      `Round's in ${name}'s hands now, not yours. Spit one useful thing, then let them lock in.`,
      `${name}'s soloing it while you watch. One callout, then stop coaching from the afterlife.`,
      `It comes down to ${name}. Tell them what's where, then don't say another damn word.`,
      `${name}'s alive, you're not, that's the situation. One callout and you go quiet, hero.`,
      `Last pulse on the team is ${name}. Tell them once where they are, then let them clutch it.`,
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
      "Fire's on the floor and you treated it like a beanbag. Walk out, it's that easy.",
      "You let a molly out-damage the whole enemy team. Just leave the flames, man.",
      "Nobody shot you. You sat in a puddle of fire and waited to die. Step off it.",
      "Cooked yourself for free 'cause moving was too much effort. One step sideways, done.",
      "Tanked a molotov to the face standing still. Flames don't trade, they just delete you, so move.",
      "You picked a fight with a molly and lost. It's fire, you don't hold it, you leave it.",
      "Burned out in a corner like a forgotten candle. When it lights up, you walk off, every round.",
      "Damn, you really stood and let it tick you to zero. Step out the second you hear that whoosh.",
      "Molly lands, you freeze, you fry. Read the floor and move, it's not complicated.",
      "You stood your ground on literal fire. Ground was the problem. Move off it next time.",
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
      "White screen, full send, instant death. Look at a wall till it clears, then go.",
      "You can't aim through a flashbang, genius. Turn away and wait the half second.",
      "Blind as hell and still trigger-happy. Break off, let it fade, peek after.",
      "That flash hit and you just stood there feeding. Step back into cover when you're lit.",
      "Flashed and fighting is a coin flip you keep losing. Spin away and live.",
      "Eyes gone and you charged the angle anyway. Reset, then re-peek with your sight back.",
      "Popped that flash right in the face and held W. Pull off, hug a wall, breathe.",
      "You fought a fight you were never gonna win. Blind means back up, not bull rush.",
      "Flash lands and your instinct is to push? Kill that instinct. Spin off and wait.",
      "You held the angle with zero vision. Slide back, wait the flash out, then take the fight.",
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
      "Dead and quiet helps nobody. What killed you, where from.",
      "Toes up already. Fine. Tell the team the angle and the gun before you check out.",
      "You're a corpse with a working mic. Use it. Spot and weapon, now.",
      "Bit it again. Don't make it a wasted death. Where was he, what's he holding.",
      "Faceplant. Cool. Now feed the squad the info before you start moping.",
      "You died, shocker. The least you owe them is where and what killed you.",
      "Just died and went silent. Backwards. Talk first, where he peeked from.",
      "Tits up. Whatever. Drop the callout, how many you saw, then you can rage.",
      "Your round's over. Theirs isn't. Tell them what's coming and from where.",
      "Eat dirt, then earn it back with a callout. Position and weapon.",
      "You're done in this one. Pay rent before you go: spot, gun, count.",
      "Croaked. Don't go quiet on top of it. Give the angle and the gun.",
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
      `MVP star's yours, ${who}. Don't get attached to it.`,
      "There's the MVP. One. Write it down before it expires.",
      `Star next to your name, ${who}. Felt like an accident, didn't it.`,
      "MVP. You finally found the trigger. Took you long enough.",
      `${who} carries a round. The other four can stand down, apparently.`,
      "Round MVP. Slow clap. That's the whole celebration, by the way.",
      "MVP this round. Try remembering how you did it for once.",
      `Top frag, ${who}. I'd be impressed if I had lower standards.`,
      "Star earned. Annoying. Now go ahead and waste it next round.",
      `${who} as MVP. The universe owed somebody a favor, I guess.`,
      "MVP, huh. Don't go quiet on me now that you can actually aim.",
      `Round's yours, ${who}. Enjoy peaking before lunch.`,
      `MVP, ${who}. Fine. You earned that one. Hated typing it.`,
      `${who} got the MVP. Clip it, nobody'll believe you otherwise.`,
      "Star's on the board for you. Reset to mediocre whenever you're ready.",
      `MVP this once, ${who}. The scoreboard's just being polite.`,
      "You earned the star. I'll allow it. Don't make it a habit.",
      "MVP goes to you. Shocking. Genuinely. Now do it sober next time.",
    ]);
}
