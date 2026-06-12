import os from "node:os";
import { Events, type Client } from "discord.js";
import { config } from "./config.js";
import { log } from "./log.js";
import { startGsiServer } from "./gsi/server.js";
import { GsiPayloadLog } from "./gsi/payload-log.js";
import { GsiTracker, type CoachEvent, type MatchContext } from "./gsi/tracker.js";
import { CoachEngine } from "./coach/engine.js";
import { LlmCoach } from "./coach/llm.js";
import { SessionStore } from "./coach/session-store.js";
import { buildDebriefData, buildMatchRecord, scorecardText } from "./coach/debrief.js";
import { LeetifyClient, pollForLeetifyStats } from "./leetify.js";
import { TtsChain } from "./tts/index.js";
import { VoiceCoach } from "./discord/voice.js";
import { postDebrief, postLeetifyFollowup, startBot } from "./discord/bot.js";
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

  // Assigned after startBot below; matchEnd can only fire once the bot is up.
  let client: Client | undefined;

  // Session recording + the text debrief + the Leetify follow-up. Runs on its
  // own (the voice wrap-up line goes out in parallel); latency doesn't matter.
  const handleMatchEnd = async (event: Extract<CoachEvent, { type: "matchEnd" }>, ctx: MatchContext) => {
    const report = tracker.matchReport();
    // Snapshot the PAST-sessions form before recording this match into the store.
    const pastForm = sessions.recentForm(ctx.map);
    const record = buildMatchRecord(event, ctx, report);
    sessions.record(record);

    if (!config.debrief.enabled || !client) return;
    const channelId = config.debrief.channelId ?? loadVoiceChannel()?.channelId;
    if (!channelId) {
      log.info("debrief", "No channel to post the debrief to — set COACH_DEBRIEF_CHANNEL_ID or use /coach join once");
      return;
    }

    const data = buildDebriefData(record);
    if (llm) {
      data.coachNotes =
        (await llm.debrief({
          scorecard: scorecardText(data),
          history: tracker.fullHistory(),
          notables: report.notables,
          recentForm: pastForm,
        })) ?? undefined;
    }
    const message = await postDebrief(client, channelId, data);

    // Leetify parses the demo server-side — poll until the match appears
    // (usually 5-15 min), then reply to the debrief with their numbers.
    const steam64 = tracker.steamId();
    const since = tracker.matchStartedAtMs();
    if (message && config.leetify.enabled && steam64 && since) {
      const stats = await pollForLeetifyStats(new LeetifyClient(config.leetify.apiKey), steam64, since, ctx.map);
      if (stats) await postLeetifyFollowup(message, stats);
    }
  };

  const engine = new CoachEngine((req) => voice.say(req), llm, {
    getCtx: fullContext,
    payloadAgeMs: () => tracker.lastUpdateAgeMs(),
    lastOwnKillAt: () => tracker.lastOwnKillAtMs(),
    ownRoundKills: () => tracker.ownRoundKillsNow(),
    fullHistory: () => tracker.fullHistory(),
    recentForm: () => sessions.recentForm(tracker.context().map),
    isQuiet: () => quiet.on,
    onMatchEnd: (event, ctx) => {
      handleMatchEnd(event, ctx).catch((err) => log.error("debrief", "Post-match handling failed", err));
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

  client = await startBot({
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

