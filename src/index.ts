import os from "node:os";
import { Events } from "discord.js";
import { config } from "./config.js";
import { log } from "./log.js";
import { startGsiServer } from "./gsi/server.js";
import { GsiPayloadLog } from "./gsi/payload-log.js";
import { GsiTracker, type CoachEvent, type MatchContext } from "./gsi/tracker.js";
import { CoachEngine } from "./coach/engine.js";
import { LlmCoach } from "./coach/llm.js";
import { SessionStore } from "./coach/session-store.js";
import { buildMatchRecord } from "./coach/debrief.js";
import { leetifyRecapLine } from "./coach/lines.js";
import { LeetifyClient, pollForLeetifyStats, spokenStatsSentence } from "./leetify.js";
import { TtsChain } from "./tts/index.js";
import { VoiceCoach } from "./discord/voice.js";
import { startBot } from "./discord/bot.js";
import { clearVoiceChannel, loadVoiceChannel } from "./discord/voice-state.js";

async function main(): Promise<void> {
  // The coach often shares the PC with CS2 — make sure it never wins a CPU
  // scheduling fight against the game. Harmless on a dedicated (cloud) host.
  try {
    os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Couldn't lower priority (exotic sandbox?) — normal priority is fine too.
  }

  // Keep the session's console output on disk next to the GSI capture — spoken
  // lines, drops and LLM/TTS latencies are otherwise lost when the window closes.
  log.toFile();
  log.info("main", "CS2 Coach starting up");

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

  const tracker = new GsiTracker();

  // Cross-session match history (state/ volume) — what lets the coach remember
  // last night's pistols. Written at every matchEnd, read into smart prompts.
  const sessions = new SessionStore();
  log.info("main", `Session memory: ${sessions.count} past match(es) on file`);

  // /coach quiet's shared flag: the engine checks it (skipping lines AND LLM
  // spend); the bot toggles it and flushes anything already queued or speaking.
  const quiet = { on: false };

  // Tracker context + the preferred spoken name for the player.
  const fullContext = () => {
    const ctx = tracker.context();
    return { ...ctx, playerName: config.coach.playerNickname ?? ctx.playerName };
  };

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
    const report = tracker.matchReport();

    // Only real matchmaking games belong in the cross-session history the
    // recap lines are built from. Premier and competitive both report mode
    // "competitive" — and so do bot matches, which is what the spectated-bot
    // flag is for. Practice games also never reach Leetify (no demo), so the
    // recap poll is skipped along with the record.
    if (report.botsDetected || ctx.mode !== "competitive") {
      const why = report.botsDetected ? "bots detected" : `mode ${ctx.mode ?? "unknown"}`;
      log.info("sessions", `Practice match (${why}) — not recording it`);
      return;
    }
    const record = buildMatchRecord(event, ctx, report);
    sessions.record(record);

    const steam64 = tracker.steamId();
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
      !quiet.on && voice.connected && tracker.quietMomentForSpeech() && recapToken === recapSeq;
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
          })
        : null) ?? leetifyRecapLine(ctx.map, statsSentence);
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
    payloadAgeMs: () => tracker.lastUpdateAgeMs(),
    lastOwnKillAt: () => tracker.lastOwnKillAtMs(),
    ownRoundKills: () => tracker.ownRoundKillsNow(),
    fullHistory: () => tracker.fullHistory(),
    recentForm: () => sessions.recentForm(tracker.context().map),
    finalStats: () => tracker.matchReport().stats,
    isQuiet: () => quiet.on,
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
      const events = tracker.update(payload);
      payloadLog?.write(payload, events);
      if (events.length > 0) {
        log.info("gsi", `Events: ${events.map((e) => e.type).join(", ")}`);
        engine.handle(events, fullContext());
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
    status: () => ({
      gsiAgeMs: gsi.lastPayloadAgeMs(),
      ttsProviders: tts.activeNames,
      llmModel: llm ? `${config.llm.model} (mid-round: ${config.llm.fastModel})` : null,
      sessionsOnFile: sessions.count,
    }),
  });

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

