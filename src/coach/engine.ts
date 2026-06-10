import { log } from "../log.js";
import type { CoachEvent, MatchContext } from "../gsi/tracker.js";
import type { LlmCoach } from "./llm.js";
import * as lines from "./lines.js";

export interface SpeakRequest {
  text: string;
  /** Higher wins when the queue has a backlog. */
  priority: number;
  /** Lines older than this (measured from eventAt) are dropped instead of spoken late. */
  maxAgeMs: number;
  /** Cooldown/dedup bucket. */
  category: string;
  /**
   * When the triggering game moment happened. Staleness counts from here, so a
   * slow LLM response can't smuggle stale advice past the freshness check.
   */
  eventAt: number;
}

export type Speak = (req: SpeakRequest) => void;

// Per-category minimum gap between spoken lines, so the coach never gets spammy.
const COOLDOWNS_MS: Record<string, number> = {
  kill: 6_000,
  mvp: 8_000,
  death: 25_000,
  economy: 10_000,
  tactical: 10_000,
  bomb: 5_000,
  roundEnd: 8_000,
  match: 5_000,
};

/**
 * Turns tracker events into spoken lines. Twitch events (kills, bomb) always come
 * from the instant rule table; freezetime/halftime/match moments go to Claude when
 * available, with the rule line as fallback.
 */
export class CoachEngine {
  private lastSpokenAt = new Map<string, number>();

  constructor(
    private readonly speak: Speak,
    private readonly llm: LlmCoach | null,
  ) {}

  handle(events: CoachEvent[], ctx: MatchContext): void {
    for (const event of events) {
      try {
        this.handleOne(event, ctx);
      } catch (err) {
        log.error("coach", `Failed handling event ${event.type}`, err);
      }
    }
  }

  private handleOne(event: CoachEvent, ctx: MatchContext): void {
    switch (event.type) {
      case "matchStart":
        this.say(lines.matchStartLine(event.map), { category: "match", priority: 2, maxAgeMs: 15_000 });
        break;

      case "freezetime":
        this.tacticalMoment(event, ctx, () => lines.economyLine(ctx), "economy", 12_000);
        break;

      case "roundLive":
        break; // round start itself isn't worth talking over

      case "bombPlanted":
        this.say(lines.bombPlantedLine(event.ourSide), { category: "bomb", priority: 3, maxAgeMs: 12_000 });
        break;

      case "bombDefused":
        this.say(lines.bombDefusedLine(event.ourSide), { category: "bomb", priority: 2, maxAgeMs: 10_000 });
        break;

      case "bombExploded":
        this.say(lines.bombExplodedLine(event.ourSide), { category: "bomb", priority: 2, maxAgeMs: 10_000 });
        break;

      case "roundEnd": {
        if (event.won === undefined) break;
        const text = event.won
          ? lines.roundWonLine(event.ourScore, event.theirScore)
          : lines.roundLostLine(event.ourScore, event.theirScore);
        this.say(text, { category: "roundEnd", priority: 1, maxAgeMs: 8_000 });
        break;
      }

      case "halftime":
        this.tacticalMoment(event, ctx, () => lines.halftimeLine(ctx), "tactical", 30_000);
        break;

      case "matchPoint":
        this.say(lines.matchPointLine(event.forUs), { category: "match", priority: 3, maxAgeMs: 12_000 });
        break;

      case "matchEnd":
        this.tacticalMoment(event, ctx, () => lines.matchEndLine(event.won, event.ourScore, event.theirScore), "match", 30_000);
        break;

      case "kill": {
        const text = lines.killLine(event.roundKills, event.headshot, ctx.playerName);
        if (text) this.say(text, { category: "kill", priority: 2, maxAgeMs: 5_000 });
        break;
      }

      case "death": {
        const text = lines.deathLine();
        if (text) this.say(text, { category: "death", priority: 0, maxAgeMs: 6_000 });
        break;
      }

      case "mvp":
        this.say(lines.mvpLine(ctx.playerName), { category: "mvp", priority: 2, maxAgeMs: 8_000 });
        break;
    }
  }

  /**
   * Slow-moment line: ask Claude (non-blocking); if it fails or is disabled,
   * speak the rule-based fallback instead.
   */
  private tacticalMoment(
    event: CoachEvent,
    ctx: MatchContext,
    fallback: () => string | null,
    category: string,
    maxAgeMs: number,
  ): void {
    if (!this.passesCooldown(category)) return;
    const eventAt = Date.now();

    if (!this.llm) {
      const text = fallback();
      if (text) this.say(text, { category, priority: 1, maxAgeMs, eventAt }, true);
      return;
    }

    // Snapshot the context now; the game moves on while Claude thinks. Staleness
    // is anchored to eventAt, so a slow response gets dropped instead of spoken late.
    const snapshot = { ...ctx };
    void this.llm.line(snapshot, event).then((text) => {
      const final = text ?? fallback();
      if (final) this.say(final, { category, priority: 1, maxAgeMs, eventAt }, true);
    });
  }

  private say(
    text: string,
    opts: { category: string; priority: number; maxAgeMs: number; eventAt?: number },
    skipCooldownCheck = false,
  ): void {
    if (!skipCooldownCheck && !this.passesCooldown(opts.category)) return;
    this.lastSpokenAt.set(opts.category, Date.now());
    this.speak({ text, ...opts, eventAt: opts.eventAt ?? Date.now() });
  }

  private passesCooldown(category: string): boolean {
    const last = this.lastSpokenAt.get(category) ?? 0;
    const cooldown = COOLDOWNS_MS[category] ?? 5_000;
    return Date.now() - last >= cooldown;
  }
}
