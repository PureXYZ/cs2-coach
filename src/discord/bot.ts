import { existsSync } from "node:fs";
import path from "node:path";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  GuildMember,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from "discord.js";
import { log } from "../log.js";
import { buildCfg, resolveUri } from "../gsi/cfg.js";
import { currentVoice, findVoice, setVoice, voices } from "../tts/voices.js";
import type { VoiceCoach } from "./voice.js";
import { clearVoiceChannel, saveVoiceChannel } from "./voice-state.js";

export interface BotDeps {
  token: string;
  guildId?: string;
  voice: VoiceCoach;
  /** /coach quiet's flag — owned by index.ts so the engine shares it. */
  quiet: { get: () => boolean; set: (on: boolean) => void };
  /** Inputs for /coach setup — builds the GSI cfg handed to a friend. A falsy
   *  publicHost disables the command (the container can't self-detect its public
   *  address; emitting a Docker-bridge IP would be confidently wrong). */
  cfg: { publicHost?: string; token: string; port: number };
  /** The active TTS provider chain (newest config), so `/coach voice` can warn
   *  when ElevenLabs — the only provider voice switching affects — isn't in it. */
  ttsProviders: () => string[];
  status: () => {
    gsiAgeMs: number | null;
    ttsProviders: string[];
    llmModel: string | null;
    sessionsOnFile: number;
    /** How many CONFIRMED teammate feeds (same match + side) are wired in. */
    wiredFeeds: number;
    /** Every feed POSTing right now (raw presence), newest first — the honest
     *  "is your CS2 talking to the coach?" signal for a friend confirming setup. */
    connectedFeeds: { name: string; ageMs: number }[];
    /** Effective squad size from COACH_SQUAD_SIZE (undefined => always hedge). */
    squadSize: number | undefined;
    /** Ops ITEM 14: whether the configured primary has connected a feed this match. */
    primaryMode: "present" | "friend-only" | "solo";
    /** Ops ITEM 9: non-member feeds still connected and why — rendered only when non-empty. */
    quarantined: { name?: string; reason: string }[];
  };
}

/** Any interaction we run a coach action from — slash command, button, or select
 *  menu. They all expose .member / .reply / .deferReply / .editReply, so the
 *  shared helpers (join, auto-join, status) work from whichever one fired. */
type ActionInteraction = ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction;

/** One canonical "you need to be in a voice channel" line — referenced by the
 *  auto-join fallbacks so the recovery instruction never drifts between sites. */
const NOT_IN_VC = "Hop into a voice channel first, then try again (or tap the button below once you're in).";

/** The coach's playlist — Ogg/Opus files living in the repo, copied into the Docker
 *  image. Paths resolve from the working directory, which is the project root both
 *  locally and in the container (WORKDIR /app). */
const SONGS = {
  ez4ence: {
    name: "EZ4ENCE",
    file: path.resolve("assets/ez4ence.ogg"),
    reply: "🎵 **EZ4ENCE.** You're welcome.",
  },
  "yi-jian-mei": {
    name: "Xue Hua Piao Piao",
    file: path.resolve("assets/yi-jian-mei.ogg"),
    reply: "🎵 **Yi Jian Mei.** Xue hua piao piao, bei feng xiao xiao.",
  },
  zenzenzense: {
    name: "Zenzenzense",
    file: path.resolve("assets/zenzenzense.ogg"),
    reply: "🎵 **Zenzenzense.** Your anime training arc starts now.",
  },
  "sunshine-rainbow-white-pony": {
    name: "White Pony",
    file: path.resolve("assets/sunshine-rainbow-white-pony.ogg"),
    reply: "🎵 **Sunshine Rainbow White Pony.** Don't ask.",
  },
} satisfies Record<string, { name: string; file: string; reply: string }>;

/** One button per song, chunked into rows of five (Discord's per-row limit). */
function songButtons(): ActionRowBuilder<ButtonBuilder>[] {
  const buttons = Object.entries(SONGS).map(([value, song]) =>
    new ButtonBuilder().setCustomId(`song:${value}`).setLabel(song.name).setStyle(ButtonStyle.Secondary),
  );
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
  }
  return rows;
}

/** Start (or switch to) a song and return the reply line for it. Picking a song
 *  while one plays is fine — playFile() cuts straight over to the new one. */
function startSong(deps: BotDeps, song: (typeof SONGS)[keyof typeof SONGS]): string {
  const switching = deps.voice.songActive;
  deps.voice.playFile(song.file);
  return switching ? `Fine, switching it up. ${song.reply}` : song.reply;
}

/** Discord caps a string option at 25 choices. The registry is normally far
 *  smaller, but a big custom ELEVENLABS_VOICES could exceed it — slice (and warn
 *  once) so command registration never throws. (Label length is validated at
 *  startup in config.ts, so a name can't blow Discord's 100-char choice limit.) */
const MAX_VOICE_CHOICES = 25;
function buildVoiceChoices(): { name: string; value: string }[] {
  const all = voices();
  if (all.length > MAX_VOICE_CHOICES) {
    log.warn("bot", `ELEVENLABS_VOICES has ${all.length} voices — only the first ${MAX_VOICE_CHOICES} are pickable in Discord`);
  }
  return all.slice(0, MAX_VOICE_CHOICES).map((v) => ({ name: v.label, value: v.key }));
}
// Computed once: /coach say, /coach voice and /coach repeat reuse the same choice
// list, so the truncation warning above fires at most once.
const VOICE_CHOICES = buildVoiceChoices();

/** Last text spoken via /coach say, so /coach repeat can re-say it (handy for
 *  A/B-ing voices without retyping). Per-process; resets on redeploy, which is fine
 *  for a throwaway test line. */
let lastSaidText: string | null = null;

const commands = [
  new SlashCommandBuilder()
    .setName("coach")
    .setDescription("CS2 AI coach — run /coach help if it's your first time")
    // Guild-only: every action needs a guild voice channel, and ephemeral replies
    // aren't allowed in DMs — so keep the command out of DMs entirely (matters only
    // when registered globally; guild-scoped registration never shows it in DMs).
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName("help").setDescription("What is this and where do I start?"))
    .addSubcommand((sub) =>
      sub.setName("setup").setDescription("Get connected — DMs you the CS2 config file (no software to install)"),
    )
    .addSubcommand((sub) => sub.setName("join").setDescription("Join your current voice channel"))
    .addSubcommand((sub) => sub.setName("leave").setDescription("Leave the voice channel"))
    .addSubcommand((sub) =>
      sub
        .setName("say")
        .setDescription("Make the coach say something (test — auto-joins your channel)")
        .addStringOption((opt) => opt.setName("text").setDescription("What to say").setRequired(true))
        .addStringOption((opt) =>
          opt
            .setName("voice")
            .setDescription("Voice for this line only (defaults to the current coach voice)")
            .addChoices(...VOICE_CHOICES),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("repeat")
        .setDescription("Re-say your last /coach say line — handy for A/B-ing voices")
        .addStringOption((opt) =>
          opt
            .setName("voice")
            .setDescription("Voice for this replay (defaults to the current coach voice)")
            .addChoices(...VOICE_CHOICES),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("voice")
        .setDescription("Switch the coach's voice (persists across restarts)")
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("Which voice (leave empty for a clickable picker)")
            .addChoices(...VOICE_CHOICES),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("status")
        .setDescription("Show GSI / voice / TTS status")
        .addBooleanOption((opt) =>
          opt.setName("share").setDescription("Post it publicly so the squad can see (default: only you)"),
        ),
    )
    .addSubcommand((sub) => sub.setName("panel").setDescription("Post a clickable control panel (pin it for one-tap controls)"))
    .addSubcommand((sub) =>
      sub
        .setName("quiet")
        .setDescription("Mute/unmute the coach (game tracking continues)")
        .addStringOption((opt) =>
          opt
            .setName("state")
            .setDescription("on = mute, off = unmute (leave empty to toggle)")
            .addChoices({ name: "on (mute)", value: "on" }, { name: "off (unmute)", value: "off" }),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("song")
        .setDescription("Blast a song in the voice channel")
        .addStringOption((opt) =>
          opt
            .setName("title")
            .setDescription("Which song (leave empty to pick from buttons)")
            .addChoices(...Object.entries(SONGS).map(([value, s]) => ({ name: s.name, value }))),
        ),
    )
    .addSubcommand((sub) => sub.setName("stop-song").setDescription("Stop the song (coaching continues)")),
].map((c) => c.toJSON());

export async function startBot(deps: BotDeps): Promise<Client> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  client.once(Events.ClientReady, async (ready) => {
    log.info("bot", `Logged in as ${ready.user.tag}`);
    try {
      if (deps.guildId) {
        const guild = await ready.guilds.fetch(deps.guildId);
        await guild.commands.set(commands);
        // Clear the global scope — a stale global registration would make every command show up twice.
        await ready.application.commands.set([]);
        log.info("bot", `Slash commands registered in guild ${guild.name}`);
      } else {
        await ready.application.commands.set(commands);
        // Clear per-guild registrations left over from runs with DISCORD_GUILD_ID set.
        const guilds = await ready.guilds.fetch();
        for (const ref of guilds.values()) {
          const guild = await ref.fetch();
          await guild.commands.set([]).catch(() => {});
        }
        log.info("bot", "Slash commands registered globally (may take up to an hour to appear)");
      }
    } catch (err) {
      log.error("bot", "Failed to register slash commands", err);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    // Component interactions (buttons, select menus) are routed by customId prefix,
    // mirroring how slash subcommands are switched below.
    if (interaction.isButton()) {
      try {
        await handleButton(interaction, deps);
      } catch (err) {
        log.error("bot", `Button ${interaction.customId} failed`, err);
        await safeComponentError(interaction);
      }
      return;
    }
    if (interaction.isStringSelectMenu()) {
      try {
        if (interaction.customId.startsWith("voice:")) await handleVoiceSelect(interaction, deps);
        else await staleComponentReply(interaction);
      } catch (err) {
        log.error("bot", `Select ${interaction.customId} failed`, err);
        await safeComponentError(interaction);
      }
      return;
    }
    if (!interaction.isChatInputCommand() || interaction.commandName !== "coach") return;
    try {
      await handleCommand(interaction, deps);
    } catch (err) {
      log.error("bot", "Command failed", err);
      const msg = {
        content: "Something broke on my end — try again in a sec, and ping whoever runs the bot if it keeps happening.",
        flags: MessageFlags.Ephemeral as const,
      };
      if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
  });

  await client.login(deps.token);
  return client;
}

// ── shared UI bits ─────────────────────────────────────────────────────────

/** A trailing "you can't actually hear me right now" note for replies that imply
 *  the coach will speak (join, say, test) — silence is otherwise a mystery when
 *  mute is on. Empty when not muted. */
function muteHint(deps: BotDeps): string {
  return deps.quiet.get() ? " — heads up, I'm currently 🔇 muted (`/coach quiet` to unmute)." : "";
}

/** A lone "Join my channel" button — attached to a not-in-a-VC message so the
 *  user can retry in one tap the moment they're actually in a channel (the button
 *  re-reads their voice state at click time). */
function joinButtonRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("fix:join").setLabel("Join my channel").setStyle(ButtonStyle.Primary),
  );
}

/** A "Test the voice" button — attached to the join confirmation so a newcomer
 *  can confirm the coach is audible without inventing a /coach say argument. */
function testButtonRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("test:say").setLabel("Test the voice").setStyle(ButtonStyle.Primary),
  );
}

/** A "Refresh" button — re-renders the status readout in place so the install →
 *  check → wait → check loop is one tap, not a re-typed command. */
function statusRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("status:refresh").setLabel("Refresh").setStyle(ButtonStyle.Secondary),
  );
}

/** The two-row control panel: every common action as a button so non-typers can
 *  drive the coach. Setup is deliberately omitted — it carries the secret token
 *  and must stay in a DM/ephemeral reply. */
function panelRows(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("panel:join").setLabel("Join").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("panel:leave").setLabel("Leave").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("panel:quiet").setLabel("Mute / Unmute").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("panel:status").setLabel("Status").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("panel:song").setLabel("Song").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("panel:stop").setLabel("Stop song").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/** A "Check if it worked" button for the setup flow — shows status without the
 *  user having to switch back and hunt for /coach status. */
function checkButtonRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("status:check").setLabel("Check if it worked").setStyle(ButtonStyle.Primary),
  );
}

/** Mute/unmute reply copy, shared by the slash command and the panel button. */
function quietReply(on: boolean): string {
  return on
    ? "🔇 Coach is muted — still watching the game and keeping score. `/coach quiet` again to unmute."
    : "🎙️ Coach is back on the mic. You asked for this.";
}

function helpText(): string {
  return [
    "**CS2 Coach — quick guide**",
    "",
    "First time? `/coach setup` → drop the file in your CS2 cfg folder → restart CS2 → `/coach status` to confirm you show up under **Feeds**.",
    "",
    "**Get connected:** `/coach setup` (DMs you the config) · `/coach status` (is it working?)",
    "**In the channel:** `/coach join` (I hop into your voice channel) · `/coach leave` · `/coach quiet` (mute/unmute)",
    "**Mess around:** `/coach say <text>` · `/coach voice` (pick my voice) · `/coach song` · `/coach stop-song`",
    "",
    "Hate typing? `/coach panel` posts buttons you can pin and tap instead.",
    "",
    "Once you're connected I read your game on my own — just `/coach join` and play. I'll pipe up when there's something worth saying. Don't hold your breath.",
  ]
    .join("\n")
    .slice(0, 1990);
}

// ── status ───────────────────────────────────────────────────────────────────

/** The full status readout as a string, so it can be served from /coach status,
 *  the panel button, the Refresh button, and the setup "did it work?" button. */
function renderStatus(deps: BotDeps, opts: { share?: boolean } = {}): string {
  const s = deps.status();
  const gsi =
    s.gsiAgeMs === null
      ? "❌ no game state received yet — is CS2 running with the cfg installed? Run `/coach setup` to (re)install it. (New here? `/coach help`.)"
      : s.gsiAgeMs < 60_000
        ? `✅ live (last update ${(s.gsiAgeMs / 1000).toFixed(1)}s ago)`
        : `⚠️ stale (last update ${Math.round(s.gsiAgeMs / 1000)}s ago)`;
  const feeds = s.connectedFeeds;
  // Cap the rendered list — many feeds (misconfig or a token griefer) could otherwise blow past Discord's 2000-char limit.
  const FEED_CAP = 12;
  const feedsLine =
    feeds.length === 0
      ? "no game feeds connected right now — launch CS2 with the cfg installed (`/coach setup`) and you'll show up here"
      : `${feeds.length} connected: ${feeds
          .slice(0, FEED_CAP)
          .map((f) => `**${f.name}** (${Math.max(0, Math.round(f.ageMs / 1000))}s ago)`)
          .join(", ")}${feeds.length > FEED_CAP ? ` +${feeds.length - FEED_CAP} more` : ""}`;
  const squadLine = (() => {
    const base = `${s.wiredFeeds} player feed${s.wiredFeeds === 1 ? "" : "s"} wired in`;
    const sizeNote = s.squadSize !== undefined ? ` of ${s.squadSize}` : " (always hedging — set COACH_SQUAD_SIZE)";
    const mode =
      s.primaryMode === "friend-only"
        ? " — ⚠️ your configured primary hasn't connected this match (recording/Leetify will skip)"
        : s.primaryMode === "solo"
          ? " — no primary configured (adopted the first feed)"
          : "";
    return `**Squad:** ${base}${sizeNote}${s.wiredFeeds > 1 ? " (team coaching live)" : ""}${mode}`;
  })();
  const statusLines = [
    `**GSI:** ${gsi}`,
    `**Voice:** ${deps.voice.connected ? "✅ connected" : "❌ not in a channel"} (queue: ${deps.voice.queueLength})`,
    `**Feeds:** ${feedsLine}`,
    squadLine,
    `**Coach:** ${deps.quiet.get() ? "🔇 muted (\`/coach quiet\` to unmute)" : "🎙️ speaking"}`,
    `**TTS:** ${s.ttsProviders.join(" → ")}`,
    // Show the active voice only when switching is actually set up (more than
    // one voice configured and the switchable-voice provider is in the chain).
    ...(s.ttsProviders.includes("elevenlabs") && voices().length > 1
      ? [`**Coach voice:** ${currentVoice().label}`]
      : []),
    `**LLM:** ${s.llmModel ?? "disabled (rule-based lines only)"}`,
    `**Memory:** ${s.sessionsOnFile} past match${s.sessionsOnFile === 1 ? "" : "es"} on file`,
  ];
  // The Quarantined line names griefer/non-member feeds — fine in a private
  // readout, but skip it when posting publicly with `share`.
  if (!opts.share && s.quarantined.length > 0) {
    const quarantined = s.quarantined;
    statusLines.push(
      `**Quarantined:** ${quarantined
        .slice(0, FEED_CAP)
        .map((q) => `${q.name ?? "unknown feed"} — ${q.reason}`)
        .join("; ")}${quarantined.length > FEED_CAP ? ` +${quarantined.length - FEED_CAP} more` : ""}`,
    );
  }
  // "Connected but can't prove audio reaches the channel" is the one thing status
  // can't check server-side (the DAVE 'connects but silent' case) — nudge the
  // on-demand audible test instead of adding a redundant /coach diagnose command.
  if (deps.voice.connected) {
    statusLines.push("_Can't hear me? Run `/coach say test` to check audio._");
  }
  // Final clamp — never let an unusually long readout throw past Discord's 2000-char limit.
  return statusLines.join("\n").slice(0, 1990);
}

// ── voice (auto-)join ──────────────────────────────────────────────────────

type EnsureResult = { ok: true; joinedName: string | null } | { ok: false };

/** Make sure the coach is in a voice channel for a speak/song action: if already
 *  connected, do nothing (NEVER re-join — VoiceCoach.join() leave()s first, which
 *  would cut live audio); otherwise join the invoker's current channel. The caller
 *  owns the defer/reply, since join() can take up to 20s. */
async function ensureInVoice(interaction: ActionInteraction, deps: BotDeps): Promise<EnsureResult> {
  if (deps.voice.connected) return { ok: true, joinedName: null };
  const member = interaction.member;
  const channel = member instanceof GuildMember ? member.voice.channel : null;
  if (!channel) return { ok: false };
  await deps.voice.join(channel);
  // Remembered across restarts — a redeploy rejoins this channel automatically.
  saveVoiceChannel({ guildId: channel.guild.id, channelId: channel.id });
  return { ok: true, joinedName: channel.name };
}

/** /coach join (and the panel / "Join my channel" buttons). Idempotent and
 *  self-healing: a no-op when already live in the caller's channel (skips the
 *  expensive leave()+rehandshake), a clean reconnect when the connection went
 *  stale, and a move when the caller is somewhere else. Owns its own reply. */
async function joinInvokerChannel(interaction: ActionInteraction, deps: BotDeps): Promise<void> {
  const member = interaction.member;
  const channel = member instanceof GuildMember ? member.voice.channel : null;
  if (!channel) {
    await interaction.reply({ content: NOT_IN_VC, components: [joinButtonRow()], flags: MessageFlags.Ephemeral });
    return;
  }
  const priorChannelId = deps.voice.connectedChannelId;
  // Already live, same channel, healthy — don't tear down a working connection.
  if (deps.voice.connected && priorChannelId === channel.id) {
    await interaction.reply({
      content: `Already live in **${channel.name}** — you're good.${muteHint(deps)}`,
      components: [testButtonRow()],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await deps.voice.join(channel);
  saveVoiceChannel({ guildId: channel.guild.id, channelId: channel.id });
  const msg =
    priorChannelId === channel.id
      ? `🎙️ Reconnected to **${channel.name}**.` // same channel but the connection was stale
      : priorChannelId !== null
        ? `🎙️ Moved to **${channel.name}**.` // was in a different channel
        : `🎙️ Coach is live in **${channel.name}**. Start your match — I'm watching the game state.`;
  await interaction.editReply({ content: msg + muteHint(deps), components: [testButtonRow()] });
}

// ── slash command dispatch ─────────────────────────────────────────────────

async function handleCommand(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
  switch (interaction.options.getSubcommand()) {
    case "help": {
      await interaction.reply({ content: helpText(), flags: MessageFlags.Ephemeral });
      return;
    }

    case "setup": {
      await handleSetup(interaction, deps);
      return;
    }

    case "join": {
      await joinInvokerChannel(interaction, deps);
      return;
    }

    case "leave": {
      deps.voice.leave();
      clearVoiceChannel(); // deliberate leave — don't rejoin after the next restart
      await interaction.reply({ content: "Coach signing off. GG!", flags: MessageFlags.Ephemeral });
      return;
    }

    case "say": {
      const text = interaction.options.getString("text", true).slice(0, 300);
      // Choices guarantee a known key, but guard anyway — a stale client could
      // send an old value after the registry changed.
      const voiceKey = interaction.options.getString("voice");
      const voice = voiceKey ? findVoice(voiceKey) : undefined;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ensured = await ensureInVoice(interaction, deps);
      if (!ensured.ok) {
        await interaction.editReply({ content: NOT_IN_VC, components: [joinButtonRow()] });
        return;
      }
      deps.voice.say({
        text,
        priority: 5,
        maxAgeMs: 30_000,
        category: "manual",
        eventAt: Date.now(),
        voiceId: voice?.voiceId,
      });
      lastSaidText = text;
      await interaction.editReply(sayConfirmation(deps, text, voice, ensured.joinedName));
      return;
    }

    case "repeat": {
      if (!lastSaidText) {
        await interaction.reply({
          content: "Nothing to repeat yet — use `/coach say` first.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const text = lastSaidText;
      const voiceKey = interaction.options.getString("voice");
      const voice = voiceKey ? findVoice(voiceKey) : undefined;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ensured = await ensureInVoice(interaction, deps);
      if (!ensured.ok) {
        await interaction.editReply({ content: NOT_IN_VC, components: [joinButtonRow()] });
        return;
      }
      deps.voice.say({
        text,
        priority: 5,
        maxAgeMs: 30_000,
        category: "manual",
        eventAt: Date.now(),
        voiceId: voice?.voiceId,
      });
      await interaction.editReply(sayConfirmation(deps, text, voice, ensured.joinedName));
      return;
    }

    case "voice": {
      const key = interaction.options.getString("name");
      if (!key) {
        await replyVoicePicker(interaction, deps);
        return;
      }
      const voice = setVoice(key);
      const offNote = voiceOffNote(deps);
      if (!voice) {
        await interaction.reply({
          content: "Never heard of that voice — pick one from the list (`/coach voice`).",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({
        content: `🎙️ Coach voice switched to **${voice.label}** — every new line from here on.${offNote}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    case "status": {
      const share = interaction.options.getBoolean("share") ?? false;
      await interaction.reply({
        content: renderStatus(deps, { share }),
        components: [statusRow()],
        // Default private; `share:true` posts it so the whole squad can see.
        ...(share ? {} : { flags: MessageFlags.Ephemeral }),
      });
      return;
    }

    case "panel": {
      // Non-ephemeral on purpose: friends pin this and tap the buttons.
      await interaction.reply({
        content: "🎛️ **CS2 Coach controls** — tap a button. Pin this so everyone can use it.",
        components: panelRows(),
      });
      return;
    }

    case "song": {
      const key = interaction.options.getString("title") as keyof typeof SONGS | null;
      if (!key) {
        await interaction.reply({
          content: "Pick your poison:",
          components: songButtons(),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const song = SONGS[key];
      if (!existsSync(song.file)) {
        await interaction.reply({
          content: "Song file is missing on the server — check the deploy.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const ensured = await ensureInVoice(interaction, deps);
      if (!ensured.ok) {
        await interaction.editReply({ content: NOT_IN_VC, components: [joinButtonRow()] });
        return;
      }
      const prefix = ensured.joinedName ? `Joined **${ensured.joinedName}**. ` : "";
      await interaction.editReply(prefix + startSong(deps, song));
      return;
    }

    case "stop-song": {
      if (deps.voice.stopSong()) {
        await interaction.reply({ content: "Song's off. Back to work.", flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: "Nothing's playing.", flags: MessageFlags.Ephemeral });
      }
      return;
    }

    case "quiet": {
      // Explicit on/off is idempotent (you can guarantee a state without reading a
      // reply first); no arg keeps the original toggle for muscle memory.
      const choice = interaction.options.getString("state");
      const on = choice ? choice === "on" : !deps.quiet.get();
      deps.quiet.set(on);
      await interaction.reply({ content: quietReply(on), flags: MessageFlags.Ephemeral });
      return;
    }
  }
}

/** /coach say & /coach repeat confirmation line — notes an auto-join, the one-off
 *  voice (and whether it'll actually take effect), and that test lines bypass mute. */
function sayConfirmation(
  deps: BotDeps,
  text: string,
  voice: ReturnType<typeof findVoice>,
  joinedName: string | null,
): string {
  // The override only does anything when the switchable-voice provider is the
  // one that actually synthesizes — flag it if it isn't even in the chain.
  const switchable = deps.ttsProviders().includes("elevenlabs");
  const voiceNote = voice
    ? ` in **${voice.label}**${switchable ? "" : " (no effect — switchable voices aren't active right now)"}`
    : "";
  const prefix = joinedName ? `Joined **${joinedName}**. ` : "";
  // say bypasses mute on purpose (it's a deliberate test) — say so when muted.
  const muteNote = deps.quiet.get() ? " (test lines still play through mute)" : "";
  return `${prefix}Saying${voiceNote}: "${text}"${muteNote}`;
}

/** The "switchable voices aren't on" warning shared by the /coach voice paths. */
function voiceOffNote(deps: BotDeps): string {
  return deps.ttsProviders().includes("elevenlabs")
    ? ""
    : "\n⚠️ Switchable voices aren't turned on right now, so this won't change what you hear yet.";
}

/** No-arg /coach voice: a clickable picker (mirrors the /coach song buttons)
 *  rather than a text list you have to copy a slug out of. A single configured
 *  voice gets a plain reply — a one-option dropdown would be pointless. */
async function replyVoicePicker(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
  const all = voices();
  const cur = currentVoice();
  const offNote = voiceOffNote(deps);
  if (all.length <= 1) {
    await interaction.reply({
      content: `Only one voice configured: **${cur.label}**.${offNote}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const menu = new StringSelectMenuBuilder()
    .setCustomId("voice:set")
    .setPlaceholder("Pick a coach voice")
    // 25-option cap matches MAX_VOICE_CHOICES; current voice marked as the default.
    .addOptions(
      all.slice(0, MAX_VOICE_CHOICES).map((v) => ({ label: v.label, value: v.key, default: v.key === cur.key })),
    );
  await interaction.reply({
    content: `Current coach voice: **${cur.label}**. Pick one:${offNote}`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

// ── component dispatch ─────────────────────────────────────────────────────

async function handleButton(interaction: ButtonInteraction, deps: BotDeps): Promise<void> {
  const id = interaction.customId;
  if (id.startsWith("song:")) return handleSongButton(interaction, deps);
  if (id === "fix:join") return joinInvokerChannel(interaction, deps);
  if (id === "test:say") return handleTestSay(interaction, deps);
  if (id === "status:refresh") {
    await interaction.update({ content: renderStatus(deps), components: [statusRow()] });
    return;
  }
  if (id === "status:check") {
    // Used from the setup DM / fallback — a fresh message so the install steps
    // stay visible. Ephemeral only inside a guild (DMs can't be ephemeral).
    await interaction.reply({
      content: renderStatus(deps),
      components: [statusRow()],
      ...(interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : {}),
    });
    return;
  }
  if (id.startsWith("panel:")) return handlePanelButton(interaction, deps);
  // An id we don't route — almost always a button from a message older than the
  // last redeploy. Acknowledge it so the user gets a hint, not a silent failure.
  await staleComponentReply(interaction);
}

/** Acknowledge a button/select whose customId we no longer recognise (typically a
 *  stale control from before a redeploy). Ephemeral only in a guild. */
async function staleComponentReply(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
  await interaction.reply({
    content: "That control's expired — run the command again (or use a fresh `/coach panel`).",
    ...(interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : {}),
  });
}

async function handlePanelButton(interaction: ButtonInteraction, deps: BotDeps): Promise<void> {
  const action = interaction.customId.slice("panel:".length);
  switch (action) {
    case "join":
      return joinInvokerChannel(interaction, deps);
    case "leave":
      // Leave also wipes the saved channel (no auto-rejoin after a restart), so a
      // stray tap is worth a confirm — one extra click on a rare destructive action.
      await interaction.reply({
        content: "Leave the voice channel? This also turns off auto-rejoin after a restart.",
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("panel:leave:confirm").setLabel("Confirm leave").setStyle(ButtonStyle.Danger),
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    case "leave:confirm":
      deps.voice.leave();
      clearVoiceChannel();
      await interaction.update({ content: "Coach signing off. GG!", components: [] });
      return;
    case "quiet": {
      const on = !deps.quiet.get();
      deps.quiet.set(on);
      await interaction.reply({ content: quietReply(on), flags: MessageFlags.Ephemeral });
      return;
    }
    case "status":
      await interaction.reply({ content: renderStatus(deps), components: [statusRow()], flags: MessageFlags.Ephemeral });
      return;
    case "song":
      await interaction.reply({ content: "Pick your poison:", components: songButtons(), flags: MessageFlags.Ephemeral });
      return;
    case "stop":
      await interaction.reply({
        content: deps.voice.stopSong() ? "Song's off. Back to work." : "Nothing's playing.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    default:
      await interaction.reply({ content: "Unknown panel button.", flags: MessageFlags.Ephemeral });
  }
}

/** The join confirmation's "Test the voice" button — queues a canned line so a
 *  newcomer can confirm the coach is audible with zero typing. */
async function handleTestSay(interaction: ButtonInteraction, deps: BotDeps): Promise<void> {
  if (!deps.voice.connected) {
    await interaction.reply({
      content: "I'm not in a voice channel anymore — tap **Join** (or `/coach join`) first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  deps.voice.say({
    text: "Mic check. Try not to embarrass me.",
    priority: 5,
    maxAgeMs: 30_000,
    category: "manual",
    eventAt: Date.now(),
  });
  await interaction.reply({
    content: `🎙️ Mic check sent — you should hear me.${muteHint(deps)}`,
    flags: MessageFlags.Ephemeral,
  });
}

/** A pick from the no-arg /coach voice select menu. */
async function handleVoiceSelect(interaction: StringSelectMenuInteraction, deps: BotDeps): Promise<void> {
  const key = interaction.values[0];
  const voice = setVoice(key);
  if (!voice) {
    await interaction.update({ content: "Never heard of that voice — try `/coach voice` again.", components: [] });
    return;
  }
  await interaction.update({
    content: `🎙️ Coach voice switched to **${voice.label}** — every new line from here on.${voiceOffNote(deps)}`,
    components: [],
  });
}

/** A click on a /coach song button (or the panel's Song picker). Auto-joins if
 *  needed, then swaps the picker message for the outcome. */
async function handleSongButton(interaction: ButtonInteraction, deps: BotDeps): Promise<void> {
  const song = SONGS[interaction.customId.slice("song:".length) as keyof typeof SONGS];
  if (!song) {
    await interaction.update({ content: "That song's gone from the playlist.", components: [] });
    return;
  }
  if (!existsSync(song.file)) {
    await interaction.update({ content: "Song file is missing on the server — check the deploy.", components: [] });
    return;
  }
  // deferUpdate (not update) so we can auto-join during the up-to-20s window, then
  // editReply the original picker message — update() can't follow a defer.
  await interaction.deferUpdate();
  const ensured = await ensureInVoice(interaction, deps);
  if (!ensured.ok) {
    await interaction.editReply({ content: NOT_IN_VC, components: [joinButtonRow()] });
    return;
  }
  const prefix = ensured.joinedName ? `Joined **${ensured.joinedName}**. ` : "";
  await interaction.editReply({ content: prefix + startSong(deps, song), components: [] });
}

/** Best-effort error reply for a component interaction, respecting whatever
 *  acknowledgement state it's already in. Swallows failures — a stale button after
 *  a redeploy has a dead token and there's nothing we can do but log (done above). */
async function safeComponentError(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
  const msg = "Something broke on my end — try again, and ping whoever runs the bot if it sticks.";
  try {
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral });
    else await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
  } catch {
    // Interaction token expired (e.g. a click on a message from before a redeploy).
  }
}

// ── setup ──────────────────────────────────────────────────────────────────

/** The friend-facing install steps — one self-contained message. Deliberately
 *  uses Steam's own "Browse local files" to open the right folder (works no matter
 *  which drive/library CS2 lives in, with NO script for the friend to run), and
 *  offers two ways in: the attached file, OR — for a friend who'd rather not
 *  download anything — pasting the cfg text shown inline. `host` is shown so they
 *  can sanity-check where their game will post; `cfg` is the file contents to
 *  paste. Stays under Discord's 2000-char limit: at a realistic token size the
 *  inline-cfg form is used, but if an unusually long token would push the message
 *  past the cap we drop the inline paste block (option B) and lean on the attached
 *  file (option A) instead — the file is sent regardless, so it always works. */
function setupInstructions(host: string, cfg: string): string {
  const guide = [
    "**CS2 Coach — connect your game** (2 min, nothing to install)",
    "",
    "Open your CS2 config folder: in **Steam**, right-click **Counter-Strike 2 → Manage → Browse local files**, then open `game\\csgo\\cfg`. Get the config in there either way:",
    "",
    "**A** — drop in the **attached file**.",
    "**B** — or make it yourself: create `gamestate_integration_coach.cfg` there and paste in:",
    "```",
    cfg.trimEnd(),
    "```",
    "(In Notepad: *Save as type → All Files*, so it's `.cfg` not `.cfg.txt`.)",
    "",
    "Then **fully restart CS2** and run **`/coach status`** (or tap the button below) — you'll show up under **Feeds** in ~10s.",
    `_Points your game at \`${host}\`._`,
  ].join("\n");

  // Length guard: an unusually long GSI token inflates the inline cfg block enough
  // to blow past Discord's 2000-char cap. Rather than let the whole message fail,
  // fall back to a shorter form that drops the inline paste path (option B) and
  // points at the always-sent attached file (option A) instead. Stays under 1900.
  if (guide.length > 1900) {
    return [
      "**CS2 Coach — connect your game** (2 min, nothing to install)",
      "",
      "Open your CS2 config folder: in **Steam**, right-click **Counter-Strike 2 → Manage → Browse local files**, then open `game\\csgo\\cfg`, and **drop in the attached file** (`gamestate_integration_coach.cfg`).",
      "",
      "Then **fully restart CS2** and run **`/coach status`** (or tap the button below) — you'll show up under **Feeds** in ~10s.",
      `_Points your game at \`${host}\`._`,
    ].join("\n");
  }

  return guide;
}

/** /coach setup — hands the friend their GSI cfg as a file (data, not an
 *  executable) via DM, with an ephemeral fallback if their DMs are closed. The cfg
 *  carries the shared token, so it must stay private to the invoker — never a
 *  public channel. */
async function handleSetup(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
  const { publicHost, token, port } = deps.cfg;
  if (!publicHost) {
    await interaction.reply({
      content:
        "Self-setup isn't switched on for this coach yet — whoever hosts the bot needs to set `COACH_PUBLIC_HOST` (the address CS2 should send game state to). Give them a nudge.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const cfgText = buildCfg({ host: publicHost, port, token });
  const buf = Buffer.from(cfgText, "utf8");
  const makeFile = () => new AttachmentBuilder(buf, { name: "gamestate_integration_coach.cfg" });
  const guide = setupInstructions(resolveUri(publicHost, port), cfgText);

  try {
    await interaction.user.send({ content: guide, files: [makeFile()], components: [checkButtonRow()] });
    await interaction.editReply(
      "📬 Sent to your DMs — your config (as a file *or* copy-paste text) and quick steps. Drop it in, restart CS2, then run `/coach status`.",
    );
  } catch (err) {
    // The DM didn't go through. Usually the user has "Allow direct messages from
    // server members" off, or blocked the bot (DiscordAPIError 50007) — but
    // whatever the reason, still hand them the file: fall back to the ephemeral
    // reply, which only this person can see, right here in the channel. So a
    // friend can always grab the cfg and install it themselves, DMs or not.
    const dmsClosed = err instanceof DiscordAPIError && err.code === 50007;
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("bot", `/coach setup: DM failed (${dmsClosed ? "DMs closed" : "unexpected"}: ${reason}) — using ephemeral fallback`);
    await interaction.editReply({
      content:
        (dmsClosed
          ? "I couldn't DM you — your **direct messages from server members** are off (or the bot's blocked)."
          : "I couldn't DM you for some reason.") +
        " No worries, here's your config privately (only you can see this) 👇\n\n" +
        guide,
      files: [makeFile()],
      components: [checkButtonRow()],
    });
  }
}
