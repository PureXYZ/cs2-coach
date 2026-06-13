import { log } from "../log.js";
import { config } from "../config.js";
import type { CoachEvent, MatchContext } from "../gsi/tracker.js";
import type { LlmCoach, LlmTier, LineOpts } from "./llm.js";
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
  /**
   * Categories whose queued-but-unspoken lines this one makes obsolete (a quad
   * line replaces a still-queued triple line instead of playing after it).
   */
  supersedes?: string[];
  /**
   * Re-checked right before the line is synthesized AND right before it plays:
   * the game may have moved past the moment while the line waited in the queue
   * ("TRIPLE KILL" must not play after the fourth kill already landed).
   */
  stillRelevant?: () => boolean;
  /**
   * Keep the line's text out of every log (length only). Set on lines built
   * from third-party API data the project must not persist (Leetify).
   */
  redactText?: boolean;
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
  // Shared by spectator narration AND wired-teammate multikill hype, so two
  // friends popping off can't out-shout the primary's coaching (one channel).
  teammate: 12_000,
  // Last-man-standing clutch call (multi-feed, whole-team certainty only).
  lastman: 10_000,
  // C3 squad weak-link nudge — long gap so two offenders can't be called back to
  // back; the roster's per-offender latch already caps it to once each per match.
  weakLink: 60_000,
  clock: 25_000,
  // The canned timeout call (LLM-less setups) — once it's been said, the next
  // few freezetimes of the same losing streak don't need it repeated.
  timeout: 300_000,
  // The speech/jab when a tactical timeout actually starts (max two per match).
  timeoutTalk: 20_000,
  // The opening-death-spiral tilt jab — a long gap so it scolds the spiral once,
  // not at every freezetime while the player is already rattled.
  tilt: 180_000,
};

/** Clock callouts bail when GSI went quiet (game crash, disconnect, menu).
 *  The cfg heartbeat is 10s and real 11s gaps were captured — 12s left no margin. */
const PAYLOAD_FRESH_MS = 15_000;

/** Events ITEM 7: gather simultaneous wired-teammate multikills before speaking ONE
 *  merged line. Well under the teammate maxAgeMs (6000) so the flushed line is never stale. */
const MULTIKILL_FLUSH_MS = 700;

/**
 * Turns tracker events into spoken lines. Twitch events (kills, bomb hype, clock
 * callouts) come from the instant rule table; decision moments go to Claude when
 * available — the smart model for slow moments (freezetime, halftime, match end),
 * the fast model mid-round (retake call, round-end react, teamkill) — with the
 * rule line as fallback. GSI sends no clock, so the engine also runs its own
 * round/bomb timers off the phase transitions for time-based callouts.
 */
export interface EngineDeps {
  /** Fresh context supplier for timer-driven callouts (the game moved on since scheduling). */
  getCtx: () => MatchContext;
  /** ms since the last GSI payload (null before the first) — staleness guard for timers. */
  payloadAgeMs?: () => number | null;
  /** Raw epoch ms of the player's latest own kill — exact, unlike the rounded context field. */
  lastOwnKillAt?: () => number | null;
  /** Current own round-kill count (null while dead) — staleness check for queued kill hype. */
  ownRoundKills?: () => number | null;
  /** Unabridged round history, swapped in for the storytelling moments (halftime, match end). */
  fullHistory?: () => string[];
  /** Own final K/A/D/MVPs — the matchEnd context loses them when the player
   *  died in the last round (the gameover player block is a spectated teammate). */
  finalStats?: () => { kills: number; assists: number; deaths: number; mvps: number } | undefined;
  /** Cross-session trend lines from the session store — smart-tier prompts only. */
  recentForm?: () => string[] | undefined;
  /** True while /coach quiet has the coach muted — skips both lines and LLM spend. */
  isQuiet?: () => boolean;
  /** Fired once per matchEnd, quiet or not: session recording + the Leetify recap. */
  onMatchEnd?: (event: Extract<CoachEvent, { type: "matchEnd" }>, ctx: MatchContext) => void;
  /** Fired for every decided line (LLM or fallback) — feeds the optional
   *  decision log for offline review. redact keeps Leetify text out of the log. */
  onDecision?: (rec: {
    snapshot: MatchContext;
    event: CoachEvent;
    tier: LlmTier;
    text: string;
    source: "llm" | "fallback";
    redact?: boolean;
  }) => void;
}

export class CoachEngine {
  private lastSpokenAt = new Map<string, number>();
  private lateRoundTimer: NodeJS.Timeout | null = null;
  private bombTimer: NodeJS.Timeout | null = null;
  /** Events ITEM 7: buffer simultaneous wired-teammate multikills (steamid -> best
   *  this round) and flush ONE line after a short window, so two friends popping off
   *  in the same beat merge instead of stepping on each other. */
  private multiKillBuf = new Map<string, { kills: number; name?: string }>();
  private multiKillTimer: NodeJS.Timeout | null = null;
  /** B6: broke friends already named for a drop THIS match — latches the LLM-off
   *  drop coda to once per recipient so it can't re-name the same friend each freeze. */
  private droppedTo = new Set<string>();

  constructor(
    private readonly speak: Speak,
    private readonly llm: LlmCoach | null,
    private readonly deps: EngineDeps,
  ) {}

  private getCtx(): MatchContext {
    return this.deps.getCtx();
  }

  private lastOwnKillAt(): number | null {
    return this.deps.lastOwnKillAt?.() ?? null;
  }

  private ownRoundKills(): number | null {
    return this.deps.ownRoundKills?.() ?? null;
  }

  handle(events: CoachEvent[], ctx: MatchContext): void {
    // Our timeout owns its freezetime: the speech carries the buy plan, so the
    // separate economy line would be a duplicate racing it for the same pause
    // (a timeout voted during the prior round lands ON the freezetime frame).
    const ourTimeout = events.some((e) => e.type === "timeout" && e.ours === true);
    const batchEvents = ourTimeout ? events.filter((e) => e.type !== "freezetime") : events;
    const batch = new Set(batchEvents.map((e) => e.type));
    for (const event of batchEvents) {
      try {
        if (this.suppressedInBatch(event.type, batch)) {
          log.debug("engine", `${event.type}: batch-suppressed (folded into the same-frame round/match end)`);
          continue;
        }
        this.handleOne(event, ctx, batch);
      } catch (err) {
        log.error("coach", `Failed handling event ${event.type}`, err);
      }
    }
  }

  /**
   * One moment, one line: a defuse/explosion/MVP that arrives in the same GSI
   * frame as the round (or match) end is part of that story, not its own
   * announcement — a live session stacked three lines on a single defuse. The
   * roundEnd line (LLM or fallback) re-tells the suppressed story itself.
   * An MVP bundled with the NEXT freezetime instead is NOT suppressed: that
   * round's end line already went out without it, so nothing would tell it.
   * Timer cleanup is safe to skip here: roundEnd/matchEnd cancel all timers.
   */
  private suppressedInBatch(type: CoachEvent["type"], batch: Set<CoachEvent["type"]>): boolean {
    if (batch.has("matchEnd") && ["freezetime", "roundEnd", "bombDefused", "bombExploded", "mvp"].includes(type)) {
      return true;
    }
    if (batch.has("roundEnd") && ["bombDefused", "bombExploded", "mvp"].includes(type)) return true;
    // matchStart owns round 1: the greeting line IS the pistol call too (the
    // prompt and fallback fold it in) — a separate freezetime line would race
    // the greeting for the same 15 seconds and one of them usually died stale.
    if (batch.has("matchStart") && type === "freezetime") return true;
    return false;
  }

  private handleOne(event: CoachEvent, ctx: MatchContext, batch: Set<CoachEvent["type"]>): void {
    switch (event.type) {
      case "matchStart": {
        this.cancelTimers();
        this.droppedTo.clear(); // B6: re-arm the per-recipient drop latch each match
        // Smart tier so the greeting can call back to past sessions (recentForm).
        // When the round-1 freezetime rides in the same GSI frame (the usual
        // case), that event is suppressed and THIS line carries the pistol
        // call too — one moment, one line.
        const fallback = () => {
          const greet = lines.matchStartLine(event.map);
          const eco = ctx.roundPhase === "freezetime" ? lines.economyLine(ctx, this.droppedTo) : null;
          return eco ? `${greet} ${eco}` : greet;
        };
        this.tacticalMoment(event, ctx, fallback, "match", 15_000, "smart", 2);
        break;
      }

      case "freezetime": {
        this.cancelTimers();
        // The timeout call: the LLM path folds it into the buy line via a
        // ONE-SHOT context flag on the "timeout" cooldown bucket — without it
        // the directive would re-fire at every freezetime of the same streak
        // and the coach would nag the timeout round after round.
        const wantTimeout =
          (ctx.ourTimeoutsLeft ?? 0) > 0 && (ctx.ourLossStreak ?? 0) >= 4 && !this.deps.isQuiet?.();
        let ftCtx = ctx;
        if (wantTimeout && this.llm && this.passesCooldown("timeout")) {
          this.lastSpokenAt.set("timeout", Date.now());
          ftCtx = { ...ctx, suggestTimeout: true };
        }
        this.tacticalMoment(event, ftCtx, () => lines.economyLine(ctx, this.droppedTo), "economy", 12_000, "smart");
        // The LLM-less setup still has to make the call somehow (same bucket,
        // so it doesn't repeat either).
        if (!this.llm && wantTimeout) {
          this.say(() => lines.timeoutCallLine(), { category: "timeout", priority: 2, maxAgeMs: 12_000 });
        }
        // Opening-death spiral: a short canned tilt jab fired ALONGSIDE the buy
        // call (its own 'tilt' bucket, so it doesn't race the economy cooldown).
        // Canned on purpose — no second LLM round-trip competing with the buy
        // line — and the 180s cooldown means it scolds the spiral once, not at
        // every freezetime while the player's already on tilt.
        if (!this.deps.isQuiet?.() && (ctx.earlyDeathStreak ?? 0) >= 3) {
          this.say(() => lines.tiltLine(), { category: "tilt", priority: 2, maxAgeMs: 12_000 });
        }
        break;
      }

      case "roundLive":
        this.scheduleLateRoundCallout();
        break;

      case "bombPlanted": {
        this.cancelLateRoundTimer();
        this.scheduleBombCallout();
        if (event.ourSide === "CT") {
          // The nuanced retake-or-save call: fast model, gear-aware rule line as
          // fallback. A fast kit-defuse or round end can beat the LLM round-trip,
          // so the line re-checks that the bomb is still live before speaking.
          const plantAt = Date.now();
          this.tacticalMoment(event, ctx, () => lines.retakeDecisionLine(ctx), "retake", 12_000, "fast", 3, () => {
            const now = this.getCtx();
            if (now.bomb !== "planted" || now.roundPhase !== "live") return false;
            // A kill landed while the line was in flight: the player is mid-clutch
            // and handling it — a strategy lecture now is noise at best, "save"
            // while they're winning at worst (a live session did exactly that).
            // Raw timestamps: the rounded context field would misclassify kills
            // within ±0.5s of the plant — exactly the kill-the-planter moment.
            const killAt = this.lastOwnKillAt();
            if (killAt !== null && killAt >= plantAt) return false;
            return true;
          });
        } else {
          this.say(() => lines.bombPlantedLine(event.ourSide), { category: "bomb", priority: 3, maxAgeMs: 12_000 });
        }
        break;
      }

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
        const tookMvp = event.mvp || batch.has("mvp");
        // The same-batch defuse/explosion/MVP lines were suppressed on the
        // promise that this line covers them — a promise that can't depend on
        // the LLM being up, so the canned fallback tells the whole story too.
        const fallback = () => {
          const story = batch.has("bombDefused")
            ? lines.bombDefusedLine(ctx.ourSide)
            : batch.has("bombExploded")
              ? lines.bombExplodedLine(ctx.ourSide)
              : null;
          // The last round before a money reset is its own story: "keep the
          // momentum / buy right next round" talk is nonsense when the half
          // just ended (sides swap, wallets wipe) or overtime starts. Round 12
          // = halftime is an MR12 competitive fact — wingman halves at 8, so
          // the gate matches moneyResetsNextRound's mode check. Tied scores at
          // a reset boundary mean overtime is starting; untied means it's the
          // mid-OT side swap (round 27, 33, ...) — OT is already running, so
          // "tied, overtime now" lines would be flatly wrong there.
          const score =
            ctx.mode === "competitive" && ctx.round === 12
              ? lines.halfEndLine(won, event.ourScore, event.theirScore)
              : ctx.moneyResetsNextRound
                ? event.ourScore === event.theirScore
                  ? lines.otNextLine(event.ourScore, event.theirScore)
                  : lines.otHalfLine(event.ourScore, event.theirScore)
                : won
                  ? lines.roundWonLine(event.ourScore, event.theirScore)
                  : lines.roundLostLine(event.ourScore, event.theirScore);
          const mvpTag = tookMvp ? " And the MVP star's yours. Sure. Why not." : "";
          return `${story ? `${story} ` : ""}${score}${mvpTag}`;
        };
        this.tacticalMoment(
          { ...event, mvp: tookMvp },
          ctx,
          fallback,
          "roundEnd",
          // 12s, not the usual 8: the score line queues behind ace hype from
          // the same frame and is still worth hearing that late.
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
        // The spoken wrap-up snapshots its context (and recentForm) FIRST —
        // the hook below records this match into the session store, and the
        // wrap-up must not see the match it's announcing as "past form".
        // Long form: post-game has nothing to talk over, so the wrap-up takes
        // 50-90 words at effort=high instead of one capped line.
        this.tacticalMoment(
          event,
          ctx,
          () => lines.matchEndLine(event.won, event.ourScore, event.theirScore),
          "match",
          30_000,
          "smart",
          // Priority 3, not 1: this highest-effort line must survive a queue
          // backlog (ace hype / MVP from the final round) instead of losing to it.
          3,
          undefined,
          // 20s budget: effort=high × 3-6x the tokens doesn't fit the 9s
          // freezetime-sized default, and post-match nothing is waiting.
          { longForm: true, timeoutMs: 20_000 },
        );
        // Quiet or not: the session store and the Leetify recap still want the match.
        try {
          this.deps.onMatchEnd?.(event, ctx);
        } catch (err) {
          log.error("coach", "onMatchEnd hook failed", err);
        }
        break;

      case "timeout":
        // 30 seconds of dead air. Ours: the regroup speech (long form, 14s
        // LLM budget so the speech still starts comfortably inside the pause;
        // 30s staleness so a slow-but-successful one isn't dropped). Theirs:
        // one dry jab. Side unknown: stay quiet.
        if (event.ours === true) {
          this.tacticalMoment(event, ctx, () => lines.ourTimeoutSpeechLine(ctx), "timeoutTalk", 30_000, "smart", 2, undefined, {
            longForm: true,
            timeoutMs: 14_000,
          });
        } else if (event.ours === false) {
          this.say(() => lines.theirTimeoutLine(), { category: "timeoutTalk", priority: 2, maxAgeMs: 20_000 });
        }
        break;

      case "kill": {
        // Triple and up bypass the 6s cooldown: fast multikills are exactly the
        // sub-6s case, and the first-kill line must never mute the ACE line (a
        // live session lost its entire ace escalation to this cooldown).
        // Singles and doubles stay silent — kill-by-kill narration is noise.
        const count = event.roundKills;
        this.say(
          () => lines.killLine(count, ctx.playerName),
          {
            category: "kill",
            priority: 2,
            maxAgeMs: 5_000,
            // A still-queued triple line is old news once the quad line exists —
            // and a "TRIPLE KILL" that would speak after the 4th kill already
            // landed gets dropped at the mic instead (a live session heard its
            // triple hype while the fourth body was already on the floor).
            supersedes: ["kill", "specialKill"],
            stillRelevant: () => {
              const k = this.ownRoundKills();
              if (k !== null && k > count) return false; // a fresher kill line exists
              // The ace is history — celebrate it even if the player got traded.
              if (count >= 5) return true;
              // Triple/quad lines are forward-looking ("one more for the ace") —
              // hype for the living, not for a corpse that just got traded.
              const now = this.getCtx();
              return now.playerIsSelf && (now.health ?? 0) > 0;
            },
          },
          count >= 3,
        );
        break;
      }

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
                return lines.nadeKillLine(event.nade ?? "he", event.kills ?? 1);
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
        // A newer spectated kill replaces a still-queued older one, same as own kills.
        this.say(
          () => lines.teammateKillLine(event.name, event.roundKills, event.health),
          { category: "teammate", priority: 1, maxAgeMs: 6_000, supersedes: ["teammate"] },
          event.roundKills >= 4,
        );
        break;

      case "teammateMultiKill":
        // Events ITEM 7: buffer + (re)arm a short timer; two friends popping off in the
        // same beat merge into ONE line. De-dupe by steamid (triple->quad raises the entry).
        this.bufferTeammateMultiKill(event.who.steamid, event.who.name, event.roundKills);
        break;

      case "lastManStanding":
        // Multi-feed clutch call — the roster only emits this with whole-team
        // certainty (a full, fresh squad), so the line can be confident.
        this.say(() => lines.lastManStandingLine(event.who.name), {
          category: "lastman",
          priority: 3,
          maxAgeMs: 5_000,
        });
        break;

      case "weakLink":
        // C3: the roster code-gates this (once per offender per match, freezetime
        // only), so the line can name the friend — framed as a team trade problem.
        this.say(() => lines.squadOpeningDeathsLine(event.who.name), {
          category: "weakLink",
          priority: 1,
          maxAgeMs: 12_000,
        });
        break;

      case "death":
        // Dying to the bomb blast or exit fire after the round is decided:
        // every death variant coaches an ongoing round, which has just ended.
        if (ctx.roundPhase === "over") break;
        // A burned/blind death is a named, roast-worthy way to go (a live session
        // burned to death and the coach said nothing) — those speak reliably;
        // a generic death stays mostly silent so deaths aren't narrated.
        this.say(() => lines.deathLine(event.cause), {
          category: "death",
          priority: event.cause ? 1 : 0,
          maxAgeMs: 6_000,
        });
        break;

      case "mvp":
        this.say(() => lines.mvpLine(ctx.playerName), { category: "mvp", priority: 2, maxAgeMs: 8_000 });
        break;
    }
  }

  /** Events ITEM 7: record a wired teammate's multikill (highest per steamid) and arm the flush timer. */
  private bufferTeammateMultiKill(steamid: string, name: string | undefined, kills: number): void {
    if (this.deps.isQuiet?.()) return;
    const prev = this.multiKillBuf.get(steamid);
    this.multiKillBuf.set(steamid, { kills: Math.max(kills, prev?.kills ?? 0), name: name ?? prev?.name });
    if (this.multiKillTimer) clearTimeout(this.multiKillTimer);
    this.multiKillTimer = setTimeout(() => this.flushTeammateMultiKills(), MULTIKILL_FLUSH_MS);
  }

  /** Events ITEM 7: speak the buffered multikills as ONE line. */
  private flushTeammateMultiKills(): void {
    this.multiKillTimer = null;
    const entries = [...this.multiKillBuf.values()];
    this.multiKillBuf.clear();
    if (entries.length === 0) return;
    const skipCooldown = entries.some((e) => e.kills >= 4);
    if (entries.length === 1) {
      const only = entries[0];
      this.say(() => lines.teammateMultiKillLine(only.name, only.kills),
        { category: "teammate", priority: 1, maxAgeMs: 6_000, supersedes: ["teammate"] }, skipCooldown);
      return;
    }
    const names = entries.map((e) => e.name).filter((n): n is string => !!n);
    this.say(() => lines.teammateMultiKillDuo(names),
      { category: "teammate", priority: 1, maxAgeMs: 6_000, supersedes: ["teammate"] }, skipCooldown);
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
    /** longForm: dead-air moments (wrap-up, our timeout) get more words + effort=high. */
    llmOpts?: LineOpts,
  ): void {
    // Muted: skip the line AND the LLM spend (the game tracking carries on).
    if (this.deps.isQuiet?.()) {
      log.debug("engine", `${category}: quiet (muted)`);
      return;
    }
    if (!this.passesCooldown(category)) {
      log.debug("engine", `${category}: cooldown`);
      return;
    }
    const eventAt = Date.now();
    // Reserve the category at launch, not at resolution: while the LLM call is
    // in flight the cooldown would otherwise read as cold and a duplicate event
    // could start a second line for the same moment.
    this.lastSpokenAt.set(category, eventAt);

    // stillRelevant rides along into the voice queue: the LLM-resolution check
    // below catches a moment that died while Claude thought, but the line can
    // ALSO die while queued behind other audio or mid-TTS — the queue re-checks
    // right before synthesis and right before playback.
    if (!this.llm) {
      const final = fallback();
      if (final) {
        // The decision hook fires for the canned path too — source "fallback",
        // and ctx (no snapshot taken on this branch) is the state it reacted to.
        this.deps.onDecision?.({ snapshot: ctx, event, tier, text: final, source: "fallback" });
      }
      this.say(() => final, { category, priority, maxAgeMs, eventAt, stillRelevant }, true);
      return;
    }

    // Snapshot the context now; the game moves on while Claude thinks. Staleness
    // is anchored to eventAt, so a slow response gets dropped instead of spoken late.
    const snapshot = { ...ctx };
    // The storytelling moments get the expensive extras: cross-session form
    // for callbacks (NOT every freezetime — past-session roast material in
    // every buy call invites callback chatter at routine moments), and the
    // unabridged round history at halftime/match end.
    if (event.type === "matchStart" || event.type === "halftime" || event.type === "matchEnd") {
      snapshot.recentForm = this.deps.recentForm?.();
      if (event.type !== "matchStart") {
        const full = this.deps.fullHistory?.();
        if (full && full.length > (snapshot.history?.length ?? 0)) snapshot.history = full;
      }
    }
    if (event.type === "matchEnd") {
      // The gameover player block is a spectated teammate whenever the player
      // died in the final round — restore the K/D for the wrap-up speech.
      const finalStats = this.deps.finalStats?.();
      if (finalStats) {
        snapshot.kills ??= finalStats.kills;
        snapshot.assists ??= finalStats.assists;
        snapshot.deaths ??= finalStats.deaths;
        snapshot.mvps ??= finalStats.mvps;
      }
    }
    void this.llm.line(snapshot, event, tier, llmOpts).then((text) => {
      if (stillRelevant && !stillRelevant()) {
        log.debug("engine", `${category}: stillRelevant overtaken (moment resolved mid-flight)`);
        return;
      }
      const final = text ?? fallback();
      if (!final) {
        log.debug("engine", `${category}: null final (llm + fallback both empty)`);
        return;
      }
      // Fallback lines join the LLM's anti-repeat memory too — the listener
      // doesn't care who authored what they just heard.
      if (!text) this.llm?.recordSpoken(final);
      // The decision hook fires here on the LLM path — source "llm" when Claude
      // produced the text, "fallback" when its line was empty and the canned one stood in.
      this.deps.onDecision?.({ snapshot, event, tier, text: final, source: text ? "llm" : "fallback" });
      this.say(() => final, { category, priority, maxAgeMs, eventAt, stillRelevant }, true);
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
      if (!this.payloadFresh()) {
        log.debug("engine", "clock: payload-stale (GSI went quiet, lateRound bail)");
        return; // GSI went quiet — don't talk into a dead game
      }
      const ctx = this.getCtx();
      // Dead/spectating: a "hold your angles" clock nudge is advice a corpse
      // can't take (a live session heard one ~minute after dying). Also covers
      // the death-cam window where GSI still reports the dead self (playerIsSelf
      // true, health 0) before the auto-spectate switch. Stay quiet.
      // Primary dead/spectating: the second-person clock nudge below is advice a corpse
      // can't take. BUT if a WIRED teammate is carrying the C4 with no plant this late,
      // that's the single highest-value late call — name them for the squad (no random skip).
      if (!ctx.playerIsSelf || (ctx.health ?? 0) <= 0) {
        if (ctx.roundPhase === "live" && !ctx.bomb && ctx.ourSide === "T" && ctx.team?.bombCarrierName) {
          const carrier = ctx.team.bombCarrierName;
          this.say(() => lines.lateRoundCarrierNamed(carrier), { category: "clock", priority: 2, maxAgeMs: 8_000 });
        } else {
          log.debug("engine", "clock: dead-spectating (lateRound bail)");
        }
        return;
      }
      if (ctx.roundPhase !== "live" || ctx.bomb) {
        log.debug("engine", "clock: round-resolved (lateRound bail — phase/bomb moved on)");
        return; // round resolved or bomb already down
      }
      // Carrying the C4 with no plant this late is always worth the words;
      // the generic nudge keeps its random skip so it isn't every-round nagging.
      if (!ctx.hasBomb && Math.random() < 0.5) {
        log.debug("engine", "clock: random-skip (lateRound nudge, not carrying bomb)");
        return;
      }
      this.say(() => lines.lateRoundLine(ctx.ourSide, ctx.hasBomb ?? false), { category: "clock", priority: 2, maxAgeMs: 8_000 });
    }, delayMs);
  }

  /** "Ten seconds on the bomb" — high-value, always spoken when still relevant. */
  private scheduleBombCallout(): void {
    this.cancelBombTimer();
    const delayMs = (config.timings.bombSeconds - 12) * 1000;
    if (delayMs <= 0) return;
    this.bombTimer = setTimeout(() => {
      this.bombTimer = null;
      if (!this.payloadFresh()) {
        log.debug("engine", "clock: payload-stale (GSI went quiet, bomb bail)");
        return; // GSI went quiet — the frozen ctx would lie
      }
      const ctx = this.getCtx();
      // Dead/spectating (incl. the death-cam window: self, health 0) — "bail" or
      // "hold the bomb" is meaningless to a corpse.
      if (!ctx.playerIsSelf || (ctx.health ?? 0) <= 0) {
        log.debug("engine", "clock: dead-spectating (bomb bail)");
        return;
      }
      if (ctx.bomb !== "planted" || ctx.roundPhase !== "live") {
        log.debug("engine", "clock: round-resolved (bomb bail — defused/exploded/over)");
        return; // defused/exploded/over already
      }
      // A recent kill means the player is mid-fight: give them the clock, not a
      // "back off and live" order they're actively (and rightly) disobeying.
      const fighting = ctx.lastKillSecondsAgo !== undefined && ctx.lastKillSecondsAgo <= 12;
      this.say(() => lines.bombTenLine(ctx.ourSide, fighting), { category: "clock", priority: 3, maxAgeMs: 5_000 });
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
    // Events ITEM 7: a new round/freeze means last round's pending multikill hype is dead.
    if (this.multiKillTimer) clearTimeout(this.multiKillTimer);
    this.multiKillTimer = null;
    this.multiKillBuf.clear();
  }

  private payloadFresh(): boolean {
    // null = no payload ever received: that must read as STALE, not fresh. The
    // old `?? 0` defaulted a never-received feed to age 0 and let timer callouts
    // talk into a game that never started.
    const age = this.deps.payloadAgeMs?.() ?? null;
    return age !== null && age <= PAYLOAD_FRESH_MS;
  }

  /**
   * The cooldown check runs BEFORE the line thunk, so a cooldown-gated event
   * never consumes a shuffle-bag variant. (Lines dropped later in the voice
   * queue — staleness, overflow — still do; that path is rare.)
   */
  private say(
    line: () => string | null,
    opts: {
      category: string;
      priority: number;
      maxAgeMs: number;
      eventAt?: number;
      supersedes?: string[];
      stillRelevant?: () => boolean;
    },
    skipCooldownCheck = false,
  ): void {
    // Muted: drop before cooldowns and shuffle bags so nothing is consumed.
    if (this.deps.isQuiet?.()) {
      log.debug("engine", `${opts.category}: quiet (muted)`);
      return;
    }
    if (!skipCooldownCheck && !this.passesCooldown(opts.category)) {
      log.debug("engine", `${opts.category}: cooldown`);
      return;
    }
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
