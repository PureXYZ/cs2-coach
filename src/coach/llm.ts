import Anthropic from "@anthropic-ai/sdk";
import { log } from "../log.js";
import type { MatchContext, CoachEvent } from "../gsi/tracker.js";
import { ECONOMY_CHEATSHEET, DECISION_PRINCIPLES, mapBriefing } from "./knowledge.js";

/**
 * "smart" = slow moments (freezetime, halftime, match end) on the big model.
 * "fast" = mid-round moments (retake call, round-end react, teamkill) where a
 * line landing 3 seconds earlier beats a marginally smarter one.
 */
export type LlmTier = "smart" | "fast";

const SYSTEM_CORE = `You are "Coach" — an energetic, sharp Counter-Strike 2 coach sitting in a Discord voice channel with a player and their friends during a Premier/Competitive match. Each request gives you a JSON snapshot of the game state plus a description of the moment; you reply with ONE spoken coaching line.

WHAT YOU CAN AND CANNOT SEE:
- You see only the player's OWN state (money, HP, armor, weapons, kills), team scores, round history and the match memory in the snapshot. You have NO kill feed, NO positions, NO alive counts, NO enemy or teammate economy. Never invent any of those.
- "playerIsSelf": false means the player is DEAD — own-state fields (money, HP, weapons) are absent or belong to the "spectating" teammate. Never give a dead player advice about their current gear.
- "spectating" means the player is DEAD and watching that teammate — those stats belong to the teammate.
- Because you don't know how many players are alive, phrase mid-round advice conditionally: "if the retake isn't clean...", "if you've got the numbers...".
- "history" and "notables" really happened — referencing them is encouraged. Inventing other past events is forbidden.

HOW TO SPEAK:
- ONE line, at most 28 words; mid-round moments want 8-15 words. Output ONLY the line — no preamble, quotes, markdown, emoji or reasoning. It goes straight to text-to-speech.
- Plain spoken English, contractions welcome. Energetic but not exhausting: freezetime lines can breathe, mid-round lines are short and urgent-calm.
- Be concrete: tie the call to the actual money, gear, score, clock and history in the snapshot.
- Vary your phrasing — never reuse the openers or signature words from your recent lines.

THE CREW:
- "friends" lists the player's crew — mostly who's in the voice channel right now, and it may include the player's own Discord handle. If an entry looks like a variant of the player's name, that's them, not a third person. Use the player's name; drop a friend's name in when natural (banter after rounds, big plays, halftime). Light teasing is welcome, real negativity never — after lost rounds be constructive, not snarky. While the player is dead and spectating, cheering the spectated teammate BY NAME is gold.

${ECONOMY_CHEATSHEET}

${DECISION_PRINCIPLES}`;

export class LlmCoach {
  private client: Anthropic;
  private model: string;
  private fastModel: string;
  private maxTokens: number;
  private timeoutMs: number;
  private fastTimeoutMs: number;
  private recentLines: string[] = [];

  constructor(opts: {
    apiKey: string;
    model: string;
    fastModel: string;
    maxTokens: number;
    timeoutMs: number;
    fastTimeoutMs: number;
  }) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.fastModel = opts.fastModel;
    this.maxTokens = opts.maxTokens;
    this.timeoutMs = opts.timeoutMs;
    this.fastTimeoutMs = opts.fastTimeoutMs;
  }

  /**
   * One short coaching line for the given moment, or null on timeout/error
   * (callers fall back to the rule engine's canned lines).
   */
  async line(context: MatchContext, event: CoachEvent, tier: LlmTier = "smart"): Promise<string | null> {
    const model = tier === "fast" ? this.fastModel : this.model;
    const timeout = tier === "fast" ? this.fastTimeoutMs : this.timeoutMs;

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
      `Moment: ${describeMoment(event, context)}`,
      this.recentLines.length
        ? `Your recent lines, oldest first (do NOT reuse their phrasing, openers, or signature words): ${JSON.stringify(this.recentLines)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    const startedAt = Date.now();
    try {
      const response = await this.client.messages.create(
        {
          model,
          max_tokens: this.maxTokens,
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
      return text;
    } catch (err) {
      log.warn("llm", `${model} call failed after ${Date.now() - startedAt}ms (${err instanceof Error ? err.message : err}) — using rule-based line`);
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
    if (this.recentLines.length > 12) this.recentLines.shift();
  }
}

function describeMoment(event: CoachEvent, ctx: MatchContext): string {
  switch (event.type) {
    case "freezetime": {
      const pistol = ctx.roundKind === "pistol";
      return pistol
        ? `Freezetime of round ${event.round} — PISTOL ROUND (everyone has 800, no carryover). Give one concrete plan for this map and side: where to go, what to buy (armor vs utility vs upgraded pistol), together as five.`
        : `Freezetime / buy period, round ${event.round}. Give ONE buy call matched to the money and loss bonus, plus ONE concrete tactical idea for this map and side (a place to hit, utility to stack, or a discipline point). If the round history shows a pattern — lost streak, won pistols, repeated bomb-site losses — use it.`;
    }
    case "bombPlanted":
      if (event.ourSide === "CT") {
        if (!ctx.playerIsSelf) {
          return `Bomb just got planted — your team is CT, about 40 seconds on the clock, and the player is DEAD watching a teammate. Call the retake-or-save for the TEAM from score, economy and history only (no own-gear talk); cheering the spectated teammate by name is welcome. Short and urgent.`;
        }
        return `Bomb just got planted — your team is CT, about 40 seconds on the clock. Make the retake-or-save call from the snapshot: gear value, HP, armor, defuse kit, score situation and economy next round. You don't know teammate equipment or alive counts, so phrase it conditionally. Short and urgent.`;
      }
      if (event.ourSide === "T") {
        return `Your team just planted the bomb (T side). One short post-plant discipline line: positions, patience, play the clock.`;
      }
      return `The bomb was just planted. One short, side-neutral heads-up line.`;
    case "roundEnd":
      return `Round just ended: ${event.won ? "WON" : "LOST"} (${event.method}), score now ${event.ourScore}-${event.theirScore}. ONE punchy reaction line, 15 words max — reference the round's story (kills, plant, streak, a friend's play) when it's interesting, otherwise keep it simple. The buy advice comes separately at freezetime, don't give it here.`;
    case "teamkill":
      return `The player just TEAM-KILLED a teammate. One playful roast or mock-apology — keep it light and friendly, never genuinely mean. If friends are listed, you may name-check.`;
    case "halftime":
      return `Halftime break. Give a short halftime talk grounded in the actual half: the score, pistol result, streaks, anything notable from history. Set the mindset for the side switch (new economy, new roles).`;
    case "matchPoint":
      return event.forUs
        ? "Match point in our favor — closing mindset, no hero plays."
        : "Opponent match point — must-win round, anti-tilt, one round at a time.";
    case "matchEnd":
      return event.won
        ? `The match was just WON ${event.ourScore}-${event.theirScore}. Celebrate briefly — call back the best moment from notables/history if there is one.`
        : `The match was just lost ${event.ourScore}-${event.theirScore}. Brief, genuine, constructive sign-off — one real positive from the match if history offers one. No toxicity.`;
    default:
      return `Event: ${event.type}. React appropriately in one short line.`;
  }
}
