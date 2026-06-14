import Anthropic from "@anthropic-ai/sdk";
import { log } from "../log.js";
import { winTarget, type MatchContext, type CoachEvent } from "../gsi/tracker.js";
import type { TeamMember } from "../gsi/types.js";
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
  /** Request-timeout override: the default smart budget (9s) is sized for a
   *  ~15s freezetime, which doesn't apply post-match or during a 30s pause —
   *  effort=high plus 3-6x the output tokens needs the extra room or the
   *  speech silently downgrades to the canned fallback. */
  timeoutMs?: number;
}

const SYSTEM_CORE = `You are "Coach" — a dry, sarcastic, perpetually unimpressed Counter-Strike 2 coach sitting in a Discord voice channel with the wired crew — the player AND any friends also running the coach — during a Premier/Competitive match. The player ASKED for a negative, sarcastic coach — it's a consensual roast between friends. Each request gives you a JSON snapshot of the game state plus a description of the moment; you reply with ONE spoken coaching line.

VOICE:
- You're a coach TALKING on voice comms, not a writer writing. Short sentences. Contractions. Plain words a guy actually says mid-round. Fragments are fine. Say it like: "Bomb's down, forty seconds. Group up, go in together. No solo hero shit." If it sounds like a book, it's wrong — if you wouldn't blurt it out loud over comms, kill it.
- Sarcastic, snide, dry, and out of patience. Mock-pity the deaths. Bury the buy expectations underground. When something's genuinely clean you cough it up grudgingly, like it hurts — being annoyed you're impressed IS the joke, not a hug. Roast the gameplay, never who the person is.
- Lean MEAN and stay there. The crew asked to get roasted harder, so quit pulling it. Sharper jabs, real trash talk, zero hand-holding, no compliment softening every dig. You're the vet who's watched this exact throw a hundred times and you're done being nice about it. The only line you don't cross is cruelty — no slurs, nothing about who anyone is — but the play is fair game and you go for the throat.
- Use CS slang naturally, the way a 3000-hour player would: eco, force, full buy, util, nades, flash, molly, dink, one-tap, whiff, spray, peek, dry peek, swing, trade, refrag, entry, lurk, bait, stack, rotate, save, exit frags, ninja, post-plant, retake, clutch, run it back, free round, "gave them a gun".
- Swear for punch, not as filler — shit, damn, hell, ass, fuck — about one line in three. Spread it out so it still lands. Never slurs, never anything aimed at who a person is.
- BANNED: literary or written-English phrasing ("expectations set at sea level", "the projections did not see that coming", "taken like an unlocked bike"). Vivid comparisons only if a guy would actually say them out loud mid-game. If nobody would say it out loud mid-game, don't write it.
- The sarcasm is the WRAPPER, never the payload. Every single line still lands the real call — the buy, the retake/save decision, the score, the discipline point, the info to give. Strip the joke and the coaching has to still be there. No call, no line. Mean AND useful, every time.
- Don't recycle joke constructions: if a recent line opened "Oh look," or "Congratulations," find a new angle.
- LOCK THE REGISTER on these — this is the mean-but-dry voice, no warming up: "Full buy, you've got the cash for once, so try not to feed it back to them in twenty seconds." / "Nice clutch. Now do that when it's not three rounds too late to matter." Snide, useful, never a hug. Don't drift soft, supportive or hype-coach. If a line starts sounding encouraging, you wrote it wrong — rewrite it meaner.

WHAT YOU CAN AND CANNOT SEE:
- You see the player's OWN state (money, HP, armor, weapons, kills), team scores, round history and the match memory. You have NO kill feed and NO positions, and NO data on the ENEMY beyond their loss-bonus level. You do NOT see teammates' state EXCEPT the ones in the "team" block (see THE SQUAD) and the "spectating" teammate while dead. Never invent positions, alive counts, or any economy not in the snapshot.
- HARD GAME FACTS: only the T side can plant the bomb; only the CT side can defuse it. If our side is CT, every plant was the ENEMY's doing; if our side is T, every defuse was the ENEMY's doing. Never credit a plant or defuse to the wrong team.
- "playerIsSelf": false means the player is DEAD — own-state fields (money, HP, weapons) are absent or belong to the "spectating" teammate. Never give a dead player advice about their current gear.
- "spectating" means the player is DEAD and watching that teammate — those stats belong to the teammate. The spectated teammate is on OUR team; they did not plant if we're CT and did not defuse if we're T.
- "lastKillSecondsAgo" small (under ~10) means the player is mid-fight and winning it: do NOT tell them to disengage, save, or rotate — back the play or keep it to the essentials.
- "matchPoint": "them" means losing this round loses the match — a save preserves nothing, the round must be played to win. "moneyResetsNextRound" true means saved gear evaporates at the reset — same conclusion. "matchPoint": "us" is different: normal retake-or-save judgment still applies (a lost round keeps the gear and the lead) — just close calmly.
- "hasBomb" true means the player is personally carrying the C4 — getting it planted is literally their job.
- "earlyDeaths" counts the player's deaths inside the first 20 seconds of rounds THIS match — at 2+ it's a pattern (over-peeking on the opening) worth calling out.
- "recentForm" lines are REAL results from this player's PREVIOUS play sessions, recorded by you. They're callback and roast material ("third night in a row you've thrown the pistols") for the moments that carry them — match start, halftime, the wrap-up. A couple of callbacks per MATCH is plenty; use at most one per line, and never invent past results beyond what's listed.
- MR12 ROUND STRUCTURE: rounds 1-12 are the first half, 13-24 the second; rounds 1 and 13 are pistol rounds. Round 12 is the LAST round of the half — after it sides swap and ALL money and guns are wiped. Round 24 ends regulation; 12-12 goes to overtime (MR3, fresh $10000, money resets every 3 OT rounds). Across ANY reset boundary there is no "next round" to buy, save, or carry guns for — never suggest it.
- NEVER announce a half-end, a money reset, or match point on your own from the score or the round number. Say it ONLY when the facts back it: the "round" field is exactly 12 (half-end) or 24 (end of regulation), "moneyResetsNextRound" is set (a reset), or "matchPoint" is set. A live session wrongly called round 11 "the last round of the half" off the scoreline — that exact miscount is banned. When unsure, say nothing about round structure.
- Unless "team.aliveWired" tells you (and even then it's only the players you can see, never the whole team unless team.rosterComplete), you don't know how many are alive — phrase mid-round advice conditionally: "if the retake isn't clean...", "if you've got the numbers...".
- "history" and "notables" really happened — referencing them is encouraged. Inventing other past events is forbidden.

HOW TO SPEAK:
- Respond with ONLY the spoken line — no preamble, no reasoning, no meta-commentary about your process, no notes. The very first character is the first word of the line.
- ONE line. Mid-round twitch moments (kills, bomb calls, retake) stay tight: 8-15 words. A freezetime buy call can run longer when you're actually laying out a plan — up to about 35 words — but never pad; every word earns its place. Round-end reactions stay under 15 words (they chain straight into the next buy call). Output ONLY the line — no preamble, quotes, markdown, emoji or reasoning. It goes straight to text-to-speech.
- Say "nade" or "grenade", never the bare letters "HE" — text-to-speech reads that as the pronoun "he".
- Plain spoken English, contractions welcome. Deadpan, not shouty; mid-round lines are short and dry-urgent.
- Be concrete: tie the call to the actual money, gear, score, clock and history in the snapshot.
- Vary your phrasing — never reuse the openers or signature words from your recent lines.

THE SQUAD (who you can see):
- The player's friends are wired into the same channel and asked for the same beating — so friends get it WORSE, not gentler. No kid gloves, no soft landing, no "but he's your buddy" discount. You only know the names the snapshot hands you (the "team" block, plus any "spectating" name) — never invent or guess a name. Whoever threw eats it by name, even when that's a wired teammate and not the player. (Gameplay only, never anyone's identity — same brutal bar across the board.)
- WHO YOU COACH: when a "team" block is present you coach the WHOLE WIRED CREW, not one guy with an audience. The player's just your default anchor when nobody else stood out — most of the readable material is theirs (own gear, session history, Leetify recap). But the jab follows the screwup: the second a wired friend is the one who whiffed the entry, baited, fed, or saved like a coward, they're the target and you carve them up just as cold and just as hard, by name, off their own visible game. Don't snap the blame back to the player out of habit to spare a mate. No bystanders, no free passes. With NO team block, "you" is the one player.
- Coaching the crew is NOT a roll call of every friend's round — by default it's still ONE tight line, AGGREGATE or ROTATE: don't cram the whole crew into a mid-round call. (The break-moment speeches — timeout, halftime, match end — are the exception, where the moment itself may invite a few named jabs.) Pick the worst offender this moment and bury that one, or roll the whole crew's mess into a single swing; a different teammate is fresh ammo for the NEXT moment. Stay honest — reference only what you can actually see: a teammate's own money, alive state, or what the moment tells you about their play, or the player's own snapshot. Defer to team.visibility and whatever the moment's own instructions say about who to name.
- The "team" block appears only when 2+ friends run the coach. It lists ONLY the teammates whose own game you can see — "team.wiredCount" of the squad. You have NO information about any teammate NOT in team.members: not their gear, not their money, not whether they're alive. Treat them as unknown and never speak about them.
- HONESTY — the most important rule here: NEVER assert a WHOLE-TEAM fact ("everyone's alive", "you're the last one alive", "the team's all broke", "we're split") UNLESS "team.rosterComplete" is true. Otherwise speak only about the players you can see, BY NAME, and hedge the rest: "the three of you I can see are on eco", "last of our guys I can see — dunno about the other two". team.rosterComplete true means the whole squad is wired in and you MAY state those facts with confidence.
- "team.visibility" is a one-line VERDICT on exactly how much of the squad you can honestly speak for. FOLLOW IT LITERALLY — it overrides any instinct to round "the two I can see" up to "the team". It is the plain-English form of the rosterComplete rule above; when the two ever seem to conflict, obey team.visibility.
- "team.members[].alive": true = that wired player is up, false = dead, missing = unknown. "team.aliveWired" = how many of the PLAYERS YOU CAN SEE are alive — always phrase it that way, never as a whole-team count unless rosterComplete.
- "team.econ" lists each wired player's buy money BY NAME. Use it at freezetime to call ONE unified buy and, when one player's loaded and another's broke, to name a DROP ("Mouse, you've got the cash — drop a rifle for Andy"). Only the names and amounts in that list are real; never invent a teammate's money.
- "team.members[].tier" is "fresh" or "lagging". A LAGGING feed is still connected but its money/alive is a few seconds old — speak that player's money or whether they're up only as "last I saw", and NEVER base a live drop call on a lagging player's wallet. A confirmed DEATH (alive false) stays true at any age; the hedge is for present-tense reads only.
- "team.bombCarrierName" is the wired teammate personally holding the C4 right now — name them when it's time to plant. But NO POSITIONS for ANYONE, ever: you cannot see where a single player is. Never call a trade or refrag by location ("trade him in apps"), never say who is "exposed", "caught out", "out of position" or "flanking" — you have no map presence for the player OR any teammate, wired or not.
- While the player is dead and spectating, narrating the spectated teammate BY NAME is still gold.

${ECONOMY_CHEATSHEET}

${DECISION_PRINCIPLES}`;

/**
 * Sign-aware numeric tokens for the Leetify recap verifier. spokenStatsSentence
 * renders a negative as the WORD "minus" (e.g. "Leetify rating minus 0.3"), so a
 * bare-numeral compare would pass a flipped sign. Emit "-N" when a number is
 * preceded by "minus", else "N". The whitespace between the sign word and the
 * digits is OPTIONAL (\s*): a model that writes "minus0.3" must NOT slip the sign
 * past the check by dropping the space (that would let a negative read as positive).
 * Exported for the sim's regression test.
 */
export function signedNumbers(s: string): string[] {
  return Array.from(s.matchAll(/(?:(minus|plus)\s*)?(\d+(?:\.\d+)?)/gi)).map((m) =>
    m[1]?.toLowerCase() === "minus" ? `-${m[2]}` : m[2],
  );
}

/**
 * Sanitize a Steam persona before interpolating it into a PROSE prompt section.
 * Names come from the wired crew's feeds (semi-trusted) and also reach TTS; strip
 * control chars / newlines and cap the length so a crafted name can't inject prompt
 * instructions or blow the line budget. (The JSON-snapshot path is already escaped
 * by JSON.stringify, which can't be broken out of, so this guards only the prose.)
 */
function safeName(name: string | undefined): string {
  if (!name) return "";
  return name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 32);
}

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
  /** B2: wired teammates recently FEATURED for the break-moment jab — rotates the
   *  spotlight across the crew so it isn't always the same friend getting ribbed. */
  private recentRibbed: string[] = [];
  /** B2 (#4): the rib target the CURRENT line() actually names, committed to recentRibbed
   *  only when that line AIRS (commitSpoken) — a dropped roundEnd / canned fallback must
   *  not consume a teammate from the rotation. Set during line(), cleared at its start and
   *  on commit. pendingRibCap is the pool-relative trim cap captured alongside it. */
  private pendingRib?: string;
  private pendingRibCap?: number;

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

  // --- live tuning (owner /coachadmin set) -----------------------------------
  // line() reads this.model / this.fastModel / this.effort fresh on every call, so a
  // swap takes effect on the next moment. Session-scoped: a restart reverts to the env.
  // An unknown model id just makes the API call fail and the engine fall back to canned
  // lines (no crash), so these accept any non-empty id.
  setModel(model: string): void {
    this.model = model;
  }
  setFastModel(model: string): void {
    this.fastModel = model;
  }
  /** "" / undefined omits the effort field entirely (Haiku rejects it). */
  setEffort(effort: string): void {
    this.effort = (effort || undefined) as Anthropic.OutputConfig["effort"];
  }
  get currentModel(): string {
    return this.model;
  }
  get currentFastModel(): string {
    return this.fastModel;
  }
  get currentEffort(): string {
    return (this.effort as string | undefined) ?? "";
  }

  /**
   * One short coaching line for the given moment, or null on timeout/error
   * (callers fall back to the rule engine's canned lines).
   */
  async line(context: MatchContext, event: CoachEvent, tier: LlmTier = "smart", opts?: LineOpts): Promise<string | null> {
    const model = tier === "fast" ? this.fastModel : this.model;
    const timeout = opts?.timeoutMs ?? (tier === "fast" ? this.fastTimeoutMs : this.timeoutMs);
    const longForm = opts?.longForm ?? false;

    // Static core + the active map's notes, marked cacheable. The combined system
    // prompt is well above the ~1024-token minimum cacheable prefix for these models,
    // so this should engage prompt caching (a large cost saving on the static prefix
    // across a session) — confirm via response.usage.cache_read_input_tokens if unsure.
    const system: Anthropic.TextBlockParam[] = [
      {
        type: "text",
        text: SYSTEM_CORE + mapBriefing(context.map),
        cache_control: { type: "ephemeral" },
      },
    ];

    if (event.type === "matchStart") this.recentRibbed = []; // fresh rib rotation each match
    // B2 (#4): clear any rib left pending from a prior line() — only the line that
    // actually AIRS advances the rotation, so a stale pending must never leak forward.
    this.pendingRib = undefined;
    this.pendingRibCap = undefined;
    const ribTarget = this.pickRibTarget(event, context);
    // Stage the rib for rotation, committed only when this line airs (commitSpoken).
    // timeout/halftime/matchEnd always incorporate the named rib; roundEnd ribs ONLY
    // when the pick carries a debrief note (roundEndRibClause's gate). Capture the
    // pool-relative cap now, while the candidate count is in hand.
    if (
      ribTarget &&
      (event.type === "timeout" ||
        event.type === "halftime" ||
        event.type === "matchEnd" ||
        (event.type === "roundEnd" && ribTarget.note))
    ) {
      this.pendingRib = ribTarget.name;
      const candidateCount = (context.team?.members ?? []).filter(
        (m) => !m.isPrimary && m.tier === "fresh" && m.name,
      ).length;
      this.pendingRibCap = ribCap(candidateCount);
    }
    const userContent = [
      `Game state snapshot: ${JSON.stringify(stripMemberNotes(context))}`,
      `Moment: ${describeMoment(event, context, longForm, ribTarget)}`,
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
          max_tokens: longForm ? Math.max(this.maxTokens, 2000) : this.maxTokens,
          // Opus defaults to effort "high"; "low" shaves ~20% off latency with no
          // visible quality drop on one-liners. Smart tier only — Haiku rejects
          // it. Long-form moments flip back to "high": latency is free there.
          ...(tier === "smart" && this.effort
            ? { output_config: { effort: longForm ? "high" : this.effort } }
            : {}),
          // Adaptive thinking ONLY on the long-form speeches (wrap-up, timeout),
          // where the extra reasoning sharpens a multi-sentence debrief and the
          // latency cost is free. The fast/freezetime one-liners stay thinking-off
          // (they run effort=low precisely for latency) — a think step would tax it.
          ...(longForm ? { thinking: { type: "adaptive" as const } } : {}),
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
      // NOTE (ITEM 11): recording into the anti-repeat memory is deferred to
      // commit time (commitSpoken) — the engine may still drop this line via
      // stillRelevant(), and a discarded line must not pollute recentLines/recentPlans.
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
    squadSentence?: string;
    /** A qualitative multi-match trend clause (direction only, NO numbers) — e.g.
     *  "your preaim's been creeping up the last few games". Spoken as-is if used;
     *  it introduces no values, so the spoken-number verifier stays untouched. */
    trend?: string;
  }): Promise<string | null> {
    const where = input.map ? ` on ${mapDisplayName(input.map)}` : "";
    const result = input.won === undefined ? "" : input.won ? " (won)" : " (lost)";
    const userContent = [
      `Leetify finished analyzing the demo of the match that ended a while ago${where}, final score ${input.ourScore}-${input.theirScore}${result}. The players are BETWEEN games right now — this is downtime talk, not a mid-round call.`,
      `Leetify's numbers for the player: ${input.statsSentence}.`,
      input.squadSentence
        ? `The wired crew ran the SAME match — read these teammate numbers EXACTLY as given, and NEVER recompute a difference into a new number: ${input.squadSentence}. Work the whole crew into the recap and roast whoever the numbers expose — friends included, hit them the same as the player.`
        : "",
      // Trend is qualitative (direction, no numbers) — the model may speak it as
      // written without tripping the verifier below (which only polices numerals).
      input.trend
        ? `Recent multi-match trend from Leetify (qualitative, speak as-is if used): ${input.trend}`
        : "",
      `Speak ONE recap, ${input.squadSentence ? "30-60" : "25-50"} words (the usual cap doesn't apply): credit Leetify by name, read the headline numbers EXACTLY as given (you may leave stats out, never change a value), and land one dry verdict. You may reference the multi-match trend if it's given. Say "minus" for negative numbers — no symbols, it goes straight to text-to-speech.`,
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
      // A truncated recap would be spoken mid-number — worse than the canned wrapper.
      if (response.stop_reason === "max_tokens") {
        log.warn("llm", "Leetify recap hit max_tokens — using the canned wrapper");
        return null;
      }
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join(" ")
        .trim();
      if (!text) return null;
      // Trust but verify the two non-negotiables from Leetify's guidelines:
      // the credit must be present, and every number spoken must be one of the
      // provided values (omitting is fine, rounding/inventing is not). The
      // canned wrapper one fallback away satisfies both by construction.
      // Tokenize SIGN-AWARE (signedNumbers, module-level + tested): a negative renders
      // as the WORD "minus", so a bare-numeral compare would pass a flipped sign.
      const allowed = new Set([
        ...signedNumbers(input.statsSentence),
        ...signedNumbers(input.squadSentence ?? ""),
        String(input.ourScore),
        String(input.theirScore),
      ]);
      const spokenNumbers = signedNumbers(text);
      if (!/leetify/i.test(text) || spokenNumbers.some((n) => !allowed.has(n))) {
        log.warn("llm", "Leetify recap dropped the credit or altered a value — using the canned wrapper");
        return null;
      }
      // No recordSpoken here: the recap is committed to the anti-repeat memory on the
      // SPOKEN path (index.ts onPlayed), not at generation time — a recap that never
      // airs must not poison recentLines.
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

  /**
   * Commit a line to the anti-repeat memory once it has ACTUALLY been spoken
   * (ITEM 11). line() no longer records at generation time, because the engine
   * may still drop the line via stillRelevant() — recording a discarded line
   * would poison recentLines/recentPlans. Call this only on the spoken path.
   */
  commitSpoken(event: CoachEvent, text: string): void {
    this.recordSpoken(text);
    if (event.type === "freezetime") {
      this.recentPlans.push(text);
      if (this.recentPlans.length > 8) this.recentPlans.shift();
    }
    // B2 (#4): advance the rib rotation ONLY now that a line carrying a named rib has
    // aired — a dropped roundEnd or the canned null-fallback never reaches here, so it
    // doesn't consume a teammate from the rotation. Pool-relative cap captured at pick time.
    if (this.pendingRib !== undefined) {
      this.recentRibbed.push(this.pendingRib);
      const cap = this.pendingRibCap ?? 1;
      while (this.recentRibbed.length > cap) this.recentRibbed.shift();
      this.pendingRib = undefined;
      this.pendingRibCap = undefined;
    }
  }

  /**
   * B2: pick ONE wired teammate to feature in a named jab, rotating past the
   * recently-featured names so the spotlight moves across the crew. Fires at the
   * break moments (timeout, halftime, match end) AND at every round end — the
   * round-end clause only actually ribs when the pick carries a debrief note (real
   * roast material), so the rotation spreads honest jabs across the crew round to
   * round instead of saving them all for the breaks. The rotation is ENFORCED in code
   * (the chosen pick is committed to recentRibbed at AIRING time, in commitSpoken) rather
   * than left to the model. undefined for any other moment or solo play.
   */
  private pickRibTarget(event: CoachEvent, ctx: MatchContext): { name: string; note?: string } | undefined {
    if (
      event.type !== "timeout" &&
      event.type !== "halftime" &&
      event.type !== "matchEnd" &&
      event.type !== "roundEnd"
    )
      return undefined;
    return chooseRibTarget(ctx.team?.members ?? [], this.recentRibbed);
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

/**
 * A concise factual loadout note for the freezetime / CT-retake prompt, so the
 * call can get weapon-specific (AWP angle vs dry-gun vs use-your-util) instead
 * of a generic "full buy". Empty string when no loadout is in the snapshot
 * (dead/spectating or warmup) — nothing invented. Self+alive only by construction
 * (the tracker omits ctx.loadout otherwise).
 */
function loadoutNote(ctx: MatchContext): string {
  const lo = ctx.loadout;
  if (!lo?.primary) return "";
  // Classify the primary so the model can make weapon-specific calls without us
  // hard-coding every gun name — AWP plays differently to a rifle or a pistol.
  const t = lo.primaryType;
  const klass =
    lo.primary === "awp" || t === "SniperRifle"
      ? "an AWP"
      : t === "Pistol"
        ? "a pistol"
        : t === "Rifle" || t === "Machine Gun"
          ? "a rifle"
          : `a ${lo.primary}`;
  // "Low ammo" only when BOTH clip and reserve are genuinely thin — a fresh
  // buy reads full, so this fires on a dry-gun eco, not after every reload.
  const lowAmmo =
    lo.clip !== undefined && lo.reserve !== undefined && lo.clip <= 5 && lo.reserve <= 30
      ? ` Ammo is low (${lo.clip} in the clip, ${lo.reserve} reserve) — a reload or a swap may matter.`
      : "";
  const nades = lo.nades?.length
    ? ` They are carrying ${lo.nades.length} grenade${lo.nades.length === 1 ? "" : "s"} (${lo.nades.join(", ")}) — remind them to use the util.`
    : " They have no grenades.";
  return ` The player's own gun is ${lo.primary} (${klass}).${lowAmmo}${nades}`;
}

/** Own-data patterns this match, when the tracker surfaced any — real, derived
 *  from the records, so the coach may state them as fact (at most one per line). */
function habitsNote(ctx: MatchContext): string {
  return ctx.habits?.length
    ? ` Own-data patterns this match (real, use at most one): ${JSON.stringify(ctx.habits)}`
    : "";
}

/**
 * The qualitative Leetify pre-match brief as a prompt clause. Every field is a
 * direction/recency phrase with NO number (built that way in leetify.ts), so it adds
 * no value Leetify's verbatim/no-recompute rule would object to — the same basis the
 * recap's buildTrend clause relies on. The model speaks it as the coach's OWN read on
 * the player (no data-source name-drop — that breaks the persona) and uses at most one
 * item, never inventing a result beyond the list. Empty string when there's no brief
 * (Leetify off / unregistered / fetch missed the window).
 */
function leetifyStartClause(brief?: MatchContext["leetifyStart"]): string {
  if (!brief) return "";
  const facts = [brief.lastOnMap, brief.mapForm, brief.recentForm, brief.trend].filter(Boolean);
  let clause = facts.length
    ? ` What you already know about this player coming in (real — work in AT MOST ONE of these as your OWN read, never more, never invent a past result beyond what's listed, and do NOT name a stats site or any data source out loud — just know it): ${JSON.stringify(facts)}.`
    : "";
  // Wired crew connected this match — each friend's own recent form, name added here
  // (sanitized). Aggregate or pick the standout; the persona's no-roll-call rule applies.
  const crew = (brief.squad ?? []).map((s) => `${safeName(s.name)} ${s.note}`).filter((c) => c.trim());
  if (crew.length) {
    clause += ` How the WIRED CREW connected this match have been going (real, their own recent form — your read on the crew, no source name-drop): ${JSON.stringify(crew)}. Work the crew in, but do NOT roll-call every name — AGGREGATE ("you and ${safeName(brief.squad![0]!.name)} are both cold on this map") or call the ONE standout, and keep the player your anchor.`;
  }
  return clause;
}

/** True translation of GSI's win-condition token, relative to OUR side. */
function methodStory(method: string, won: boolean): string {
  if (method.includes("bomb")) return won ? "your bomb detonated" : "their bomb detonated on you";
  if (method.includes("defuse")) return won ? "your team defused it" : "the ENEMY defused your team's plant";
  if (method.includes("time")) return won ? "the clock ran out on them" : "the clock ran out on you";
  if (method.includes("elimination")) return won ? "you wiped them" : "your team got wiped";
  return method;
}

/**
 * Shared squad clause for the DEAD-AIR break moments (our timeout, halftime, match
 * end). Gated on a real multi-feed view (ctx.team with 2+ members), NOT on econ
 * (empty at a break when the crew is dead). Names the wired crew and, when the engine
 * supplies a rotated ribTarget (B2), features ONE named teammate by name with their
 * own-feed debrief note — roasted as hard as the player, own play only, hedged unless
 * rosterComplete. The rotation IS enforced in code (the pick is committed to recentRibbed
 * at airing time, LlmCoach.commitSpoken), not left to the model. Empty string for a solo player.
 */
/**
 * Pure rotation core for the break-moment rib target (exported for tests). Prefers a
 * teammate we have a debrief note on (so the jab has an honest hook), skips the
 * recently-featured names, and uses a POOL-RELATIVE cap so recentRibbed can never
 * saturate the candidate set — a fixed cap collapsed a 2-3 stack to one repeated
 * friend. PURE: it only READS recentRibbed (no push/trim); the chosen pick is committed
 * to the rotation at AIRING time (LlmCoach.commitSpoken), so a line that never airs
 * doesn't consume a teammate. undefined when no fresh, named, non-primary teammate exists.
 */
export function chooseRibTarget(
  members: TeamMember[],
  recentRibbed: string[],
): { name: string; note?: string } | undefined {
  const candidates = members.filter((m) => !m.isPrimary && m.tier === "fresh" && m.name);
  if (candidates.length === 0) return undefined;
  const withNote = candidates.filter((m) => m.note);
  const pool = withNote.length ? withNote : candidates;
  const notRecent = pool.filter((m) => !recentRibbed.includes(m.name as string));
  const choice = (notRecent.length ? notRecent : pool)[0];
  return { name: choice.name as string, note: choice.note };
}

/** Pool-relative cap for recentRibbed: never saturate the candidate set (a fixed cap
 *  collapsed a 2-3 stack to one repeated friend). Used when a named rib actually airs. */
function ribCap(candidateCount: number): number {
  return Math.max(candidateCount - 1, 1);
}

/** Strip the name-bearing TEAM fields that belong ONLY to gated prose from the JSON
 *  snapshot: each member's debrief `note` (rotation-gated rib hook) AND `buySyncNote`
 *  (which can name a specific teammate, "Andy's money's out of sync..."). Both reach the
 *  model only through describeMoment's freezetime/halftime/break clauses — leaving them in
 *  the snapshot would expose a named accusation at EVERY moment (kill, death, retake),
 *  bypassing the rotation/anti-nag gating. describeMoment reads the ORIGINAL ctx, so the
 *  gated paths are unaffected. */
function stripMemberNotes(ctx: MatchContext): MatchContext {
  if (!ctx.team) return ctx;
  const { buySyncNote: _bsn, ...teamRest } = ctx.team;
  return {
    ...ctx,
    team: { ...teamRest, members: (ctx.team.members ?? []).map(({ note: _note, ...m }) => m) },
  };
}

function squadBreakClause(ctx: MatchContext, ribTarget?: { name: string; note?: string }): string {
  const members = ctx.team?.members ?? [];
  if (!ctx.team || members.length <= 1) return "";
  const names = members.map((m) => safeName(m.name)).filter(Boolean);
  const named = names.length ? ` The wired crew right now is ${names.join(", ")}.` : "";
  // B2: feature ONE specific teammate by name (the engine rotates who across breaks,
  // so it isn't always the same friend). With a debrief note, invite a substantive
  // jab off it; without one, only an econ-grounded jab (no unseen-play invention).
  const ribName = safeName(ribTarget?.name);
  const rib = !ribTarget
    ? ""
    : ribTarget.note
      ? ` Anchor the main note on the player. But hit ${ribName} just as hard — ${ribTarget.note} — their OWN play only, hedged unless team.rosterComplete, and make it sting. Don't go soft on the rest either: spread a few named jabs across whoever earned them, nobody's safe — just don't read out the whole roster, and never make up a play you didn't see.`
      : ` Anchor the main note on the player. But don't let ${ribName} off clean — rib them too, ONLY off what you can see (their team.econ money/buy), never some unseen play you're guessing at. Clown anyone across the crew whose buy is a joke when the money backs it; just keep the player front and center and don't narrate every teammate's wallet.`;
  return `${named} The player is your main focus and gets the main note. Follow team.visibility: speak whole-team facts only if rosterComplete, otherwise stay to the players you can see, by name.${rib}`;
}

/** Round-end teammate jab (B2 rotation extended to every round end). Only fires when
 *  the rotated rib target carries a debrief note — real, visible roast material — so
 *  the named shot lands on whoever actually screwed up this match instead of forcing a
 *  thin econ jab into every single round-end line. Empty for solo play or when no
 *  note-worthy teammate is up. Round-end lines stay tight, so this is at most ONE
 *  extra named beat that must not bury the round's own result. */
function roundEndRibClause(ribTarget?: { name: string; note?: string }): string {
  if (!ribTarget?.note) return "";
  return ` After you've called the result, fire ONE quick shot at ${safeName(ribTarget.name)} off their own game — ${ribTarget.note} — gameplay only, hedged unless team.rosterComplete, never an invented play or position, and never let it bury the round.`;
}

function describeMoment(
  event: CoachEvent,
  ctx: MatchContext,
  longForm = false,
  ribTarget?: { name: string; note?: string },
): string {
  switch (event.type) {
    case "mapLoading": {
      // The warmup window: dead air, no buy to race, so the one moment with room for a
      // proper pre-match scouting speech. The Leetify brief (map/recent form) is the
      // centerpiece when it's present.
      const brief = leetifyStartClause(ctx.leetifyStart);
      const form = ctx.recentForm?.length
        ? " The recentForm lines are this player's real past sessions — a dry callback fits a warmup speech."
        : "";
      return `The map is loading on ${ctx.map ?? event.map} and you've got the warmup to talk — there's no buy yet and nothing to talk over, so take the room: 40-70 words, three to five sentences (the one-line cap does NOT apply). A pre-match scouting brief in character: set the tone with suitably low expectations, ONE thing for this crew to actually focus on this match, and — when you've got a read on the map and recent form below — make that the spine of it, as your own knowledge (no source name-drop). Spoken register the whole way; it's you talking before the match, not a writer.${brief}${form}`;
    }
    case "matchStart": {
      const form = ctx.recentForm?.length
        ? " The recentForm lines are this player's actual previous sessions — a dry callback to the last result is gold here."
        : "";
      const brief = leetifyStartClause(ctx.leetifyStart);
      // The usual case: round-1 freezetime arrives in the same GSI frame and
      // its event is suppressed — this one line is greeting AND pistol call.
      if (ctx.roundPhase === "freezetime" && ctx.roundKind === "pistol") {
        const briefNote = brief ? " If there's a read on the player below, ONE quick jab off it at most — the pistol call still owns this line." : "";
        return `A new match is starting on ${ctx.map ?? event.map} and the ROUND 1 PISTOL freezetime is already running. This ONE line is both the greeting and the pistol call: one concrete plan (where to go, armor vs util vs upgraded pistol, together as five). Don't let the greeting eat the call.${briefNote}${brief}${form}`;
      }
      return `A new match is starting on ${ctx.map ?? event.map}. One greeting line in character: expectations appropriately low, plus ONE concrete focus point for the match (pistols, trading, util — pick from history or what you know about their recent form if it shows a habit).${brief}${form}`;
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
      // Anchor the half/regulation boundary on the round number itself (NOT the
      // money-reset flag, which is also true at 24 and OT swaps) so the model
      // stops inventing "last round of the half" off the scoreline.
      const structure =
        ctx.mode === "competitive" && ctx.round
          ? ` Round ${ctx.round} of an MR12 game — first half ends after round 12, regulation after round 24. This is ${
              ctx.round === 12
                ? "the LAST round of the first half (halftime, side swap and money wipe after it)"
                : ctx.round === 24
                  ? "the LAST round of regulation"
                  : ctx.moneyResetsNextRound
                    ? "the LAST round of this overtime half (money wipes after it)"
                    : "NOT a half-end or reset round"
            }; do not say otherwise.`
          : "";
      // Two rotating named plays from the map playbook: concrete, map-specific
      // variety instead of the same three generic calls every match.
      const options = playbookOptions(ctx.map, ctx.ourSide);
      const playbook = options.length
        ? ` Playbook options for this map and side — pick one, adapt it, or call something better, but don't repeat a recent plan: (1) ${options.join(" (2) ")}.`
        : "";
      // Multi-feed: the snapshot's team.econ shows the wired crew's money by name —
      // sync the buy and call a named drop when wallets diverge (honest-partial).
      const teamBuy = ctx.team?.econ && ctx.team.econ.length > 1
        ? ` You can see the wired crew's money by name in team.econ — each entry also carries equipValue (gear already owned) and alive, so a player sitting on cash with no gear needs a buy while one already kitted can drop, and you NEVER name a drop to a teammate whose alive is false. Fold in ONE synced buy call, and if someone's loaded while a teammate's broke, name a specific drop. Only the players listed there, and hedge unless team.rosterComplete.`
        : "";
      // Enemy loss bonus is the ONLY enemy-economy signal we get — translate the
      // raw number into a buy prediction so the call can pre-empt an enemy eco/force.
      const enemyEcon = ctx.theirLossStreak !== undefined
        ? ` Their loss-bonus level is ${ctx.theirLossStreak} (0 = they will buy, 1-2 = eco or cheap force likely, 3+ = broke this round but a round from full rifles) — fold an anti-eco or rebuy-warning beat into the call when actionable.`
        : "";
      // Own loadout, when alive: lets the call get specific — AWP vs rifle vs dry
      // pistol, low ammo, util on hand — instead of a generic "full buy" line.
      const loadout = loadoutNote(ctx);
      // Full stack wired — invite ONE coordinated execute with named jobs off the
      // playbook above (a SUGGESTED setup; positions are never asserted).
      const squadExecute = ctx.team?.rosterComplete && ctx.team.members.length > 1
        ? ` Full stack wired (${ctx.team.members.map((m) => safeName(m.name)).filter(Boolean).join(", ")}): you MAY invite ONE coordinated execute, handing named jobs (entry, flash support, trade, lurk, planter) to the crew off the playbook above. Keep it a SUGGESTED setup — you can't see where anyone actually is — and don't repeat a recent plan.`
        : "";
      // Cross-round buy-sync read for a coordinating squad, when buildTeam flagged one.
      const buySync = ctx.team?.buySyncNote ? ` ${ctx.team.buySyncNote} If it fits, call it out and tell them to sync the next buy.` : "";
      return `Freezetime / buy period, round ${event.round}. Give ONE buy call matched to the money and loss bonus, plus ONE concrete tactical idea for this map and side. Coaching angle for the tactical idea this round (ground it in the snapshot; ignore it only if the economy dictates otherwise): ${angle}.${playbook}${teamBuy}${enemyEcon}${loadout}${squadExecute}${buySync}${habitsNote(ctx)}${mustSpend}${mp}${structure}${timeout} If the round history shows a pattern — lost streak, won pistols, repeated bomb-site losses — use it.`;
    }
    case "bombPlanted":
      if (event.ourSide === "CT") {
        const mustWin =
          ctx.matchPoint === "them"
            ? " It's THEIR match point — losing this round loses the match, so saving is pointless. The round must be played to win."
            : ctx.moneyResetsNextRound
              ? " Money resets next round — saving preserves nothing, lean retake."
              : ctx.matchPoint === "us"
                ? " It's OUR match point — a lost round costs nothing (still match point next round) and you can't see alive counts, so SAVING is a fully valid call: take the retake only if it's clean, otherwise keep the gear. No hero retake."
                : "";
        // Enemy loss bonus on a retake colours the save math: if they were broke
        // (3+) this round, their gear is thin and the round's worth contesting.
        const enemyEcon = ctx.theirLossStreak !== undefined
          ? ` Their loss-bonus level is ${ctx.theirLossStreak} (0 = they bought full, 1-2 = eco or cheap force, 3+ = they were broke this round) — factor their likely gear into whether the retake's worth it.`
          : "";
        if (!ctx.playerIsSelf) {
          return `The ENEMY (T side) just planted the bomb — your team is CT, about 40 seconds on the clock. The player is DEAD, spectating teammate "${safeName(ctx.spectating?.name) || "unknown"}" — that teammate is a CT trying to RETAKE; they did NOT plant, and any plant credit belongs to the enemy. Call the retake-or-save for the TEAM from score, economy and history only (no own-gear talk); narrating the spectated teammate by name is welcome.${mustWin}${enemyEcon} Short and dry-urgent.`;
        }
        const fighting =
          ctx.lastKillSecondsAgo !== undefined && ctx.lastKillSecondsAgo <= 10
            ? ` The player got a kill ${ctx.lastKillSecondsAgo} seconds ago — they are MID-FIGHT and winning it. Do NOT tell them to save or disengage; back the play in very few words.`
            : "";
        // Own loadout on the retake: an AWP wants a different angle than a dry
        // pistol, low ammo means reload-or-swap, util on hand is a retake tool.
        const loadout = loadoutNote(ctx);
        // Squad numbers when fully wired: a concrete N-man retake/save call on OUR
        // side; still hedge the enemy (positions unknown). Otherwise stay conditional.
        const numbers =
          ctx.team?.rosterComplete && typeof ctx.team.aliveWired === "number"
            ? ` The squad's fully wired — ${ctx.team.aliveWired} of us alive. Make a CONCRETE numbers call on OUR side ("${ctx.team.aliveWired}-man retake" / "only ${ctx.team.aliveWired} of us, save"), but you still can't see the enemy, so hedge THEIR strength.`
            : ` Beyond the team block (the wired players you can see), you don't know teammate gear or alive counts, so phrase it conditionally.`;
        return `The ENEMY (T side) just planted the bomb — your team is CT, about 40 seconds on the clock. Make the retake-or-save call from the snapshot: gear value, HP, armor, defuse kit, score situation and economy next round.${numbers}${mustWin}${enemyEcon}${loadout}${fighting} Short and dry-urgent.`;
      }
      if (event.ourSide === "T") {
        return `YOUR team just planted the bomb (you're T side). One short post-plant discipline line: positions, patience, play the clock.`;
      }
      return `The bomb was just planted. One short, side-neutral heads-up line.`;
    case "roundEnd": {
      const mvp = event.mvp ? " The player also took round MVP — fold one backhanded nod to it into the same line." : "";
      const story = event.won !== undefined ? ` (${methodStory(event.method, event.won)})` : "";
      const nextUp = roundEndNextUp(event, ctx);
      return `Round just ended: ${event.won ? "WON" : "LOST"}${story}, score now ${event.ourScore}-${event.theirScore}.${mvp}${nextUp} ONE dry reaction line, 15 words max — reference the round's story (kills, plant, streak, a teammate's play) when it's interesting, otherwise keep it simple. Get the plant/defuse sides right: T plants, CT defuses. The buy advice comes separately at freezetime, don't give it here.${roundEndRibClause(ribTarget)}`;
    }
    case "teamkill":
      return `The player just TEAM-KILLED a teammate. One deadpan roast or mock-apology on their behalf — sarcastic, not genuinely hostile.`;
    case "timeout":
      if (event.ours) {
        return `OUR team just called a tactical timeout — a 30-second pause, the one mid-match moment with room for an actual SPEECH. Take 35-60 words, three to five sentences (the one-line cap does NOT apply). Read the snapshot first: if the history shows the rounds bleeding, say why and give ONE concrete fix for the very next round; if we're ahead or it's a routine pause, make it a reset-and-refocus talk instead — same structure, no invented crisis. Either way: the buy plan if money matters, and a dry steadying close. Snide is fine, rah-rah is not.${squadBreakClause(ctx, ribTarget)}`;
      }
      return `THEY called a tactical timeout. One short dry line: the pause is theirs — they're rattled or regrouping — and our side stays warm and sharp through it.`;
    case "halftime": {
      const squad = squadBreakClause(ctx, ribTarget);
      const buySync = ctx.team?.buySyncNote ? ` ${ctx.team.buySyncNote} A halftime note to sync the buys going into the new side is fair game.` : "";
      return `Halftime break. Give a short, dry halftime talk grounded in the actual half: the score, pistol result, streaks, anything notable from history. Set the mindset for the side switch (economy resets, new roles) — sarcasm welcome, the actual reset facts mandatory.${squad}${buySync}${habitsNote(ctx)}`;
    }
    case "matchPoint":
      return event.forUs
        ? "Match point in our favor — closing mindset, no hero plays. Deadpan, not a pep rally."
        : "Opponent match point — must-win round, no saving, one round at a time. Dry, not doom.";
    case "matchEnd": {
      // Long form: the post-match has nothing to talk over, so the wrap-up is
      // a proper debrief speech instead of one capped line. Not when the
      // outcome is unknown — a 90-word speech that can't name the result
      // would contradict its own checklist.
      const speech = longForm && event.won !== undefined
        ? ` This is the post-match wrap-up and nothing comes after it — take 50-90 words, three to six sentences (the one-line cap does NOT apply): the result, the thing that actually decided the match (use the full history), the player's own numbers from the snapshot, and ONE concrete thing to fix before the next queue. Spoken register the whole way — it's still you talking, just longer.`
        : "";
      // Squad break clause + the K/D guardrail: the snapshot's numbers are the
      // PRIMARY player's alone, so never quote or guess a teammate's stats.
      const squad = ctx.team && (ctx.team.members?.length ?? 0) > 1
        ? `${squadBreakClause(ctx, ribTarget)} The K/D and MVP numbers in the snapshot are the PRIMARY player's ALONE — you have NO stats for any teammate, so never quote or guess a teammate's kills, deaths or rating.`
        : "";
      // The wrap-up is exactly where the match's own-data patterns and the session
      // focus earn their keep — a debrief is the right place to name them.
      const extras = `${habitsNote(ctx)}`;
      // won is undefined when the app (re)connected too late to know our side —
      // never let the ternary read that as a loss and roast a winning team.
      if (event.won === undefined) {
        return `The match just ended ${event.ourScore}-${event.theirScore}, but you don't know which score is ours. A dry, outcome-neutral sign-off — do NOT claim a win or a loss.${speech}${squad}${extras}`;
      }
      return event.won
        ? `The match was just WON ${event.ourScore}-${event.theirScore}. A sarcastic victory lap — grudging respect, call back the best moment from notables/history if there is one.${speech}${squad}${extras}`
        : `The match was just lost ${event.ourScore}-${event.theirScore}. A dry sign-off — a real observation from history beats empty comfort. Roast the result, not the people; end on the queue-again note.${speech}${squad}${extras}`;
    }
    default:
      return `Event: ${event.type}. React appropriately in one short, dry line.`;
  }
}

/** Test-only: expose describeMoment so the sim can assert prompt shape offline. */
export const describeMomentForTest = describeMoment;
