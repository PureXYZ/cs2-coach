import Anthropic from "@anthropic-ai/sdk";
import { log } from "../log.js";
import type { MatchContext, CoachEvent } from "../gsi/tracker.js";

const SYSTEM_PROMPT = `You are "Coach", an energetic, supportive esports coach sitting in a Discord voice channel with a Counter-Strike 2 player and their friends during a Premier/Competitive match. You receive a JSON snapshot of the player's game state.

You only see the player's OWN state plus team scores and round history — never enemy or teammate details — so never invent positions, enemy info, or teammate economy.

Respond with ONE spoken coaching line: 1-2 short sentences, at most 28 words total. It will be read aloud by text-to-speech, so:
- Output ONLY the line itself. No preamble, no quotes, no markdown, no emoji, no reasoning.
- Plain spoken English, contractions welcome, energetic but not annoying.
- Be concrete: tie advice to the money, score, streaks or weapons in the snapshot (buy/save/force calls, momentum, discipline, utility usage, mental reset).
- Vary your phrasing between rounds; never repeat stock phrases.`;

export class LlmCoach {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private timeoutMs: number;
  private recentLines: string[] = [];

  constructor(opts: { apiKey: string; model: string; maxTokens: number; timeoutMs: number }) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.maxTokens = opts.maxTokens;
    this.timeoutMs = opts.timeoutMs;
  }

  /**
   * One short tactical line for the given moment, or null on timeout/error
   * (callers fall back to the rule engine's canned lines).
   */
  async line(context: MatchContext, event: CoachEvent): Promise<string | null> {
    const userContent = [
      `Game state snapshot: ${JSON.stringify(context)}`,
      `Moment: ${describeMoment(event)}`,
      this.recentLines.length
        ? `Your last few lines (do NOT repeat their phrasing): ${JSON.stringify(this.recentLines)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userContent }],
        },
        { timeout: this.timeoutMs, maxRetries: 0 },
      );

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join(" ")
        .trim();

      if (!text) return null;
      this.recentLines.push(text);
      if (this.recentLines.length > 4) this.recentLines.shift();
      return text;
    } catch (err) {
      log.warn("llm", `Claude call failed (${err instanceof Error ? err.message : err}) — using rule-based line`);
      return null;
    }
  }
}

function describeMoment(event: CoachEvent): string {
  switch (event.type) {
    case "freezetime":
      return `Freezetime / buy period at the start of round ${event.round}. Give buy advice and one tactical or mental focus point.`;
    case "halftime":
      return "Halftime break. Give a short halftime talk: reflect on the half and set the mindset for the side switch.";
    case "matchPoint":
      return event.forUs
        ? "Match point in our favor — closing mindset."
        : "Opponent match point — must-win round, anti-tilt.";
    case "matchEnd":
      return event.won
        ? "The match was just WON. Celebrate briefly and call out the team effort."
        : "The match was just lost. Brief, genuine, constructive sign-off — no toxicity.";
    default:
      return `Event: ${event.type}. React appropriately in one short line.`;
  }
}
