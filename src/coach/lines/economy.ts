import type { MatchContext } from "../../gsi/tracker.js";
import { pick } from "./pick.js";

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
      "Round one. You get armor or you get util, never both. Then huddle up and hit one spot.",
      "Eight hundred is eight hundred. One thing on the Glock, armor or a nade. And nobody peels off alone.",
      "This is the cheapest round of the game. Buy armor or a flash, then five of you, same angle.",
      "Skip the lone hero stuff. Kevlar or util, one each, and swing it as a wall.",
      "Pistols. You can afford exactly one upgrade, so pick it. Then group and trade like adults.",
      "Don't overthink eight hundred bucks. Armor or a nade, that's the menu. Now stick together.",
      "First round and you're already drifting apart. Armor or util, one each, then bunch up and commit.",
      "Pistol round math is real simple. One purchase, armor or a flash. After that, no splitting up.",
      "Nobody's rich on pistol. Grab armor or a nade, not the both of them, and play it five wide.",
      "Round starts, brains turn off. Armor or util, one apiece. Then group and take one fight together.",
      "It's the pistol, treat it like one. One buy each, armor or util, and don't you dare go solo.",
      "Keep it dead simple. Armor or a nade per guy, then five-man one fight and refrag your buddy.",
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
      "You've got the rifle, you've got the nades. The store has nothing for you. Just don't die for nothing.",
      "Full kit on the body. Hands off the menu, brain on the round. Walk it out alive.",
      "Stacked already. The buy menu's a trap this round, close it and go win.",
      "Rifle, util, the works. The only bad spend left is your life, so quit volunteering it.",
      "Pockets full, menu shut. Survive the round and you do it all again next one. Easy math.",
      "You walked in loaded. Now walk out the same way, with the gun still in your hands.",
      "Everything's on you already. So the round comes down to one thing: don't get caught out and feed it.",
      "Geared and ready, which means the buy menu does nothing for you. Trade smart, stay alive, keep it.",
      "No buy this round, you're set. The whole job is not throwing the rifle in some pointless duel.",
      "You've got it all packed already. The only way to bleed value here is dying with it. So don't.",
      "Kitted top to bottom. Menu stays closed, head stays on, rifle comes home in one piece.",
      "Nothing left to grab in there, so play it like the gun matters. Right now it's all you've got to lose.",
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
      "Bank's overflowing. So buy the gun, the armor, and the nades. All three, not two.",
      "Max round. Drop the cash on a rifle, plates, and a full bag of util.",
      "Stop staring at that number. Rifle, kevlar, smokes, flashes. Then walk out and use it.",
      "Four grand plus and you wanna save? Nah. Full buy, every grenade. Go.",
      "Treat yourself. The whole shop. And the nades aren't a treat, they're the buy.",
      "You're loaded, so act like it. Gun, plates, every grenade slot filled. Move.",
      "Easy round to buy. It's all of it or it's a chat about why you went cheap.",
      "Top dollar in the bank. Rifle, kevlar, and yes the smokes count, buy them.",
      "Rolling in it. So get the rifle, the armor, and a flash for every angle. Don't skimp.",
      "Full pockets, full buy. Rifle, plates, nades, the lot. Then go put it to work.",
      "Stacked this round. Spend it all. Gun, armor, grenades, and actually throw them.",
      "Your bank's fat and your util bag is empty. Fix the second one. Buy the nades.",
      "Loaded up. Rifle, kevlar, every grenade you keep pretending to forget.",
      "All that cash and you're hovering on save? Full buy. Get the smokes. Get out there.",
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
      "Half a wallet, half a buy. Rifle and armor, then stop. Util's not happening today.",
      "Money's okay, not great. Plates and a gun lock in first. A nade only if there's scraps left.",
      "Buy the rifle, buy the armor, then walk away from the menu. Nades wait for a richer round.",
      "Rifle and plates, hard stop. You want full util, go win a round first and earn it.",
      "Don't overbuy on a half-stack. Rifle, kevlar, and one nade only if the numbers actually clear.",
      "Tight money. Lock the gun and plates, then see if a single flash survives the math. Probably won't.",
      "Rifle and armor cover you. Skip the full kit, your bank can't write that check today.",
      "You're sitting on a buyable rifle. Take it, take plates, and leave the nades for the big-money round.",
      "Average money, average shopping. Gun, armor, done. A grenade's a bonus, not the goddamn plan.",
      "Half-decent bank. Plates and a rifle, no negotiating. Everything else depends on what's left over.",
      "This is a rifle-and-armor round, nothing fancier. Force a full kit here and you'll be broke next round, dumbass.",
      "Enough to be armed, not enough to be greedy. Rifle, plates, and a flash if it squeaks in.",
      "Lock plates and a rifle. Util's the first thing to cut when the money's only halfway there.",
      "You can swing a rifle and armor clean. Past that, count your cash twice before buying a damn thing.",
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
      "You're broke and losing. Good news, that's the formula for free money next round. Save it all.",
      "Holster everything. The streak's been printing loss bonus this whole time. Cash it next round, not now.",
      "Keep the cash. Forcing a pistol here just resets the bonus you've been bleeding for. Buy nothing.",
      "Lose this one on purpose. The bonus tops off and we're loaded next round. Don't touch a thing.",
      "Tuck the wallet away. Bonus is at the cap. One clean round of nothing and you've got a rifle next.",
      "Don't spend a dime. The losing's finally good for something, it maxed the bonus. Real buy next.",
      "Empty pockets, full bonus. That's the trade. Save this round and shop properly next one.",
      "Pistols stay put. The bonus is maxed, so this round's already lost, just don't make it expensive.",
      "You've lost enough to max the bonus. Don't throw it away forcing. Save five, buy five next.",
      "Money stays in the pocket. The streak's the only reason next round's a full buy. Don't fumble it.",
      "Save it all, even the pistol. The bonus is fat now, and forcing here just keeps you poor.",
      "Skip the buy. The losing run capped the bonus, so we cash in next round. Spend nothing here.",
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
      "Empty pockets. Pistol's all you got, so make peace with it. One pick if it's free, then bail.",
      "Don't you dare throw your body at a save. Cheap pistol, sneaky frag, walk away clean.",
      "Save means save, not trade your life for a kill you didn't even need. Pistol, pick, exit.",
      "This round's already lost on paper. Steal a pistol frag, keep your skin, buy real next time.",
      "You've got pocket lint and a pistol. Play it dirty, snag a frag, don't feed their full buy.",
      "Hold an off angle, tap one, disappear. That's the whole eco. Don't overcook it.",
      "Nothing in the bank, so nothing fancy. Pistol pick if it's handed to you, otherwise just live.",
      "Broke round, so play it like a coward. Cheap frag if it shows, then run like rent's due.",
      "Your wallet's a joke, don't make your death one too. Pistol, free pick, clean exit.",
      "No rifle's coming this round. Lurk an angle, poke one head, then quietly leave the party.",
      "Eco. Pistol up, brain on. Grab the gift kill if they hand it over, then exit before the trade.",
      "Don't go feeding their economy on a save. Pistol, off angle, one pick, then vanish.",
      "You can't shop, so don't pretend. Pistol only, snag a pick if it's lazy, get out alive.",
      "Save round, not a sacrifice. Tap one if it's free, then take your pistol home in one piece.",
      "Broke. So play scared and smart. Cheap kill if it falls in your lap, then run it out alive.",
      "This is a save, so save. Grab a cheap frag if it's there, but the exit's the real job.",
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
      "Tweener money. Force or save, your pick, but whatever you pick the other four pick it too.",
      "This is matching-money, not freestyle hour. One Deagle off on your own and you just gift-wrapped it.",
      "Buy menu's a trap right now. The team commits one way, you commit with them. No solo runs.",
      "Wallet says maybe. Maybe means everybody agrees first, then we go. Don't drift off and buy alone.",
      "Read the team's money before you read your own. Whatever the four do, you do, or shut your wallet.",
      "Half-rich, half-broke. Pick force, pick save, but for once all five say the same thing.",
      "Either we all dig deep or we all sit tight. The split-decision rounds are the ones we throw.",
      "Talk it out fast. Force as five hits, save as five resets, you alone does jack shit.",
      "Tough money round. The only wrong answer is five guys doing five different things.",
      "You're not rich enough to freelance this. Match the boys or you're just target practice.",
      "Awkward cash. Either dump it all together or keep it all together. No half-measures, period.",
      "Quit buying like you're the only one on this server. Check the team, then match the damn buy.",
    ]);
}
