import { log } from "../log.js";
import { config } from "../config.js";
import type { CoachEvent, MatchContext } from "../gsi/tracker.js";
import type { LlmCoach, LlmTier } from "./llm.js";
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
  // Own bucket: a knife-kill line must not mute a triple-kill seconds later (or vice versa).
  specialKill: 6_000,
  mvp: 8_000,
  death: 25_000,
  economy: 10_000,
  tactical: 10_000,
  bomb: 5_000,
  // The CT retake call is its own bucket: it resolves async (LLM), and sharing
  // "bomb" would let its late stamp starve the defused/exploded hype lines.
  retake: 10_000,
  roundEnd: 8_000,
  match: 5_000,
  teamkill: 20_000,
  teammate: 12_000,
  clock: 25_000,
};

/** Clock callouts bail when GSI went quiet (game crash, disconnect, menu).
 *  The cfg heartbeat is 10s and real 11s gaps were captured — 12s left no margin. */
const PAYLOAD_FRESH_MS = 15_000;

/**
 * Turns tracker events into spoken lines. Twitch events (kills, bomb hype, clock
 * callouts) come from the instant rule table; decision moments go to Claude when
 * available — the smart model for slow moments (freezetime, halftime, match end),
 * the fast model mid-round (retake call, round-end react, teamkill) — with the
 * rule line as fallback. GSI sends no clock, so the engine also runs its own
 * round/bomb timers off the phase transitions for time-based callouts.
 */
export class CoachEngine {
  private lastSpokenAt = new Map<string, number>();
  private lateRoundTimer: NodeJS.Timeout | null = null;
  private bombTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly speak: Speak,
    private readonly llm: LlmCoach | null,
    /** Fresh context supplier for timer-driven callouts (the game moved on since scheduling). */
    private readonly getCtx: () => MatchContext,
    /** ms since the last GSI payload (null before the first) — staleness guard for timers. */
    private readonly payloadAgeMs: () => number | null = () => 0,
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
        this.cancelTimers();
        this.say(() => lines.matchStartLine(event.map), { category: "match", priority: 2, maxAgeMs: 15_000 });
        break;

      case "freezetime":
        this.cancelTimers();
        this.tacticalMoment(event, ctx, () => lines.economyLine(ctx), "economy", 12_000, "smart");
        break;

      case "roundLive":
        this.scheduleLateRoundCallout();
        break;

      case "bombPlanted":
        this.cancelLateRoundTimer();
        this.scheduleBombCallout();
        if (event.ourSide === "CT") {
          // The nuanced retake-or-save call: fast model, gear-aware rule line as
          // fallback. A fast kit-defuse or round end can beat the LLM round-trip,
          // so the line re-checks that the bomb is still live before speaking.
          this.tacticalMoment(event, ctx, () => lines.retakeDecisionLine(ctx), "retake", 12_000, "fast", 3, () => {
            const now = this.getCtx();
            return now.bomb === "planted" && now.roundPhase === "live";
          });
        } else {
          this.say(() => lines.bombPlantedLine(event.ourSide), { category: "bomb", priority: 3, maxAgeMs: 12_000 });
        }
        break;

      case "bombDefused":
        this.cancelBombTimer();
        this.say(() => lines.bombDefusedLine(event.ourSide), { category: "bomb", priority: 2, maxAgeMs: 10_000 });
        break;

      case "bombExploded":
        this.cancelBombTimer();
        this.say(() => lines.bombExplodedLine(event.ourSide), { category: "bomb", priority: 2, maxAgeMs: 10_000 });
        break;

      case "roundEnd": {
        this.cancelTimers();
        const won = event.won;
        if (won === undefined) break;
        this.tacticalMoment(
          event,
          ctx,
          () =>
            won
              ? lines.roundWonLine(event.ourScore, event.theirScore)
              : lines.roundLostLine(event.ourScore, event.theirScore),
          "roundEnd",
          // 12s, not the usual 8: the score line queues behind ace/MVP hype
          // from the same frame and is still worth hearing that late.
          12_000,
          "fast",
        );
        break;
      }

      case "halftime":
        this.cancelTimers();
        this.tacticalMoment(event, ctx, () => lines.halftimeLine(ctx), "tactical", 30_000, "smart");
        break;

      case "matchPoint":
        this.say(() => lines.matchPointLine(event.forUs), { category: "match", priority: 3, maxAgeMs: 12_000 });
        break;

      case "matchEnd":
        this.cancelTimers();
        this.tacticalMoment(event, ctx, () => lines.matchEndLine(event.won, event.ourScore, event.theirScore), "match", 30_000, "smart");
        break;

      case "kill":
        // Triple and up bypass the 6s cooldown: fast multikills are exactly the
        // sub-6s case, and the first-kill line must never mute the ACE line (a
        // live session lost its entire ace escalation to this cooldown).
        this.say(
          () => lines.killLine(event.roundKills, event.headshot, ctx.playerName),
          { category: "kill", priority: 2, maxAgeMs: 5_000 },
          event.roundKills >= 3,
        );
        break;

      case "specialKill":
        // Canned on purpose: knife-kill hype that arrives 3 seconds late is dead air.
        this.say(
          () => {
            switch (event.kind) {
              case "knife":
                return lines.knifeKillLine(ctx.playerName);
              case "zeus":
                return lines.zeusKillLine();
              case "grenade":
                return lines.nadeKillLine(event.nade ?? "he");
              case "lowhp":
                return lines.lowHpKillLine(event.hp ?? 10);
            }
          },
          { category: "specialKill", priority: 3, maxAgeMs: 6_000 },
        );
        break;

      case "teamkill":
        // A roast can land a beat late and still be funny — let Claude personalize it.
        this.tacticalMoment(event, ctx, () => lines.teamkillLine(), "teamkill", 10_000, "fast", 2);
        break;

      case "teammateKill":
        // Quad/ace bypass the cooldown — the triple line a few seconds earlier
        // must never mute the best spectator moments the feature exists for.
        this.say(
          () => lines.teammateKillLine(event.name, event.roundKills, event.health),
          { category: "teammate", priority: 1, maxAgeMs: 6_000 },
          event.roundKills >= 4,
        );
        break;

      case "death":
        // Dying to the bomb blast or exit fire after the round is decided:
        // every death variant coaches an ongoing round, which has just ended.
        if (ctx.roundPhase === "over") break;
        this.say(() => lines.deathLine(), { category: "death", priority: 0, maxAgeMs: 6_000 });
        break;

      case "mvp":
        this.say(() => lines.mvpLine(ctx.playerName), { category: "mvp", priority: 2, maxAgeMs: 8_000 });
        break;
    }
  }

  /**
   * Decision-moment line: ask Claude (non-blocking); if it fails or is disabled,
   * speak the rule-based fallback instead.
   */
  private tacticalMoment(
    event: CoachEvent,
    ctx: MatchContext,
    fallback: () => string | null,
    category: string,
    maxAgeMs: number,
    tier: LlmTier,
    priority = 1,
    /** Re-checked right before speaking — the game may have resolved the moment mid-flight. */
    stillRelevant?: () => boolean,
  ): void {
    if (!this.passesCooldown(category)) return;
    const eventAt = Date.now();
    // Reserve the category at launch, not at resolution: while the LLM call is
    // in flight the cooldown would otherwise read as cold and a duplicate event
    // could start a second line for the same moment.
    this.lastSpokenAt.set(category, eventAt);

    if (!this.llm) {
      this.say(fallback, { category, priority, maxAgeMs, eventAt }, true);
      return;
    }

    // Snapshot the context now; the game moves on while Claude thinks. Staleness
    // is anchored to eventAt, so a slow response gets dropped instead of spoken late.
    const snapshot = { ...ctx };
    void this.llm.line(snapshot, event, tier).then((text) => {
      if (stillRelevant && !stillRelevant()) return;
      const final = text ?? fallback();
      if (!final) return;
      // Fallback lines join the LLM's anti-repeat memory too — the listener
      // doesn't care who authored what they just heard.
      if (!text) this.llm?.recordSpoken(final);
      this.say(() => final, { category, priority, maxAgeMs, eventAt }, true);
    });
  }

  // --- locally derived clock callouts (GSI sends players no timer) ----------

  /** "~35 seconds left, no plant" nudge — randomly skipped so it isn't every-round nagging. */
  private scheduleLateRoundCallout(): void {
    this.cancelLateRoundTimer();
    const delayMs = (config.timings.roundSeconds - 35) * 1000;
    if (delayMs <= 0) return;
    this.lateRoundTimer = setTimeout(() => {
      this.lateRoundTimer = null;
      if (Math.random() < 0.5) return;
      if (!this.payloadFresh()) return; // GSI went quiet — don't talk into a dead game
      const ctx = this.getCtx();
      if (ctx.roundPhase !== "live" || ctx.bomb) return; // round resolved or bomb already down
      this.say(() => lines.lateRoundLine(ctx.ourSide), { category: "clock", priority: 2, maxAgeMs: 8_000 });
    }, delayMs);
  }

  /** "Ten seconds on the bomb" — high-value, always spoken when still relevant. */
  private scheduleBombCallout(): void {
    this.cancelBombTimer();
    const delayMs = (config.timings.bombSeconds - 12) * 1000;
    if (delayMs <= 0) return;
    this.bombTimer = setTimeout(() => {
      this.bombTimer = null;
      if (!this.payloadFresh()) return; // GSI went quiet — the frozen ctx would lie
      const ctx = this.getCtx();
      if (ctx.bomb !== "planted" || ctx.roundPhase !== "live") return; // defused/exploded/over already
      this.say(() => lines.bombTenLine(ctx.ourSide), { category: "clock", priority: 3, maxAgeMs: 5_000 });
    }, delayMs);
  }

  private cancelLateRoundTimer(): void {
    if (this.lateRoundTimer) clearTimeout(this.lateRoundTimer);
    this.lateRoundTimer = null;
  }

  private cancelBombTimer(): void {
    if (this.bombTimer) clearTimeout(this.bombTimer);
    this.bombTimer = null;
  }

  private cancelTimers(): void {
    this.cancelLateRoundTimer();
    this.cancelBombTimer();
  }

  private payloadFresh(): boolean {
    const age = this.payloadAgeMs();
    return age !== null && age <= PAYLOAD_FRESH_MS;
  }

  /**
   * The cooldown check runs BEFORE the line thunk, so a cooldown-gated event
   * never consumes a shuffle-bag variant. (Lines dropped later in the voice
   * queue — staleness, overflow — still do; that path is rare.)
   */
  private say(
    line: () => string | null,
    opts: { category: string; priority: number; maxAgeMs: number; eventAt?: number },
    skipCooldownCheck = false,
  ): void {
    if (!skipCooldownCheck && !this.passesCooldown(opts.category)) return;
    const text = line();
    if (!text) return;
    this.lastSpokenAt.set(opts.category, Date.now());
    this.speak({ text, ...opts, eventAt: opts.eventAt ?? Date.now() });
  }

  private passesCooldown(category: string): boolean {
    const last = this.lastSpokenAt.get(category) ?? 0;
    const cooldown = COOLDOWNS_MS[category] ?? 5_000;
    return Date.now() - last >= cooldown;
  }
}
