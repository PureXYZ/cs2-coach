import os from "node:os";
import { Events } from "discord.js";
import { config } from "./config.js";
import { log, pruneOldLogs } from "./log.js";
import { startGsiServer } from "./gsi/server.js";
import { GsiPayloadLog } from "./gsi/payload-log.js";
import type { CoachEvent, MatchContext } from "./gsi/tracker.js";
import { RosterManager } from "./gsi/roster.js";
import { CoachEngine } from "./coach/engine.js";
import { LlmCoach } from "./coach/llm.js";
import { SessionStore } from "./coach/session-store.js";
import type { SessionMatchRecord } from "./coach/session-store.js";
import { GoalStore } from "./coach/goal-store.js";
import { DecisionLog } from "./coach/decision-log.js";
import { buildMatchRecord } from "./coach/debrief.js";
import { leetifyRecapLine, mapDisplayName } from "./coach/lines.js";
import { LeetifyClient, pollForLeetifyStats, spokenStatsSentence } from "./leetify.js";
import { TtsChain } from "./tts/index.js";
import { VoiceCoach } from "./discord/voice.js";
import { startBot } from "./discord/bot.js";
import { clearVoiceChannel, loadVoiceChannel } from "./discord/voice-state.js";

/**
 * One snide spoken sentence recapping the last finished match — what /coach
 * lastmatch reads back. Built straight from the recorded session data (never
 * Leetify, which we don't store), so it works offline. Null when nothing's on
 * file. Result + score + map, with a K/D or thrown-pistol jab when we have it.
 */
function buildLastMatchSummary(rec?: SessionMatchRecord): string | null {
  if (!rec) return null;
  const map = rec.map ? ` on ${mapDisplayName(rec.map)}` : "";
  const score = `${rec.ourScore}-${rec.theirScore}`;
  const head =
    rec.won === undefined
      ? `Last one was ${score}${map} — couldn't even tell who won.`
      : rec.won
        ? `Last match you won ${score}${map}. Don't let it go to your head.`
        : `Last match you lost ${score}${map}. Shocking, I know.`;

  // One jab, worst material first: a thrown pistol round beats raw K/D for sting.
  const pistolLost =
    rec.pistols && (rec.pistols.first === "lost" || rec.pistols.second === "lost");
  let jab = "";
  if (pistolLost) {
    jab = " And you fumbled a pistol round, naturally.";
  } else if (rec.kills !== undefined && rec.deaths !== undefined) {
    jab =
      rec.deaths > 0 && rec.kills < rec.deaths
        ? ` You went ${rec.kills} and ${rec.deaths} — bodies, mostly yours.`
        : ` You went ${rec.kills} and ${rec.deaths}.`;
  }
  return head + jab;
}

async function main(): Promise<void> {
  // The coach often shares the PC with CS2 — make sure it never wins a CPU
  // scheduling fight against the game. Harmless on a dedicated (cloud) host.
  try {
    os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Couldn't lower priority (exotic sandbox?) — normal priority is fine too.
  }

  // Reap our own old log artifacts (coach-*.log, gsi-*.ndjson, decisions-*.ndjson)
  // BEFORE opening this session's files, so an always-on droplet doesn't slowly
  // fill its disk. No-op when GSI_LOG_RETENTION_DAYS is 0 (keep forever).
  pruneOldLogs("logs", config.gsi.logRetentionDays);

  // Keep the session's console output on disk next to the GSI capture — spoken
  // lines, drops and LLM/TTS latencies are otherwise lost when the window closes.
  log.toFile();
  log.info("main", "CS2 Coach starting up");

  // The one session focus the player set via /coach goal — persisted to state/
  // so it survives restarts, read back into the prompt at the right moments.
  const goalStore = new GoalStore();
  // Optional offline record of every decided line (COACH_LOG_DECISIONS) — what
  // the coach saw and chose to say, for after-the-fact study. Off by default.
  const decisionLog = config.coach.logDecisions ? new DecisionLog() : null;

  const tts = new TtsChain();
  const voice = new VoiceCoach(tts);

  const llm = config.llm.enabled
    ? new LlmCoach({
        apiKey: config.llm.apiKey!,
        model: config.llm.model,
        fastModel: config.llm.fastModel,
        effort: config.llm.effort,
        maxTokens: config.llm.maxTokens,
        timeoutMs: config.llm.timeoutMs,
        fastTimeoutMs: config.llm.fastTimeoutMs,
      })
    : null;
  log.info(
    "main",
    llm
      ? `LLM coach enabled (${config.llm.model}, mid-round: ${config.llm.fastModel})`
      : "LLM coach disabled — rule-based lines only",
  );

  // Multi-feed coordinator: demuxes every friend's GSI by Steam ID into one
  // per-feed tracker and fuses them. Solo, it behaves exactly like the old
  // single tracker (no team block until a second feed connects).
  const roster = new RosterManager();

  // Cross-session match history (state/ volume) — what lets the coach remember
  // last night's pistols. Written at every matchEnd, read into smart prompts.
  const sessions = new SessionStore();
  log.info("main", `Session memory: ${sessions.count} past match(es) on file`);

  // /coach quiet's shared flag: the engine checks it (skipping lines AND LLM
  // spend); the bot toggles it and flushes anything already queued or speaking.
  const quiet = { on: false };

  // Apply the preferred spoken name for the (primary) player to a context.
  const withNickname = (ctx: MatchContext): MatchContext => ({
    ...ctx,
    playerName: config.coach.playerNickname ?? ctx.playerName,
  });
  const fullContext = () => withNickname(roster.context());

  // Only the newest match's recap may speak — back-to-back games would
  // otherwise stack hour-long holds that all fire into the same quiet moment.
  let recapSeq = 0;

  // Session recording + the spoken Leetify recap. Runs on its own (the voice
  // wrap-up speech goes out via the engine in parallel); latency is free here.
  const handleMatchEnd = async (event: Extract<CoachEvent, { type: "matchEnd" }>, ctx: MatchContext) => {
    // Captured at the gameover frame — the Leetify lookup matches finished_at
    // against this instant (±10 min) to identify the right game.
    const endedAt = Date.now();
    const recapToken = ++recapSeq;
    const report = roster.matchReport();

    // Friend-only match (the primary user never played this one): nothing of the
    // user's to record, and the Leetify lookup would key on the wrong account.
    if (report.rounds.length === 0) {
      if (config.coach.primarySteam64) {
        // A configured primary that never produced a round is almost always a
        // misconfig (wrong SteamID64) rather than a genuine friend-only match —
        // surface it loudly so it's noticed.
        log.warn(
          "sessions",
          `Match ended but the configured primary (COACH_PRIMARY_STEAM64=${config.coach.primarySteam64}) never played a round — check the ID. Not recording.`,
        );
      } else {
        log.info("sessions", "Primary player didn't play this match — not recording it");
      }
      return;
    }

    // Only real matchmaking games belong in the cross-session history the
    // recap lines are built from. Premier and competitive both report mode
    // "competitive" — and so do bot matches, which is what the spectated-bot
    // flag is for (now OR'd across every wired feed). Practice games also never
    // reach Leetify (no demo), so the recap poll is skipped along with the record.
    if (report.botsDetected || ctx.mode !== "competitive") {
      const why = report.botsDetected ? "bots detected" : `mode ${ctx.mode ?? "unknown"}`;
      log.info("sessions", `Practice match (${why}) — not recording it`);
      return;
    }
    const record = buildMatchRecord(event, ctx, report);
    sessions.record(record);

    const steam64 = roster.steamId();
    if (!config.leetify.enabled || !steam64) return;
    const stats = await pollForLeetifyStats(new LeetifyClient(config.leetify.apiKey), steam64, endedAt, ctx.map);
    if (!stats) return;

    // NEVER talk over play: the numbers land 5-15+ minutes after the match,
    // which can be mid-way through the next one. Hold for a quiet moment
    // (between games, warmup, menu, game closed), re-check around the slow
    // LLM call, and keep the same guard live in the voice queue so it's
    // re-verified right before synthesis AND right before playback.
    const deadline = Date.now() + 60 * 60_000;
    const canSpeak = () =>
      !quiet.on && voice.connected && roster.quietMomentForSpeech() && recapToken === recapSeq;
    const hold = async () => {
      while (!canSpeak() && recapToken === recapSeq && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30_000));
      }
      return canSpeak();
    };
    if (!(await hold())) {
      log.info("leetify", "No quiet moment found within the hour — keeping the recap to ourselves");
      return;
    }

    const statsSentence = spokenStatsSentence(stats);
    if (!statsSentence) return;
    const text =
      (llm
        ? await llm.leetifyLine({
            map: ctx.map,
            won: event.won,
            ourScore: event.ourScore,
            theirScore: event.theirScore,
            statsSentence,
            // Qualitative multi-match direction (no numbers) — speakable as-is and
            // safe to pass: it quotes no altered Leetify value (see leetify.ts).
            trend: stats.trend,
          })
        : null) ??
      // Canned fallback gets the trend tacked on too, so an LLM-less setup still
      // mentions the multi-match direction when Leetify gave us one.
      leetifyRecapLine(ctx.map, statsSentence) + (stats.trend ? " " + stats.trend : "");
    // The LLM call can take 20+ seconds — the next match may have gone live.
    if (!(await hold())) {
      log.info("leetify", "Quiet moment passed while writing the recap — dropping it");
      return;
    }
    // redactText: the spoken line carries Leetify's numbers, and their
    // guidelines forbid persisting API data — the voice logs must stay clean.
    voice.say({
      text,
      priority: 1,
      maxAgeMs: 60_000,
      category: "leetify",
      eventAt: Date.now(),
      stillRelevant: canSpeak,
      redactText: true,
    });
  };

  const engine = new CoachEngine((req) => voice.say(req), llm, {
    getCtx: fullContext,
    payloadAgeMs: () => roster.lastUpdateAgeMs(),
    lastOwnKillAt: () => roster.lastOwnKillAtMs(),
    ownRoundKills: () => roster.ownRoundKillsNow(),
    fullHistory: () => roster.fullHistory(),
    recentForm: () => sessions.recentForm(roster.context().map),
    finalStats: () => roster.matchReport().stats,
    isQuiet: () => quiet.on,
    // The session focus the player set with /coach goal — read at the moments
    // where the engine snapshots context, not every frame.
    currentGoal: () => goalStore.get(),
    // Every decided line (LLM or fallback) lands in the decision log when it's
    // enabled; left undefined otherwise so the engine skips the call entirely.
    onDecision: decisionLog ? (rec) => decisionLog.write(rec) : undefined,
    onMatchEnd: (event, ctx) => {
      handleMatchEnd(event, ctx).catch((err) => log.error("coach", "Post-match handling failed", err));
    },
  });

  // Raw GSI capture for offline analysis — what does the game actually send,
  // and which events did the tracker derive from each frame?
  const payloadLog = config.gsi.logPayloads ? new GsiPayloadLog() : null;

  const gsi = startGsiServer({
    port: config.gsi.port,
    token: config.gsi.token,
    onPayload: (payload) => {
      // Demux + fuse: one handle() call per payload (same-batch suppression
      // semantics preserved), with the merged primary-personal + authority-global
      // + team context.
      const { events, ctx } = roster.update(payload);
      payloadLog?.write(payload, events);
      if (events.length > 0) {
        log.info("gsi", `Events: ${events.map((e) => e.type).join(", ")}`);
        engine.handle(events, withNickname(ctx));
      }
    },
  });

  const client = await startBot({
    token: config.discord.token,
    guildId: config.discord.guildId,
    voice,
    quiet: {
      get: () => quiet.on,
      set: (on) => {
        quiet.on = on;
        // Muting mid-sentence should actually shut the coach up, not just
        // stop the NEXT line — flush the queue and cut the current one off.
        if (on) voice.clearCoachLines();
        log.info("main", on ? "Coach muted via /coach quiet" : "Coach unmuted");
      },
    },
    // The /coach goal (and /focus) focus the player set — persisted across restarts.
    goal: {
      get: () => goalStore.get(),
      set: (g) => goalStore.set(g),
    },
    // /coach lastmatch — one snide spoken sentence built from the recorded history.
    lastMatchSummary: () => buildLastMatchSummary(sessions.lastMatch()),
    status: () => ({
      gsiAgeMs: gsi.lastPayloadAgeMs(),
      ttsProviders: tts.activeNames,
      llmModel: llm ? `${config.llm.model} (mid-round: ${config.llm.fastModel})` : null,
      sessionsOnFile: sessions.count,
      wiredFeeds: roster.wiredCount(),
    }),
  });

  // DAVE smoke-check: @discordjs/voice pulls native (sodium / opus) prebuilds,
  // and a missing musl build on the Alpine droplet would otherwise fail SILENTLY
  // — the coach connects to voice but never makes a sound. Import it once at
  // startup so a broken install surfaces LOUDLY in the logs. Best-effort and
  // wrapped so it can NEVER take the process down.
  try {
    await import("@discordjs/voice");
    log.info("main", "Voice (DAVE) library loaded");
  } catch (err) {
    log.warn("main", `Voice (DAVE) library failed to load — voice will be mute: ${err instanceof Error ? err.message : err}`);
  }

  // After a restart (redeploy, crash, droplet reboot), put the coach back into
  // its last voice channel — otherwise every auto-deploy strands it outside.
  const saved = loadVoiceChannel();
  if (saved) {
    if (!client.isReady()) {
      await new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
    }
    try {
      const channel = await client.channels.fetch(saved.channelId);
      if (channel?.isVoiceBased()) {
        await voice.join(channel);
        log.info("main", `Rejoined voice channel "${channel.name}" after restart`);
      } else {
        clearVoiceChannel(); // channel no longer exists — stop trying
      }
    } catch (err) {
      log.warn("main", `Could not rejoin last voice channel: ${err instanceof Error ? err.message : err}`);
    }
  }

  log.info("main", "Ready. Use /coach join in Discord, then start a CS2 match.");
}

// Safety nets: a stray rejection from a third-party stream/socket must not kill
// the coach mid-match.
process.on("unhandledRejection", (reason) => {
  log.error("main", "Unhandled promise rejection", reason);
});
process.on("uncaughtException", (err) => {
  log.error("main", "Uncaught exception — exiting", err);
  process.exit(1);
});

main().catch((err) => {
  log.error("main", "Fatal startup error", err);
  process.exit(1);
});

