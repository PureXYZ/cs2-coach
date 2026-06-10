import { config } from "./config.js";
import { log } from "./log.js";
import { startGsiServer } from "./gsi/server.js";
import { GsiPayloadLog } from "./gsi/payload-log.js";
import { GsiTracker } from "./gsi/tracker.js";
import { CoachEngine } from "./coach/engine.js";
import { LlmCoach } from "./coach/llm.js";
import { TtsChain } from "./tts/index.js";
import { VoiceCoach } from "./discord/voice.js";
import { startBot } from "./discord/bot.js";

async function main(): Promise<void> {
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

  // Tracker context + the preferred spoken name for the player.
  const fullContext = () => {
    const ctx = tracker.context();
    return { ...ctx, playerName: config.coach.playerNickname ?? ctx.playerName };
  };

  const engine = new CoachEngine((req) => voice.say(req), llm, fullContext, () => tracker.lastUpdateAgeMs());

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

  await startBot({
    token: config.discord.token,
    guildId: config.discord.guildId,
    voice,
    status: () => ({
      gsiAgeMs: gsi.lastPayloadAgeMs(),
      ttsProviders: tts.activeNames,
      llmModel: llm ? `${config.llm.model} (mid-round: ${config.llm.fastModel})` : null,
    }),
  });

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

