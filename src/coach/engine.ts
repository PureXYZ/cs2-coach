import { log } from "../log.js";
import { config } from "../config.js";
import { runtime } from "../runtime-overrides.js";
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
  /**
   * Called by the voice queue EXACTLY ONCE when this line actually begins playing
   * aloud. The engine uses it to commit the durable cooldown / anti-repeat memory at
   * PLAY time rather than enqueue time, so a line that never airs doesn't pollute them.
   */
  onPlayed?: () => void;
  /**
   * Called by the voice queue EXACTLY ONCE if this line is dropped before it ever plays
   * (stale, superseded, queue overflow, session change, synth/stream failure). The
   * engine uses it to release the cooldown it provisionally reserved at enqueue, so a
   * dropped line doesn't starve the next valid moment in its category. Mutually
   * exclusive with onPlayed.
   */
  onDropped?: () => void;
  /**
   * One-off ElevenLabs voice override for this line only (the `/coach say voice:`
   * option). Unset = the current `/coach voice` selection. Ignored by the
   * non-ElevenLabs providers.
   */
  voiceId?: string;
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
  // The warmup scouting speech — once per match by design (the tracker latches the
  // mapLoading event), so a long gap is just belt-and-suspenders against a re-fire.
  warmupSpeech: 300_000,
  // The opening-death-spiral tilt jab — a long gap so it scolds the spiral once,
  // not at every freezetime while the player is already rattled.
  tilt: 180_000,
};

/**
 * Per-round speech budget: a soft cap on how many lines air in one round, so a busy round
 * can't stack six calls on top of each other (a real "talks too much" complaint — a single
 * round fired economy + retake + TWO teammate hypes + clock + round-end). The round-DECIDING
 * lines always speak: the buy call (economy), the retake/save decision (retake), the round
 * result (roundEnd), match point (match), and the player's OWN multikill hype (kill/specialKill)
 * — none of those are budgeted. The DISCRETIONARY colour below competes for the budget and is
 * dropped once the round is already full: mid-round narration (death/clock/tilt/bomb hype) AND
 * teammate hype (so a teammate's triple THEN quad in one round doesn't double up — the first
 * airs, the escalation is shed when the round's busy). Quiet rounds keep their colour; busy
 * rounds shed the chatter. The counter resets when the round number changes.
 */
const ROUND_LINE_BUDGET = 3;
const BUDGETED_CATEGORIES = new Set(["death", "clock", "tilt", "bomb", "teammate"]);

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
  /** Epoch ms the current round went live / the bomb was planted (null when N/A) — the
   *  TRUE in-game start, so clock callouts are scheduled off it rather than engine
   *  handle-time (GSI buffering + async + the ~1-2s Valve plant delay would otherwise
   *  make "ten seconds on the bomb" land a couple seconds late). */
  roundLiveAt?: () => number | null;
  bombPlantedAt?: () => number | null;
  /** Raw epoch ms of the player's latest own kill — exact, unlike the rounded context field. */
  lastOwnKillAt?: () => number | null;
  /** Current own round-kill count (null while dead) — staleness check for queued kill hype. */
  ownRoundKills?: () => number | null;
  /** Unabridged round history, swapped in for the storytelling moments (halftime, match end). */
  fullHistory?: () => string[];
  /** Fetch the qualitative Leetify pre-match brief for a map (primary account only;
   *  resolves undefined when Leetify is off, the primary feed hasn't bound, or the
   *  fetch fails). Cached per map by the supplier, so warmup + match start share one
   *  network round-trip. Best-effort — the engine never blocks the greeting on it. */
  leetifyStartBrief?: (map: string) => Promise<MatchContext["leetifyStart"]>;
  /** Own final K/A/D/MVPs — the matchEnd context loses them when the player
   *  died in the last round (the gameover player block is a spectated teammate). */
  finalStats?: () => { kills: number; assists: number; deaths: number; mvps: number } | undefined;
  /** Cross-session trend lines from the session store — smart-tier prompts only.
   *  `leetifyCoversForm` suppresses the session store's map-W/L + streak lines when a
   *  Leetify brief already speaks them, so the coach never states form from two sources. */
  recentForm?: (opts?: { leetifyCoversForm?: boolean }) => string[] | undefined;
  /** True while /coach mute has the coach muted — skips both lines and LLM spend. */
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
  /** Set when a warmup scouting speech ACTUALLY AIRED this match (committed from its
   *  onPlayed, not at dispatch): the round-1 greeting then skips the Leetify form (the
   *  speech already gave it) and suppresses the session store's overlapping lines. A
   *  dispatched-but-dropped speech (too-short warmup) leaves this false, so the greeting
   *  still carries the form. Re-armed at mapLoading, consumed/reset at matchStart. */
  private warmupSpeechGiven = false;
  /** True once this match's round 1 has begun (matchStart fired). The warmup scouting
   *  speech keys its relevance off this: matchStart and the round-1 freezetime arrive
   *  together, so the speech is dropped at synth/play the instant the buy window opens —
   *  it can never be STARTED over the pistol call. Re-armed at mapLoading, reset at matchEnd. */
  private matchStarted = false;
  /** Lines dispatched to voice so far THIS round — the per-round speech budget. Discretionary
   *  mid-round narration (BUDGETED_CATEGORIES) is dropped once it hits ROUND_LINE_BUDGET;
   *  structural and hype lines always speak. Reset whenever the round number changes. */
  private roundLineCount = 0;
  /** The round number the budget counter is currently tracking — a change resets the count. */
  private budgetRound = -1;

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
    // Per-round speech budget: a new round number means a fresh line allowance, so the
    // discretionary mid-round narration can talk again. Structural/hype lines never check it.
    if (typeof ctx.round === "number" && ctx.round !== this.budgetRound) {
      this.budgetRound = ctx.round;
      this.roundLineCount = 0;
    }
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
      case "mapLoading": {
        // The pre-round-1 warmup window: dead air, no buy to race. Warm the Leetify
        // brief cache now (fire-and-forget) so the round-1 greeting has it ready even
        // when the warmup speech is off, and — when enabled — deliver a longer scouting
        // speech here. Its own cooldown bucket (never "match"), and a stillRelevant guard
        // (!matchStarted) drops it the instant round 1 begins — matchStart and the r1
        // freezetime arrive together, so the speech can never be STARTED over the buy call.
        this.cancelTimers();
        this.warmupSpeechGiven = false; // re-arm (committed from the speech's onPlayed, not here)
        this.matchStarted = false; // re-arm: a new pre-game; round 1 hasn't begun
        void this.deps.leetifyStartBrief?.(event.map);
        // No outer passesCooldown("warmupSpeech") here: tacticalMoment re-checks the
        // SAME bucket and nothing reserves it in between (passesCooldown is pure), so
        // an outer check would be redundant.
        if (runtime.warmupSpeech && !this.deps.isQuiet?.()) {
          this.tacticalMoment(
            event,
            ctx,
            () => lines.warmupSpeechLine(event.map),
            "warmupSpeech",
            30_000,
            "smart",
            2,
            () => !this.matchStarted,
            { longForm: true, timeoutMs: 14_000 },
            // Commit the suppression flag only when the speech ACTUALLY airs — a dropped
            // speech (too-short warmup) must leave the greeting free to carry the form.
            () => {
              this.warmupSpeechGiven = true;
            },
          );
        }
        break;
      }

      case "matchStart": {
        this.cancelTimers();
        this.matchStarted = true; // round 1 has begun — drops any still-pending warmup speech
        this.droppedTo.clear(); // B6: re-arm the per-recipient drop latch each match
        // Smart tier so the greeting can call back to past sessions (recentForm) and the
        // Leetify form. When the round-1 freezetime rides in the same GSI frame (the
        // usual case), that event is suppressed and THIS line carries the pistol call
        // too — one moment, one line. If a warmup speech already gave the Leetify form,
        // flag the snapshot so the greeting stays on the buy call and doesn't repeat it.
        const fallback = () => {
          const greet = lines.matchStartLine(event.map);
          const eco = ctx.roundPhase === "freezetime" ? lines.economyLine(ctx, this.droppedTo) : null;
          return eco ? `${greet} ${eco}` : greet;
        };
        const mctx: MatchContext = this.warmupSpeechGiven ? { ...ctx, warmupSpeechGiven: true } : ctx;
        this.tacticalMoment(event, mctx, fallback, "match", 15_000, "smart", 2);
        this.warmupSpeechGiven = false; // consumed — the next match re-arms at mapLoading
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
        // Fold the timeout nudge into the buy line via the one-shot flag, but DON'T
        // reserve the "timeout" bucket yet (ITEM 10): if the buy line resolves to
        // nothing the nudge is never delivered, and a launch reservation would
        // suppress it for ~5min though it was never spoken. The reservation happens
        // on the delivery path below, via onSpoken.
        const suggestTimeout = wantTimeout && !!this.llm && this.passesCooldown("timeout");
        const ftCtx: MatchContext = suggestTimeout ? { ...ctx, suggestTimeout: true } : ctx;
        this.tacticalMoment(
          event,
          ftCtx,
          () => lines.economyLine(ctx, this.droppedTo),
          "economy",
          12_000,
          "smart",
          1,
          undefined,
          undefined,
          // Reserve the timeout bucket only once the buy line (carrying the nudge)
          // is actually spoken — a dropped line leaves the bucket cold so the nudge
          // can fire at the next freezetime of the streak instead of being burned.
          suggestTimeout ? () => this.lastSpokenAt.set("timeout", Date.now()) : undefined,
        );
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
        this.warmupSpeechGiven = false; // safety re-arm in case matchStart was skipped this match
        this.matchStarted = false;
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
        const killRound = ctx.round; // snapshot: a kill line must never revive in a later round
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
              // A queue stall past a round boundary resets ownRoundKills to the new
              // round's count, which would let a stale line read as relevant — bail if
              // the round moved on (round_kills alone can't distinguish 0-this-round
              // from a fresh start).
              if (this.getCtx().round !== killRound) return false;
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
        // Only a NAMED death (burned/blind) earns a line — those are roast-worthy and the
        // player asked for them called out. A generic death stays SILENT: narrating every
        // death is exactly the play-by-play noise the player flagged as "talks too much".
        if (!event.cause) break;
        this.say(() => lines.deathLine(event.cause), {
          category: "death",
          priority: 1,
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
    /** Fires exactly once when a line is ACTUALLY handed to say() (ITEM 10) — lets a
     *  caller durably reserve a PAIRED bucket (the timeout nudge) only on delivery,
     *  not at launch, so a dropped line doesn't burn that bucket's cooldown. */
    onSpoken?: () => void,
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
    // could start a second line for the same moment. The release (ITEM 10) restores
    // the prior stamp (or deletes it) so a line that's never spoken doesn't burn the
    // whole cooldown window — but only while the reservation is still ours.
    const releaseReservation = this.reserveCooldown(category, eventAt);

    // stillRelevant rides along into the voice queue: the LLM-resolution check
    // below catches a moment that died while Claude thought, but the line can
    // ALSO die while queued behind other audio or mid-TTS — the queue re-checks
    // right before synthesis and right before playback.
    if (!this.llm) {
      const final = fallback();
      if (!final) {
        // Nothing audible — release the launch reservation (ITEM 10) so a silent
        // fallback doesn't block the category for the cooldown window.
        releaseReservation();
        return;
      }
      try {
        // The decision hook fires for the canned path too — source "fallback",
        // and ctx (no snapshot taken on this branch) is the state it reacted to.
        this.deps.onDecision?.({ snapshot: ctx, event, tier, text: final, source: "fallback" });
        this.say(
          () => final,
          {
            category,
            priority,
            maxAgeMs,
            eventAt,
            stillRelevant,
            // The launch reservation owns this category until the line actually airs.
            manageCooldown: false,
            // Durable cooldown commit + the paired timeout-nudge bucket, ONLY on real
            // playback. (No anti-repeat commit on this branch: recentLines/recentPlans
            // live on the LlmCoach, which doesn't exist in this LLM-less path.)
            onPlayed: () => {
              this.lastSpokenAt.set(category, Date.now());
              onSpoken?.();
            },
            // Dropped before play → release the launch reservation so the next moment fires.
            onDropped: releaseReservation,
          },
          true,
        );
      } catch (err) {
        // ITEM 13/engine-4: a throw here (onDecision / say) must release the
        // reservation, not leave the category locked for the session.
        releaseReservation();
        log.error("coach", `Fallback line failed for ${event.type}`, err);
      }
      return;
    }

    // Snapshot the context now; the game moves on while Claude thinks. Staleness
    // is anchored to eventAt, so a slow response gets dropped instead of spoken late.
    const snapshot = { ...ctx };
    // Resolve the line: attach the storytelling extras, call the LLM, then speak or
    // fall back. Factored out so it runs SYNCHRONOUSLY for most moments (no added
    // latency, and the fast-path sim that resolves the LLM mock inline still works),
    // and only AFTER an async Leetify fetch for warmup / match start.
    const resolveLine = (): void => {
      // The storytelling moments get the expensive extras: cross-session form for
      // callbacks (NOT every freezetime — past-session roast material in every buy
      // call invites callback chatter), and the unabridged history at halftime/end.
      if (
        event.type === "matchStart" ||
        event.type === "mapLoading" ||
        event.type === "halftime" ||
        event.type === "matchEnd"
      ) {
        // When a Leetify brief is present (or a warmup speech already gave the form),
        // suppress the session store's overlapping map-W/L + streak lines so the coach
        // never states recent/map form from two sources that could disagree.
        const leetifyCoversForm = !!snapshot.leetifyStart || !!snapshot.warmupSpeechGiven;
        snapshot.recentForm = this.deps.recentForm?.({ leetifyCoversForm });
        if (event.type === "halftime" || event.type === "matchEnd") {
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
      void this.llm!.line(snapshot, event, tier, llmOpts).then(({ text, rib }) => {
        if (stillRelevant && !stillRelevant()) {
          log.debug("engine", `${category}: stillRelevant overtaken (moment resolved mid-flight)`);
          // The moment died mid-flight — nothing audible, so release the launch
          // reservation (ITEM 10) instead of burning the cooldown on a dropped line.
          releaseReservation();
          return;
        }
        const final = text ?? fallback();
        if (!final) {
          log.debug("engine", `${category}: null final (llm + fallback both empty)`);
          // Nothing audible (llm + fallback both empty) — release the reservation (ITEM 10).
          releaseReservation();
          return;
        }
        // When the line was built from a Leetify brief, the resolved TEXT can carry
        // Leetify-derived form ("Leetify says you've been losing on Mirage") — so redact
        // it from BOTH on-disk sinks (decision log + voice/coach log), exactly as the
        // post-match recap does (index.ts). The brief itself is qualitative and never hits
        // the session store; this closes the spoken-text leak the snapshot-strip alone misses.
        const hadLeetify = !!snapshot.leetifyStart;
        // The decision hook fires here on the LLM path — source "llm" when Claude produced
        // the text, "fallback" when its line was empty and the canned one stood in. Strip the
        // Leetify brief from the logged snapshot (no-store discipline) and redact the text.
        this.deps.onDecision?.({
          snapshot: snapshot.leetifyStart ? { ...snapshot, leetifyStart: undefined } : snapshot,
          event,
          tier,
          text: final,
          source: text ? "llm" : "fallback",
          redact: hadLeetify || undefined,
        });
        this.say(
          () => final,
          {
            category,
            priority,
            maxAgeMs,
            eventAt,
            stillRelevant,
            // Keep Leetify-derived text out of the voice logs (no-store discipline).
            redactText: hadLeetify || undefined,
            // The launch reservation owns the cooldown until the line actually airs.
            manageCooldown: false,
            onPlayed: () => {
              // Durable cooldown commit at PLAY time, not enqueue (so a line dropped by
              // the voice queue never burns the category or the paired timeout bucket).
              this.lastSpokenAt.set(category, Date.now());
              onSpoken?.();
              // Commit to the anti-repeat memory only now that the line ACTUALLY aired
              // (ITEM 11 + engine-3): a line dropped while queued (stillRelevant flipped at
              // pump time, staleness, supersede) must not pollute recentLines/recentPlans.
              // Pass the rib ONLY when the LLM's own line aired (text !== null), so the canned
              // fallback never advances the rib rotation (B2 #4).
              this.llm?.commitSpoken(event, final, text !== null ? rib : undefined);
            },
            // Dropped before play (queued-then-stale/superseded/overflow) → release the
            // launch reservation so the next valid moment in this category can speak.
            onDropped: releaseReservation,
          },
          true,
        );
      }).catch((err) => {
        // ITEM 13: a throw in the resolution body (fallback/stillRelevant/say) would
        // otherwise escape the per-event try/catch as an unhandled rejection — and must
        // release the launch reservation (engine-0), or the category locks for the session.
        releaseReservation();
        log.error("coach", `LLM line resolution failed for ${event.type}`, err);
      });
    };

    // Warmup / match start need the Leetify brief fetched (async) BEFORE the prompt is
    // built; every other moment resolves synchronously, with no added latency (and the
    // LLM call stays on the synchronous path the fast-moment behavior relies on).
    if (event.type === "mapLoading" || event.type === "matchStart") {
      void this.enrichLeetify(event, snapshot).then(resolveLine).catch((err) => {
        // An enrichment throw must not strand the category cooldown.
        releaseReservation();
        log.error("coach", `Leetify enrichment failed for ${event.type}`, err);
      });
    } else {
      resolveLine();
    }
  }

  /**
   * Attach the qualitative Leetify pre-match brief to a warmup / match-start snapshot,
   * best-effort. At warmup (mapLoading) there's dead air, so it can wait a beat; at
   * matchStart it's a tight race so the greeting — which carries the round-1 pistol buy
   * call — isn't held up (the "two racing calls killed the buy call" lesson is about a
   * second LLM CALL, not enrichment, but the await still must stay short). Skipped for
   * matchStart when a warmup speech already spoke the form, for non-competitive modes,
   * and whenever the supplier resolves undefined (Leetify off / primary not bound / fetch
   * failed). Qualitative-only and never persisted: the brief reaches the LLM and TTS, not
   * the session store or the logs.
   */
  private async enrichLeetify(event: CoachEvent, snapshot: MatchContext): Promise<void> {
    if (!this.deps.leetifyStartBrief) return;
    if (event.type !== "mapLoading" && event.type !== "matchStart") return;
    if (snapshot.mode !== "competitive") return; // Premier/comp only — matches the recap's discipline
    if (event.type === "matchStart" && snapshot.warmupSpeechGiven) return; // warmup already gave the form
    const map = snapshot.map ?? event.map;
    if (!map) return;
    // Warmup has room to wait for a cold fetch; match start is best-effort so the buy
    // call isn't delayed (when warmup fired, the cache is already warm and this is instant).
    const budgetMs = event.type === "mapLoading" ? 2500 : 1000;
    const brief = await Promise.race([
      this.deps.leetifyStartBrief(map).catch(() => undefined),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), budgetMs)),
    ]);
    if (brief) snapshot.leetifyStart = brief;
  }

  // --- locally derived clock callouts (GSI sends players no timer) ----------

  /** "~35 seconds left, no plant" nudge — randomly skipped so it isn't every-round nagging. */
  private scheduleLateRoundCallout(): void {
    this.cancelLateRoundTimer();
    // Schedule off the TRUE round-live instant (when available) rather than engine
    // handle-time, so GSI buffering / async processing don't make the callout late.
    const startedAt = this.deps.roundLiveAt?.() ?? null;
    const baseDelay = (config.timings.roundSeconds - 35) * 1000;
    const delayMs = startedAt !== null ? baseDelay - (Date.now() - startedAt) : baseDelay;
    if (delayMs <= 0) return;
    this.lateRoundTimer = setTimeout(() => {
      // A malformed frame can make getCtx()/the context read throw — an unguarded
      // throw inside setTimeout escapes to uncaughtException and exits the process.
      // Log and swallow so a single bad frame can't kill the coach.
      try {
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
      } catch (err) {
        log.error("coach", "lateRound clock callout failed", err);
      }
    }, delayMs);
  }

  /** "Ten seconds on the bomb" — high-value, always spoken when still relevant. */
  private scheduleBombCallout(): void {
    this.cancelBombTimer();
    // Off the TRUE plant instant (tracker's bombPlantedAt) — the plant signal is itself
    // delayed ~1-2s by Valve and processing adds more, so scheduling from engine
    // handle-time would land "ten seconds" a couple seconds late.
    const startedAt = this.deps.bombPlantedAt?.() ?? null;
    const baseDelay = (config.timings.bombSeconds - 12) * 1000;
    const delayMs = startedAt !== null ? baseDelay - (Date.now() - startedAt) : baseDelay;
    if (delayMs <= 0) return;
    this.bombTimer = setTimeout(() => {
      // A malformed frame can make getCtx()/the context read throw — an unguarded
      // throw inside setTimeout escapes to uncaughtException and exits the process.
      // Log and swallow so a single bad frame can't kill the coach.
      try {
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
      } catch (err) {
        log.error("coach", "bomb clock callout failed", err);
      }
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
   * never consumes a shuffle-bag variant.
   *
   * Cooldown lifecycle: by default this reserves the category at ENQUEUE and wires an
   * onDropped that RESTORES the prior stamp if the voice queue later drops the line
   * (stale/superseded/overflow/error) — so a dropped line no longer starves the next
   * valid moment in its category. Callers that own the cooldown externally (the LLM
   * reservation path) pass manageCooldown:false and commit it themselves at play time
   * via onPlayed.
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
      /** Run at actual play time (durable cooldown / anti-repeat commit). */
      onPlayed?: () => void;
      /** Run if the line is dropped before play (in addition to the cooldown restore). */
      onDropped?: () => void;
      /** Set false when the caller manages the category cooldown itself (LLM path). */
      manageCooldown?: boolean;
      /** Keep this line's text out of the voice logs (length only) — set for lines built
       *  from Leetify-derived data the project must not persist. */
      redactText?: boolean;
    },
    skipCooldownCheck = false,
  ): void {
    // Muted: drop before cooldowns and shuffle bags so nothing is consumed.
    if (this.deps.isQuiet?.()) {
      log.debug("engine", `${opts.category}: quiet (muted)`);
      opts.onDropped?.();
      return;
    }
    if (!skipCooldownCheck && !this.passesCooldown(opts.category)) {
      log.debug("engine", `${opts.category}: cooldown`);
      opts.onDropped?.();
      return;
    }
    // Per-round speech budget: discretionary mid-round narration is dropped once the round
    // has already had its fill of lines, so a busy round stops piling on. Structural and hype
    // lines (everything not in BUDGETED_CATEGORIES) bypass this and always speak.
    if (BUDGETED_CATEGORIES.has(opts.category) && this.roundLineCount >= ROUND_LINE_BUDGET) {
      log.debug("engine", `${opts.category}: over round speech budget (${this.roundLineCount}/${ROUND_LINE_BUDGET})`);
      opts.onDropped?.();
      return;
    }
    const text = line();
    if (!text) {
      opts.onDropped?.();
      return;
    }
    // Reserve at enqueue (unless the caller owns the cooldown), capturing the prior
    // stamp so a drop can restore it. The restore is guarded on the stamp still being
    // OURS, so a newer line that overwrote it (or a superseding line) keeps the cooldown.
    let release: (() => void) | undefined;
    if (opts.manageCooldown !== false) {
      release = this.reserveCooldown(opts.category);
    }
    // Counts toward this round's speech budget (every line we hand to voice, structural or
    // not). It counts at DISPATCH, not airtime, so a line the voice queue later drops
    // (supersede/overflow/stale) still consumed budget — deliberately conservative: erring
    // toward fewer lines is the whole point. Only discretionary categories are gated above.
    this.roundLineCount++;
    this.speak({
      text,
      category: opts.category,
      priority: opts.priority,
      maxAgeMs: opts.maxAgeMs,
      eventAt: opts.eventAt ?? Date.now(),
      supersedes: opts.supersedes,
      stillRelevant: opts.stillRelevant,
      redactText: opts.redactText,
      onPlayed: opts.onPlayed,
      onDropped: () => {
        release?.();
        opts.onDropped?.();
      },
    });
  }

  /**
   * Reserve a category's cooldown at `stamp` (defaults to now), capturing the prior
   * stamp, and return a release closure. The release restores the prior stamp ONLY if
   * the reservation is still ours (a success path or a later event may have overwritten
   * it with a newer stamp, which must stand). Used both at LLM-launch (tacticalMoment)
   * and at enqueue (say) so a dropped line doesn't starve the next valid moment.
   */
  private reserveCooldown(category: string, stamp: number = Date.now()): () => void {
    const prior = this.lastSpokenAt.get(category);
    this.lastSpokenAt.set(category, stamp);
    return () => {
      if (this.lastSpokenAt.get(category) !== stamp) return;
      if (prior === undefined) this.lastSpokenAt.delete(category);
      else this.lastSpokenAt.set(category, prior);
    };
  }

  private passesCooldown(category: string): boolean {
    const last = this.lastSpokenAt.get(category) ?? 0;
    const cooldown = COOLDOWNS_MS[category] ?? 5_000;
    return Date.now() - last >= cooldown;
  }
}
