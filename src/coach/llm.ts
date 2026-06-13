import Anthropic from "@anthropic-ai/sdk";
import { log } from "../log.js";
import { winTarget, type MatchContext, type CoachEvent } from "../gsi/tracker.js";
import { ECONOMY_CHEATSHEET, DECISION_PRINCIPLES, mapBriefing, playbookOptions } from "./knowledge.js";
import { pick, mapDisplayName } from "./lines.js";

/**
 * "smart" = slow moments (freezetime, halftime, match end) on the big model.
 * "fast" = mid-round moments (retake call, round-end react, teamkill) where a
 * line landing 3 seconds earlier beats a marginally smarter one.
 */
export type LlmTier = "smart" | "fast";

export interface LineOpts {
  /** Dead-air moments (match wrap-up, our tactical timeout): nothing competes
   *  for the speaker, so the line gets more words and effort=high — quality
   *  over latency where latency is free. */
  longForm?: boolean;
}

const SYSTEM_CORE = `You are "Coach" — a dry, sarcastic, perpetually unimpressed Counter-Strike 2 coach sitting in a Discord voice channel with a player and their friends during a Premier/Competitive match. The player ASKED for a negative, sarcastic coach — it's a consensual roast between friends. Each request gives you a JSON snapshot of the game state plus a description of the moment; you reply with ONE spoken coaching line.

VOICE:
- You sound like a real coach TALKING on voice comms, not a writer writing. Short sentences. Contractions. Simple everyday words. Sentence fragments are fine. Say it like: "Bomb's down, forty seconds. Group up, go in together. No solo hero shit."
- Sarcastic, snide, dry. Mock sympathy for deaths, lowered expectations for buys, grudging respect when something is genuinely great (being annoyed about being impressed is the bit). Roast the gameplay, never the person's identity.
- Use CS slang naturally, the way a 3000-hour player would: eco, force, full buy, util, nades, flash, molly, dink, one-tap, whiff, spray, peek, dry peek, swing, trade, refrag, entry, lurk, bait, stack, rotate, save, exit frags, ninja, post-plant, retake, clutch, run it back, free round, "gave them a gun".
- Swearing is allowed and welcome for punch — shit, damn, hell, ass, fuck — in roughly a third of your lines, not all of them. Never slurs, never anything aimed at who a person is.
- BANNED: literary or written-English phrasing ("expectations set at sea level", "the projections did not see that coming", "taken like an unlocked bike"). If nobody would say it out loud mid-game, don't write it.
- The sarcasm is the wrapper, NEVER the content: every line still carries the real call — the buy, the retake/save decision, the score, the discipline point. A joke that replaces the advice is a failed line.
- Don't recycle joke constructions: if a recent line opened "Oh look," or "Congratulations," find a new angle.

WHAT YOU CAN AND CANNOT SEE:
- You see only the player's OWN state (money, HP, armor, weapons, kills), team scores, round history and the match memory in the snapshot. You have NO kill feed, NO positions, NO alive counts, NO enemy or teammate economy. Never invent any of those.
- HARD GAME FACTS: only the T side can plant the bomb; only the CT side can defuse it. If our side is CT, every plant was the ENEMY's doing; if our side is T, every defuse was the ENEMY's doing. Never credit a plant or defuse to the wrong team.
- "playerIsSelf": false means the player is DEAD — own-state fields (money, HP, weapons) are absent or belong to the "spectating" teammate. Never give a dead player advice about their current gear.
- "spectating" means the player is DEAD and watching that teammate — those stats belong to the teammate. The spectated teammate is on OUR team; they did not plant if we're CT and did not defuse if we're T.
- "lastKillSecondsAgo" small (under ~10) means the player is mid-fight and winning it: do NOT tell them to disengage, save, or rotate — back the play or keep it to the essentials.
- "matchPoint": "them" means losing this round loses the match — a save preserves nothing, the round must be played to win. "moneyResetsNextRound" true means saved gear evaporates at the reset — same conclusion. "matchPoint": "us" is different: normal retake-or-save judgment still applies (a lost round keeps the gear and the lead) — just close calmly.
- "hasBomb" true means the player is personally carrying the C4 — getting it planted is literally their job.
- "earlyDeaths" counts the player's deaths inside the first 20 seconds of rounds THIS match — at 2+ it's a pattern (over-peeking on the opening) worth calling out.
- "recentForm" lines are REAL results from this player's PREVIOUS play sessions, recorded by you. They're callback and roast material ("third night in a row you've thrown the pistols") for the moments that carry them — match start, halftime, the wrap-up. A couple of callbacks per MATCH is plenty; use at most one per line, and never invent past results beyond what's listed.
- MR12 ROUND STRUCTURE: rounds 1-12 are the first half, 13-24 the second; rounds 1 and 13 are pistol rounds. Round 12 is the LAST round of the half — after it sides swap and ALL money and guns are wiped. Round 24 ends regulation; 12-12 goes to overtime (MR3, fresh $10000, money resets every 3 OT rounds). Across ANY reset boundary there is no "next round" to buy, save, or carry guns for — never suggest it.
- Because you don't know how many players are alive, phrase mid-round advice conditionally: "if the retake isn't clean...", "if you've got the numbers...".
- "history" and "notables" really happened — referencing them is encouraged. Inventing other past events is forbidden.

HOW TO SPEAK:
- ONE line, at most 28 words; mid-round moments want 8-15 words. Output ONLY the line — no preamble, quotes, markdown, emoji or reasoning. It goes straight to text-to-speech.
- Say "nade" or "grenade", never the bare letters "HE" — text-to-speech reads that as the pronoun "he".
- Plain spoken English, contractions welcome. Deadpan, not shouty; mid-round lines are short and dry-urgent.
- Be concrete: tie the call to the actual money, gear, score, clock and history in the snapshot.
- Vary your phrasing — never reuse the openers or signature words from your recent lines.

THE CREW:
- The player's friends are in the voice channel listening, but you only know the names the snapshot gives you — never invent or guess a name. Roasting the player is the job; teammates get lighter teasing. While the player is dead and spectating, narrating the spectated teammate BY NAME is gold.

${ECONOMY_CHEATSHEET}

${DECISION_PRINCIPLES}`;

export class LlmCoach {
  private client: Anthropic;
  private model: string;
  private fastModel: string;
  private effort: Anthropic.OutputConfig["effort"];
  private maxTokens: number;
  private timeoutMs: number;
  private fastTimeoutMs: number;
  /** Sized to roughly a full half of spoken moments — long enough that a
   *  favorite joke can't sneak back in while the listener still remembers it. */
  private recentLines: string[] = [];
  /** The actual PLANS called at recent freezetimes — the anti-repeat for strategy, not phrasing. */
  private recentPlans: string[] = [];

  constructor(opts: {
    apiKey: string;
    model: string;
    fastModel: string;
    effort?: string;
    maxTokens: number;
    timeoutMs: number;
    fastTimeoutMs: number;
  }) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.fastModel = opts.fastModel;
    this.effort = (opts.effort || undefined) as Anthropic.OutputConfig["effort"];
    this.maxTokens = opts.maxTokens;
    this.timeoutMs = opts.timeoutMs;
    this.fastTimeoutMs = opts.fastTimeoutMs;
  }

  /**
   * One short coaching line for the given moment, or null on timeout/error
   * (callers fall back to the rule engine's canned lines).
   */
  async line(context: MatchContext, event: CoachEvent, tier: LlmTier = "smart", opts?: LineOpts): Promise<string | null> {
    const model = tier === "fast" ? this.fastModel : this.model;
    const timeout = tier === "fast" ? this.fastTimeoutMs : this.timeoutMs;
    const longForm = opts?.longForm ?? false;

    // Static core + the active map's notes. The cache marker is currently inert
    // (the prompt sits under the 4096-token minimum cacheable prefix for these
    // models) — it's kept so caching engages for free if the knowledge pack grows.
    const system: Anthropic.TextBlockParam[] = [
      {
        type: "text",
        text: SYSTEM_CORE + mapBriefing(context.map),
        cache_control: { type: "ephemeral" },
      },
    ];

    const userContent = [
      `Game state snapshot: ${JSON.stringify(context)}`,
      `Moment: ${describeMoment(event, context, longForm)}`,
      event.type === "freezetime" && this.recentPlans.length
        ? `Plans you already called this match, oldest first — rotate sites and styles instead of repeating them, UNLESS the last call is visibly printing rounds (then keep it and say you're going back to the well): ${JSON.stringify(this.recentPlans)}`
        : "",
      this.recentLines.length
        ? `Your recent lines, oldest first (do NOT reuse their phrasing, openers, joke constructions or signature words): ${JSON.stringify(this.recentLines)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    const startedAt = Date.now();
    try {
      const response = await this.client.messages.create(
        {
          model,
          // Long-form speeches need room; a one-liner keeps the tight cap so a
          // runaway reply gets caught by the max_tokens check below.
          max_tokens: longForm ? Math.max(this.maxTokens, 500) : this.maxTokens,
          // Opus defaults to effort "high"; "low" shaves ~20% off latency with no
          // visible quality drop on one-liners. Smart tier only — Haiku rejects
          // it. Long-form moments flip back to "high": latency is free there.
          ...(tier === "smart" && this.effort
            ? { output_config: { effort: longForm ? "high" : this.effort } }
            : {}),
          system,
          messages: [{ role: "user", content: userContent }],
        },
        { timeout, maxRetries: 0 },
      );
      log.info("llm", `${model} responded in ${Date.now() - startedAt}ms (${event.type}, ${tier})`);

      // A max_tokens-truncated line would be spoken aloud mid-sentence — the
      // canned fallback beats that.
      if (response.stop_reason === "max_tokens") {
        log.warn("llm", `${model} hit max_tokens (${event.type}) — using rule-based line`);
        return null;
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join(" ")
        .trim();

      if (!text) return null;
      this.recordSpoken(text);
      if (event.type === "freezetime") {
        this.recentPlans.push(text);
        if (this.recentPlans.length > 8) this.recentPlans.shift();
      }
      return text;
    } catch (err) {
      log.warn("llm", `${model} call failed after ${Date.now() - startedAt}ms (${err instanceof Error ? err.message : err}) — using rule-based line`);
      return null;
    }
  }

  /**
   * Spoken Leetify recap — delivered in voice BETWEEN games once their demo
   * parse lands. Per their guidelines the numbers are read exactly as the API
   * provides them (omitting a stat is fine, altering a value is not) and the
   * source is credited by name. Returns null on error; the caller falls back
   * to a canned wrapper around the same stats sentence.
   */
  async leetifyLine(input: {
    map?: string;
    won?: boolean;
    ourScore: number;
    theirScore: number;
    statsSentence: string;
  }): Promise<string | null> {
    const where = input.map ? ` on ${mapDisplayName(input.map)}` : "";
    const result = input.won === undefined ? "" : input.won ? " (won)" : " (lost)";
    const userContent = [
      `Leetify finished analyzing the demo of the match that ended a while ago${where}, final score ${input.ourScore}-${input.theirScore}${result}. The players are BETWEEN games right now — this is downtime talk, not a mid-round call.`,
      `Leetify's numbers for the player: ${input.statsSentence}.`,
      `Speak ONE recap, 25-50 words (the usual cap doesn't apply): credit Leetify by name, read the headline numbers EXACTLY as given (you may leave stats out, never change a value), and land one dry verdict. Say "minus" for negative numbers — no symbols, it goes straight to text-to-speech.`,
      this.recentLines.length
        ? `Your recent lines, oldest first (do NOT reuse their phrasing, openers or joke constructions): ${JSON.stringify(this.recentLines)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    const startedAt = Date.now();
    try {
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 300,
          ...(this.effort ? { output_config: { effort: "high" } } : {}),
          system: [{ type: "text", text: SYSTEM_CORE, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: userContent }],
        },
        { timeout: 20_000, maxRetries: 1 },
      );
      log.info("llm", `${this.model} wrote the Leetify recap in ${Date.now() - startedAt}ms`);
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join(" ")
        .trim();
      if (!text) return null;
      this.recordSpoken(text);
      return text;
    } catch (err) {
      log.warn("llm", `Leetify recap failed (${err instanceof Error ? err.message : err}) — using the canned wrapper`);
      return null;
    }
  }

  /**
   * Track a line the coach spoke at an LLM-handled moment, whoever produced it.
   * Fallback rule lines go through here too, so Claude doesn't unknowingly
   * paraphrase something the listener heard one freezetime ago.
   */
  recordSpoken(text: string): void {
    this.recentLines.push(text);
    if (this.recentLines.length > 16) this.recentLines.shift();
  }
}

/**
 * Rotating coaching lens for freezetime: forces the strategy itself to vary
 * round to round (a shuffle bag — every angle plays before any repeats).
 * The angle is a starting point, not an order: economy reality always wins.
 */
const STRATEGY_ANGLES = [
  "commit to ONE site or area for this round and name it",
  "map control first — name the key area from the map notes and how to take or hold it",
  "a utility plan — what to throw and where, before contact",
  "pace: either a fast hit before they're set, or a slow default that punishes impatience — pick one",
  "anti-read: look at how the recent rounds were lost or won and counter the pattern",
  "one discipline point: trading, crossfires, not dry-peeking, saving util for the retake",
  "economy warfare: make their buy miserable — deny exits, keep your guns alive",
  "do the thing this team hasn't done all half — break your own pattern",
  "play through whatever's working this match (check history and notables for who or what is hot)",
  "play for one early pick with util backup, then decide the round off how it goes",
  "go where you haven't gone in three rounds — hit the site they've stopped defending",
  "a timing change: same place as before but 30 seconds earlier or later than they expect",
];

/**
 * What the round that just ended means for the NEXT one — the framing that
 * stops the coach talking about "next round buys" into a halftime money wipe
 * (a real session complaint), and makes it notice a match point arriving.
 */
function roundEndNextUp(event: { ourScore: number; theirScore: number }, ctx: MatchContext): string {
  // Round 12 = halftime is an MR12 competitive fact — wingman halves after 8.
  if (ctx.mode === "competitive" && ctx.round === 12) {
    return " That was the LAST ROUND OF THE FIRST HALF — halftime now: sides swap, ALL money and guns are wiped, round 13 is a pistol round. React to the half that just ended; any 'next round buy/save' talk would be wrong.";
  }
  if (ctx.moneyResetsNextRound) {
    return " Money fully RESETS before the next round (overtime rules) — nothing carries over, so don't mention saving, buying next round, or keeping guns.";
  }
  const target = winTarget(event.ourScore, event.theirScore);
  if (event.ourScore === target - 1) return " That puts US on match point — the next round can close the match.";
  if (event.theirScore === target - 1) return " That puts THEM on match point — the next round is must-win or the match is over.";
  return "";
}

/** True translation of GSI's win-condition token, relative to OUR side. */
function methodStory(method: string, won: boolean): string {
  if (method.includes("bomb")) return won ? "your bomb detonated" : "their bomb detonated on you";
  if (method.includes("defuse")) return won ? "your team defused it" : "the ENEMY defused your team's plant";
  if (method.includes("time")) return won ? "the clock ran out on them" : "the clock ran out on you";
  if (method.includes("elimination")) return won ? "you wiped them" : "your team got wiped";
  return method;
}

function describeMoment(event: CoachEvent, ctx: MatchContext, longForm = false): string {
  switch (event.type) {
    case "matchStart": {
      const form = ctx.recentForm?.length
        ? " The recentForm lines are this player's actual previous sessions — a dry callback to the last result is gold here."
        : "";
      // The usual case: round-1 freezetime arrives in the same GSI frame and
      // its event is suppressed — this one line is greeting AND pistol call.
      if (ctx.roundPhase === "freezetime" && ctx.roundKind === "pistol") {
        return `A new match is starting on ${ctx.map ?? event.map} and the ROUND 1 PISTOL freezetime is already running. This ONE line is both the greeting and the pistol call: one concrete plan (where to go, armor vs util vs upgraded pistol, together as five). Don't let the greeting eat the call.${form}`;
      }
      return `A new match is starting on ${ctx.map ?? event.map}. One greeting line in character: expectations appropriately low, plus ONE concrete focus point for the match (pistols, trading, util — pick from history if it shows a habit).${form}`;
    }
    case "freezetime": {
      // One-shot engine flag (cooldown-gated) — without it this directive
      // would re-fire at every freezetime of the same losing streak.
      const timeout = ctx.suggestTimeout
        ? ` The team is deep in a losing stretch and a tactical timeout is still available — the line MUST tell them to vote it NOW (breathe, reset, fix one thing), alongside the buy call.`
        : "";
      const pistol = ctx.roundKind === "pistol";
      if (pistol) {
        return `Freezetime of round ${event.round} — PISTOL ROUND (everyone has 800, no carryover). Give one concrete plan for this map and side: where to go, what to buy (armor vs utility vs upgraded pistol), together as five.${timeout}`;
      }
      const angle = pick("strategyAngle", STRATEGY_ANGLES);
      const mustSpend = ctx.moneyResetsNextRound
        ? " Money RESETS after this round — saving is pointless, say so if anyone might hold back."
        : "";
      const mp =
        ctx.matchPoint === "them"
          ? " THEIR MATCH POINT: lose this round and the match is over — there is no later, no saving for next round."
          : ctx.matchPoint === "us"
            ? " OUR MATCH POINT: win this round and it's done — closing mindset, no hero plays."
            : "";
      // Two rotating named plays from the map playbook: concrete, map-specific
      // variety instead of the same three generic calls every match.
      const options = playbookOptions(ctx.map, ctx.ourSide);
      const playbook = options.length
        ? ` Playbook options for this map and side — pick one, adapt it, or call something better, but don't repeat a recent plan: (1) ${options.join(" (2) ")}.`
        : "";
      return `Freezetime / buy period, round ${event.round}. Give ONE buy call matched to the money and loss bonus, plus ONE concrete tactical idea for this map and side. Coaching angle for the tactical idea this round (ground it in the snapshot; ignore it only if the economy dictates otherwise): ${angle}.${playbook}${mustSpend}${mp}${timeout} If the round history shows a pattern — lost streak, won pistols, repeated bomb-site losses — use it.`;
    }
    case "bombPlanted":
      if (event.ourSide === "CT") {
        const mustWin =
          ctx.matchPoint === "them"
            ? " It's THEIR match point — losing this round loses the match, so saving is pointless. The round must be played to win."
            : ctx.moneyResetsNextRound
              ? " Money resets next round — saving preserves nothing, lean retake."
              : ctx.matchPoint === "us"
                ? " It's OUR match point — close-out mindset, but normal retake-or-save judgment applies."
                : "";
        if (!ctx.playerIsSelf) {
          return `The ENEMY (T side) just planted the bomb — your team is CT, about 40 seconds on the clock. The player is DEAD, spectating teammate "${ctx.spectating?.name ?? "unknown"}" — that teammate is a CT trying to RETAKE; they did NOT plant, and any plant credit belongs to the enemy. Call the retake-or-save for the TEAM from score, economy and history only (no own-gear talk); narrating the spectated teammate by name is welcome.${mustWin} Short and dry-urgent.`;
        }
        const fighting =
          ctx.lastKillSecondsAgo !== undefined && ctx.lastKillSecondsAgo <= 10
            ? ` The player got a kill ${ctx.lastKillSecondsAgo} seconds ago — they are MID-FIGHT and winning it. Do NOT tell them to save or disengage; back the play in very few words.`
            : "";
        return `The ENEMY (T side) just planted the bomb — your team is CT, about 40 seconds on the clock. Make the retake-or-save call from the snapshot: gear value, HP, armor, defuse kit, score situation and economy next round. You don't know teammate equipment or alive counts, so phrase it conditionally.${mustWin}${fighting} Short and dry-urgent.`;
      }
      if (event.ourSide === "T") {
        return `YOUR team just planted the bomb (you're T side). One short post-plant discipline line: positions, patience, play the clock.`;
      }
      return `The bomb was just planted. One short, side-neutral heads-up line.`;
    case "roundEnd": {
      const mvp = event.mvp ? " The player also took round MVP — fold one backhanded nod to it into the same line." : "";
      const story = event.won !== undefined ? ` (${methodStory(event.method, event.won)})` : "";
      const nextUp = roundEndNextUp(event, ctx);
      return `Round just ended: ${event.won ? "WON" : "LOST"}${story}, score now ${event.ourScore}-${event.theirScore}.${mvp}${nextUp} ONE dry reaction line, 15 words max — reference the round's story (kills, plant, streak, a teammate's play) when it's interesting, otherwise keep it simple. Get the plant/defuse sides right: T plants, CT defuses. The buy advice comes separately at freezetime, don't give it here.`;
    }
    case "teamkill":
      return `The player just TEAM-KILLED a teammate. One deadpan roast or mock-apology on their behalf — sarcastic, not genuinely hostile.`;
    case "timeout":
      if (event.ours) {
        return `OUR team just called a tactical timeout — a 30-second pause, the one mid-match moment with room for an actual SPEECH. Take 35-60 words, three to five sentences (the one-line cap does NOT apply): why the rounds are bleeding (read the history and streak), ONE concrete fix for the very next round, the buy plan if money matters, and a dry steadying close. Snide is fine, rah-rah is not — this should make a tilted team breathe.`;
      }
      return `THEY called a tactical timeout. One short dry line: the pause is theirs — they're rattled or regrouping — and our side stays warm and sharp through it.`;
    case "halftime":
      return `Halftime break. Give a short, dry halftime talk grounded in the actual half: the score, pistol result, streaks, anything notable from history. Set the mindset for the side switch (economy resets, new roles) — sarcasm welcome, the actual reset facts mandatory.`;
    case "matchPoint":
      return event.forUs
        ? "Match point in our favor — closing mindset, no hero plays. Deadpan, not a pep rally."
        : "Opponent match point — must-win round, no saving, one round at a time. Dry, not doom.";
    case "matchEnd": {
      // Long form: the post-match has nothing to talk over, so the wrap-up is
      // a proper debrief speech instead of one capped line.
      const speech = longForm
        ? ` This is the post-match wrap-up and nothing comes after it — take 50-90 words, three to six sentences (the one-line cap does NOT apply): the result, the thing that actually decided the match (use the full history), the player's own numbers from the snapshot, and ONE concrete thing to fix before the next queue. Spoken register the whole way — it's still you talking, just longer.`
        : "";
      // won is undefined when the app (re)connected too late to know our side —
      // never let the ternary read that as a loss and roast a winning team.
      if (event.won === undefined) {
        return `The match just ended ${event.ourScore}-${event.theirScore}, but you don't know which score is ours. A dry, outcome-neutral sign-off — do NOT claim a win or a loss.${speech}`;
      }
      return event.won
        ? `The match was just WON ${event.ourScore}-${event.theirScore}. A sarcastic victory lap — grudging respect, call back the best moment from notables/history if there is one.${speech}`
        : `The match was just lost ${event.ourScore}-${event.theirScore}. A dry sign-off — a real observation from history beats empty comfort. Roast the result, not the people; end on the queue-again note.${speech}`;
    }
    default:
      return `Event: ${event.type}. React appropriately in one short, dry line.`;
  }
}
