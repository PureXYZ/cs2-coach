import os from "node:os";
import { Events } from "discord.js";
import { config, STEAMID64_RE } from "./config.js";
import { runtime } from "./runtime-overrides.js";
import { log, pruneOldLogs, closeLog } from "./log.js";
import { LinkStore, DISCORD_ID_RE } from "./links.js";
import { startGsiServer } from "./gsi/server.js";
import { GsiPayloadLog } from "./gsi/payload-log.js";
import type { CoachEvent, MatchContext } from "./gsi/tracker.js";
import { RosterManager } from "./gsi/roster.js";
import { CoachEngine } from "./coach/engine.js";
import { LlmCoach } from "./coach/llm.js";
import { SessionStore } from "./coach/session-store.js";
import { DecisionLog } from "./coach/decision-log.js";
import { buildMatchRecord } from "./coach/debrief.js";
import { leetifyRecapLine } from "./coach/lines.js";
import {
  LeetifyClient,
  pollForLeetifyStats,
  pollForSquadLeetifyStats,
  spokenStatsSentence,
  spokenSquadSentence,
  type LeetifyStartBrief,
} from "./leetify.js";
import { TtsChain } from "./tts/index.js";
import { currentVoice, voices } from "./tts/voices.js";
import { VoiceCoach } from "./discord/voice.js";
import { startBot } from "./discord/bot.js";
import { buildSettingsControl } from "./discord/admin-settings.js";
import { clearVoiceChannel, loadVoiceChannel } from "./discord/voice-state.js";

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

  // Optional offline record of every decided line (COACH_LOG_DECISIONS) — what
  // the coach saw and chose to say, for after-the-fact study. Off by default.
  const decisionLog = config.coach.logDecisions ? new DecisionLog() : null;

  const tts = new TtsChain();
  // Resolve + log the active ElevenLabs voice once at startup (this also fires
  // any ELEVENLABS_VOICE_ID deprecation notice). Only meaningful when ElevenLabs
  // is actually in the chain — voice switching is its feature alone.
  if (tts.activeNames.includes("elevenlabs")) {
    log.info("main", `ElevenLabs voice: ${currentVoice().label} (${voices().length} selectable via /coach voice)`);
  }
  const voice = new VoiceCoach(tts, config.voice.volume);

  // Prewarm the static-line audio cache in the background so even the FIRST occurrence
  // of a latency-critical line (the 10s bomb-timer, late-round, etc.) plays instantly.
  // Fire-and-forget — it must never block startup, and it yields while the voice queue
  // is busy so it can't starve a live coaching line.
  if (config.tts.cache.enabled && config.tts.cache.prewarm) {
    void tts
      .prewarm(
        voices().map((v) => v.voiceId),
        { busy: () => voice.queueLength > 0 || voice.songActive },
      )
      .then((r) =>
        log.info("main", `TTS cache prewarm done: ${r.cached} synthesized, ${r.skipped} already cached, ${r.failed} failed`),
      )
      .catch((err) => log.warn("main", `TTS cache prewarm error: ${err instanceof Error ? err.message : err}`));
  }

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

  // SteamID64 <-> Discord-user pairings (state/ volume). Populated for free from the
  // auth.discordId that /coach setup bakes into each friend's cfg — CS2 echoes it
  // back in every payload next to provider.steamid. See the onPayload capture below.
  const links = new LinkStore();
  log.info("main", `Account links: ${links.size} Steam↔Discord pairing(s) on file`);

  // Owner-only admin surface (/coachadmin): on only when both ids are set.
  log.info(
    "main",
    config.discord.ownerId && config.discord.adminGuildId
      ? `Owner admin surface enabled (/coachadmin in guild ${config.discord.adminGuildId})`
      : "Owner admin surface disabled (set COACH_OWNER_ID + COACH_ADMIN_GUILD_ID to enable)",
  );

  // Cross-session match history (state/ volume) — what lets the coach remember
  // last night's pistols. Written at every matchEnd, read into smart prompts.
  const sessions = new SessionStore();
  log.info("main", `Session memory: ${sessions.count} past match(es) on file`);

  // /coach mute's shared flag: the engine checks it (skipping lines AND LLM
  // spend); the bot toggles it and flushes anything already queued or speaking.
  // Session-scoped on purpose — the bot resets it to speaking whenever the coach
  // joins or leaves a channel (so it also starts false on boot), so a forgotten
  // mute can't silently follow you into the next session.
  const quiet = { on: false };

  // Apply the preferred spoken name for the (primary) player to a context.
  const withNickname = (ctx: MatchContext): MatchContext => ({
    ...ctx,
    playerName: runtime.nickname ?? ctx.playerName,
  });
  const fullContext = () => withNickname(roster.context());

  // Only the newest match's recap may speak — back-to-back games would
  // otherwise stack hour-long holds that all fire into the same quiet moment.
  let recapSeq = 0;
  // Idempotency for matchEnd: a multi-feed authority re-election across the gameover
  // seam can forward a SECOND matchEnd for the same game (the content-signature seam
  // de-dup only covers a few seconds). Without this guard that would write a duplicate
  // session record (corrupting cross-session form) and start a second hour-long Leetify
  // poll. Keyed on map+score; a genuinely new match with the same score inside 5 min is
  // impossible (a match runs 30+ min).
  let lastMatchEndKey: string | null = null;
  let lastMatchEndAt = 0;

  // Session recording + the spoken Leetify recap. Runs on its own (the voice
  // wrap-up speech goes out via the engine in parallel); latency is free here.
  const handleMatchEnd = async (event: Extract<CoachEvent, { type: "matchEnd" }>, ctx: MatchContext) => {
    // Captured at the gameover frame — the Leetify lookup matches finished_at
    // against this instant (±10 min) to identify the right game.
    const endedAt = Date.now();
    // Drop a duplicate matchEnd for the SAME game (multi-feed re-election seam) before
    // it double-records the session or starts a second Leetify poll.
    const matchKey = `${ctx.map ?? "?"}:${event.ourScore}-${event.theirScore}`;
    if (lastMatchEndKey === matchKey && endedAt - lastMatchEndAt < 5 * 60_000) {
      log.info("sessions", "Duplicate matchEnd for the same game — already handled, skipping");
      return;
    }
    lastMatchEndKey = matchKey;
    lastMatchEndAt = endedAt;
    const recapToken = ++recapSeq;
    const report = roster.matchReport();
    // The confirmed wired crew, snapshotted SYNCHRONOUSLY now — confirmedEver is
    // wiped by the next match's start and feeds idle out during the long Leetify
    // poll below. Feeds both the session squad-tag and the squad recap.
    const squad = roster.confirmedSquad();
    const friendNames = squad.filter((m) => !m.isPrimary && m.name).map((m) => m.name as string);

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
    const record = buildMatchRecord(event, ctx, report, friendNames);
    sessions.record(record);

    const steam64 = roster.steamId();
    if (!config.leetify.enabled || !steam64) return;

    // Squad recap: when friends are wired and team tactics are on, keep the
    // per-match rows Leetify already returns for the whole crew (squad captured
    // synchronously above).
    const wantSquad =
      runtime.squadRecap !== "off" && runtime.teamTactics && squad.some((m) => !m.isPrimary);
    const client = new LeetifyClient(config.leetify.apiKey);
    const squadStats = wantSquad ? await pollForSquadLeetifyStats(client, squad, endedAt, ctx.map) : null;
    // Solo path is the default; a squad match-find failing means the primary's
    // match never appeared, so don't re-poll the solo lookup for another hour.
    const soloStats = wantSquad ? null : await pollForLeetifyStats(client, steam64, endedAt, ctx.map);
    if (!squadStats && !soloStats) return;

    // NEVER talk over play OR over a song: the numbers land 5-15+ minutes after
    // the match, which can be mid-way through the next one (or a /coach song the
    // user kicked off for fun). Hold for a quiet moment — between games, warmup,
    // menu, game closed, AND no song occupying the player — re-check around the
    // slow LLM call, and keep the same guard live in the voice queue so it's
    // re-verified right before synthesis AND right before playback. Without the
    // songActive gate the recap would queue behind the song and silently age out
    // (maxAgeMs), or get wiped when playFile() clears the coach queue.
    const deadline = Date.now() + 60 * 60_000;
    const canSpeak = () =>
      !quiet.on &&
      voice.connected &&
      !voice.songActive &&
      roster.quietMomentForSpeech() &&
      recapToken === recapSeq;
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

    const stats = squadStats ? squadStats.me : soloStats!;
    const statsSentence = spokenStatsSentence(stats);
    if (!statsSentence) return;
    const squadSentence = squadStats
      ? spokenSquadSentence(squadStats, runtime.squadRecap === "full" ? "full" : "leaders") ?? undefined
      : undefined;
    const llmText = llm
      ? await llm.leetifyLine({
          map: ctx.map,
          won: event.won,
          ourScore: event.ourScore,
          theirScore: event.theirScore,
          statsSentence,
          squadSentence,
          // Qualitative multi-match direction (no numbers) — speakable as-is and
          // safe to pass: it quotes no altered Leetify value (see leetify.ts).
          trend: stats.trend,
        })
      : null;
    const text =
      llmText ??
      // Canned fallback gets the squad comparison AND the trend tacked on too, so an
      // LLM-less setup still covers the crew and the multi-match direction.
      leetifyRecapLine(ctx.map, statsSentence, squadSentence) + (stats.trend ? " " + stats.trend : "");
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
      // Commit the recap to the LLM's anti-repeat memory only when it actually
      // AIRS (a held-then-dropped recap shouldn't poison future variety), and
      // only for the LLM-produced line — never the canned fallback.
      onPlayed: () => {
        if (llmText) llm?.recordSpoken(text);
      },
    });
    // Record the recap in the decision log too (redacted — length only), so the
    // offline "what did it say" trace isn't missing post-match recaps. This path
    // bypasses the engine, so the engine's onDecision hook never sees it.
    decisionLog?.write({ snapshot: ctx, event, tier: "smart", text, source: llmText ? "llm" : "fallback", redact: true });
  };

  // Leetify pre-match brief (map form / recency / aim trend) for the warmup + match-start
  // lines. Keyed on the PRIMARY account (roster.steamId()); when friends are wired and team
  // tactics are on, it ALSO pulls a one-line form clause for each connected crew member
  // (squadStartBrief), so the coach can fold the whole crew into the scouting read. One
  // /v3/profile fetch per member (parallel), cached per map with a short TTL so warmup +
  // round 1 share the round-trip while a later requeue refetches fresh. Best-effort: any
  // failure resolves undefined so the greeting stays plain. Qualitative, spoken once, never stored.
  const startBriefTtlMs = 2 * 60_000;
  const startBriefCache = new Map<string, { at: number; p: Promise<LeetifyStartBrief | null | undefined> }>();
  const leetifyStartBrief =
    config.leetify.enabled && config.leetify.matchStart
      ? (map: string): Promise<LeetifyStartBrief | undefined> => {
          const steam64 = roster.steamId();
          if (!steam64) return Promise.resolve(undefined); // primary not bound (friend-only / pre-bind)
          const key = `${steam64}:${map}`;
          const now = Date.now();
          let entry = startBriefCache.get(key);
          if (!entry || now - entry.at > startBriefTtlMs) {
            const client = new LeetifyClient(config.leetify.apiKey);
            // Snapshot the connected crew now; with 2+ wired (and team tactics on) pull the
            // whole crew's form, else just the primary's.
            const crew = runtime.teamTactics ? roster.connectedSquad() : [];
            const hasFriends = crew.some((m) => !m.isPrimary && m.name);
            const p = (hasFriends ? client.squadStartBrief(crew, map) : client.startBrief(steam64, map)).catch((err) => {
              log.warn("leetify", `Match-start brief failed (${err instanceof Error ? err.message : err}) — plain greeting`);
              return undefined;
            });
            entry = { at: now, p };
            startBriefCache.set(key, entry);
          }
          return entry.p.then((b) => b ?? undefined);
        }
      : undefined;

  const engine = new CoachEngine((req) => voice.say(req), llm, {
    getCtx: fullContext,
    payloadAgeMs: () => roster.lastUpdateAgeMs(),
    lastOwnKillAt: () => roster.lastOwnKillAtMs(),
    ownRoundKills: () => roster.ownRoundKillsNow(),
    // True in-game start instants (authority feed) — clock callouts schedule off these
    // so GSI buffering / the ~1-2s Valve plant delay don't make them land late.
    roundLiveAt: () => roster.roundLiveAtMs(),
    bombPlantedAt: () => roster.bombPlantedAtMs(),
    fullHistory: () => roster.fullHistory(),
    leetifyStartBrief,
    recentForm: (opts) => sessions.recentForm(roster.context().map, opts),
    finalStats: () => roster.matchReport().stats,
    isQuiet: () => quiet.on,
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
      // Pair this feed's SteamID64 with the Discord user who installed its cfg, when
      // /coach setup embedded their id in the auth block (CS2 echoes every auth key
      // back). Done here, not in the roster — the roster is a pure in-memory fusion
      // engine with no I/O, and persistence belongs in this orchestration layer next
      // to the payload log. record() only writes to disk when the pairing changes.
      const steam64 = payload.provider?.steamid;
      const discordId = payload.auth?.discordId;
      if (steam64 && discordId && STEAMID64_RE.test(steam64) && DISCORD_ID_RE.test(discordId)) {
        // Steam name only off the client's OWN-player frame (it switches to the
        // spectated teammate after death) — mirrors the tracker's own-name rule.
        const ownName = payload.player?.steamid === steam64 ? payload.player?.name : undefined;
        if (links.record(steam64, discordId, ownName)) {
          log.info("links", `Linked Steam ${steam64}${ownName ? ` (${ownName})` : ""} ↔ Discord ${discordId}`);
        }
      }

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
        log.info("main", on ? "Coach muted via /coach mute" : "Coach unmuted");
      },
    },
    // /coach setup builds the friend's cfg from these — the same public address
    // and token `npm run cfg` uses, so the file is identical either way.
    cfg: { publicHost: config.coach.publicHost, token: config.gsi.token, port: config.gsi.port },
    ttsProviders: () => tts.activeNames,
    // Owner-only admin surface: enabled only when BOTH ids are configured (otherwise the
    // /coachadmin command is never registered and any invocation is rejected).
    admin:
      config.discord.ownerId && config.discord.adminGuildId
        ? { ownerId: config.discord.ownerId, guildId: config.discord.adminGuildId }
        : undefined,
    links: {
      list: () => links.list(),
      get: (steam64) => links.linkFor(steam64),
      set: (steam64, discordId) => {
        links.record(steam64, discordId);
      },
      remove: (steam64) => links.remove(steam64),
      removeAllForDiscord: (discordId) => links.removeAllForDiscord(discordId),
    },
    // Cross-reference each feed's SteamID64 against the link store here (the roster is a
    // pure GSI fusion engine with no knowledge of Discord links).
    feedsDetailed: () => roster.feedsDetailed().map((f) => ({ ...f, discordId: links.discordIdFor(f.steam64) })),
    // Owner-only live settings (/coachadmin set / settings). Session-scoped: the runtime
    // overrides reset to the env defaults on restart.
    settings: buildSettingsControl({ llm, voice }),
    sessions: {
      count: () => sessions.count,
      recent: (n) => sessions.recent(n),
      clear: () => sessions.clear(),
      deleteByEndedAt: (ms) => sessions.deleteByEndedAt(ms) ?? null,
    },
    tts: {
      cacheStats: () => tts.cacheStats(),
      clearCache: () => tts.clearCache(),
      // Fire-and-forget, mirroring the startup prewarm: skips already-cached lines and
      // yields while a live coach line is speaking so it never competes for the provider.
      prewarm: () => {
        void tts
          .prewarm(
            voices().map((v) => v.voiceId),
            { busy: () => voice.queueLength > 0 || voice.songActive },
          )
          .then((r) => log.info("main", `TTS cache re-prewarm done: ${r.cached} synthesized, ${r.skipped} already cached, ${r.failed} failed`))
          .catch((err) => log.warn("main", `TTS cache re-prewarm error: ${err instanceof Error ? err.message : err}`));
      },
    },
    status: () => ({
      gsiAgeMs: gsi.lastPayloadAgeMs(),
      ttsProviders: tts.activeNames,
      // Live values (the owner can swap the model via /coachadmin set) so the public
      // status never shows a stale boot-time model after a runtime change.
      llmModel: llm ? `${llm.currentModel} (mid-round: ${llm.currentFastModel})` : null,
      sessionsOnFile: sessions.count,
      wiredFeeds: roster.wiredCount(),
      connectedFeeds: roster.connectedFeeds(),
      squadSize: roster.squadSize(),
      primaryMode: !config.coach.primarySteam64
        ? ("solo" as const)
        : roster.primaryEverSeenThisMatch()
          ? ("present" as const)
          : ("friend-only" as const),
      quarantined: roster.quarantinedFeeds(),
      linkedAccounts: links.size,
    }),
  });

  // Graceful teardown for a normal redeploy (SIGTERM) or Ctrl-C (SIGINT): a hard
  // kill would otherwise strand the GSI port, the voice connection and the
  // Discord gateway socket. Each teardown is wrapped so one failure doesn't block
  // the others, and the flag makes it idempotent against a double signal.
  let shuttingDown = false;
  const shutdown = async (signal: string, code = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("main", `Received ${signal} — shutting down`);
    try {
      gsi.server.close();
    } catch (err) {
      log.error("main", "Error closing GSI server", err);
    }
    try {
      voice.leave();
    } catch (err) {
      log.error("main", "Error leaving voice", err);
    }
    try {
      client.destroy();
    } catch (err) {
      log.error("main", "Error destroying Discord client", err);
    }
    // Flush + close the on-disk sinks so the final frames/decisions/log lines are
    // written before exit (a redeploy SIGTERM is exactly when the last frames matter).
    // allSettled never rejects, so one stuck stream can't block the others.
    await Promise.allSettled([
      payloadLog?.close() ?? Promise.resolve(),
      decisionLog?.close() ?? Promise.resolve(),
      closeLog(),
    ]);
    // Give the async log sink a final beat to flush before the process dies.
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.exit(code);
  };
  activeShutdown = shutdown;
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // DAVE smoke-check: @discordjs/voice pulls native (sodium / opus) prebuilds,
  // and a missing musl build on the Alpine droplet would otherwise fail SILENTLY
  // — the coach connects to voice but never makes a sound. Import it once at
  // startup so a broken install surfaces LOUDLY in the logs. Best-effort and
  // wrapped so it can NEVER take the process down.
  try {
    const { generateDependencyReport } = await import("@discordjs/voice");
    log.info("main", "Voice (DAVE) library loaded");

    // Inline-volume readiness: a non-unity COACH_VOLUME or any per-voice volume routes
    // coach lines through @discordjs/voice's inline volume — ffmpeg decodes the Opus and
    // opusscript re-encodes it. A missing ffmpeg fails PER-LINE at playtime with
    // "FFmpeg/avconv not found!" and nothing at startup — exactly how a prior deploy broke.
    // So when a gain is configured, check ffmpeg up front and fail LOUD if it's absent.
    const gainConfigured =
      config.voice.volume !== 1 || voices().some((v) => v.volume !== undefined && v.volume !== 1);
    if (gainConfigured) {
      const report = generateDependencyReport();
      if (report.includes("FFmpeg\n- not found")) {
        log.error(
          "main",
          `A non-unity playback gain is configured but FFmpeg is not on PATH — coach lines will ` +
            `FAIL at playtime with "FFmpeg/avconv not found!". The Docker image bundles ffmpeg; ` +
            `to run locally install it (winget install Gyan.FFmpeg / apt install ffmpeg).\n${report}`,
        );
      } else {
        log.info("main", "FFmpeg present for the inline-volume (per-voice gain) path");
      }
    }
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

// Wired up inside main() once gsi/voice/client exist; until then a fatal fault
// can only do the bare exit below (nothing constructed yet to tear down).
let activeShutdown: ((signal: string, code?: number) => Promise<void>) | null = null;

// Safety nets: a stray rejection from a third-party stream/socket must not kill
// the coach mid-match.
process.on("unhandledRejection", (reason) => {
  log.error("main", "Unhandled promise rejection", reason);
});
process.on("uncaughtException", (err) => {
  log.error("main", "Uncaught exception — exiting", err);
  // Route through the same teardown as a redeploy so the HTTP server, voice
  // connection and Discord client are closed before we go (exit code 1).
  if (activeShutdown) void activeShutdown("uncaughtException", 1);
  else process.exit(1);
});

main().catch((err) => {
  log.error("main", "Fatal startup error", err);
  process.exit(1);
});

