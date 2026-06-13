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
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { log } from "../log.js";
import { buildCfg, resolveUri } from "../gsi/cfg.js";
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
  status: () => {
    gsiAgeMs: number | null;
    ttsProviders: string[];
    llmModel: string | null;
    /** Cross-session memory size, for the status readout. */
    sessionsOnFile: number;
    /** How many CONFIRMED teammate feeds (same match + side) are wired in. */
    wiredFeeds: number;
    /** Every feed POSTing right now (raw presence), newest first — the honest
     *  "is your CS2 talking to the coach?" signal for a friend confirming setup. */
    connectedFeeds: { name: string; ageMs: number }[];
  };
}

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

/** Why a song can't start right now, or null when it's good to go. Picking a song
 *  while one plays is fine — playFile() cuts straight over to the new one. */
function songBlocked(deps: BotDeps, song: (typeof SONGS)[keyof typeof SONGS]): string | null {
  if (!deps.voice.connected) return "I'm not in a voice channel — use `/coach join` first.";
  if (!existsSync(song.file)) return "Song file is missing on the server — check the deploy.";
  return null;
}

/** Start (or switch to) a song and return the reply line for it. */
function startSong(deps: BotDeps, song: (typeof SONGS)[keyof typeof SONGS]): string {
  const switching = deps.voice.songActive;
  deps.voice.playFile(song.file);
  return switching ? `Fine, switching it up. ${song.reply}` : song.reply;
}

const commands = [
  new SlashCommandBuilder()
    .setName("coach")
    .setDescription("CS2 AI coach")
    .addSubcommand((sub) =>
      sub.setName("setup").setDescription("Get connected — DMs you the CS2 config file (no software to install)"),
    )
    .addSubcommand((sub) => sub.setName("join").setDescription("Join your current voice channel"))
    .addSubcommand((sub) => sub.setName("leave").setDescription("Leave the voice channel"))
    .addSubcommand((sub) =>
      sub
        .setName("say")
        .setDescription("Make the coach say something (test)")
        .addStringOption((opt) => opt.setName("text").setDescription("What to say").setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("status").setDescription("Show GSI / voice / TTS status"))
    .addSubcommand((sub) => sub.setName("quiet").setDescription("Mute/unmute the coach (game tracking continues)"))
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
    .addSubcommand((sub) => sub.setName("stop").setDescription("Stop the song (coaching continues)")),
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
    if (interaction.isButton() && interaction.customId.startsWith("song:")) {
      try {
        await handleSongButton(interaction, deps);
      } catch (err) {
        log.error("bot", "Song button failed", err);
      }
      return;
    }
    if (!interaction.isChatInputCommand() || interaction.commandName !== "coach") return;
    try {
      await handleCommand(interaction, deps);
    } catch (err) {
      log.error("bot", "Command failed", err);
      const msg = { content: "Something went wrong — check the coach logs.", flags: MessageFlags.Ephemeral as const };
      if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
  });

  await client.login(deps.token);
  return client;
}

async function handleCommand(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
  switch (interaction.options.getSubcommand()) {
    case "setup": {
      await handleSetup(interaction, deps);
      return;
    }

    case "join": {
      const member = interaction.member;
      const channel = member instanceof GuildMember ? member.voice.channel : null;
      if (!channel) {
        await interaction.reply({
          content: "Join a voice channel first, then run `/coach join`.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await deps.voice.join(channel);
      // Remembered across restarts — a redeploy rejoins this channel automatically.
      saveVoiceChannel({ guildId: channel.guild.id, channelId: channel.id });
      await interaction.editReply(`🎙️ Coach is live in **${channel.name}**. Start your match — I'm watching the game state.`);
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
      if (!deps.voice.connected) {
        await interaction.reply({
          content: "I'm not in a voice channel — use `/coach join` first.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      deps.voice.say({ text, priority: 5, maxAgeMs: 30_000, category: "manual", eventAt: Date.now() });
      await interaction.reply({ content: `Saying: "${text}"`, flags: MessageFlags.Ephemeral });
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
      const blocked = songBlocked(deps, song);
      if (blocked) {
        await interaction.reply({ content: blocked, flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply({ content: startSong(deps, song), flags: MessageFlags.Ephemeral });
      return;
    }

    case "stop": {
      if (deps.voice.stopSong()) {
        await interaction.reply({ content: "Song's off. Back to work.", flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: "Nothing's playing.", flags: MessageFlags.Ephemeral });
      }
      return;
    }

    case "quiet": {
      const on = !deps.quiet.get();
      deps.quiet.set(on);
      await interaction.reply({
        content: on
          ? "🔇 Coach is muted — still watching the game and keeping score. `/coach quiet` again to unmute."
          : "🎙️ Coach is back on the mic. You asked for this.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    case "status": {
      const s = deps.status();
      const gsi =
        s.gsiAgeMs === null
          ? "❌ no game state received yet — is CS2 running with the cfg installed? Run `/coach setup` to (re)install it."
          : s.gsiAgeMs < 60_000
            ? `✅ live (last update ${(s.gsiAgeMs / 1000).toFixed(1)}s ago)`
            : `⚠️ stale (last update ${Math.round(s.gsiAgeMs / 1000)}s ago)`;
      const feeds = s.connectedFeeds;
      const squad =
        feeds.length === 0
          ? "no game feeds connected right now — launch CS2 with the cfg installed (`/coach setup`) and you'll show up here"
          : `${feeds.length} connected: ${feeds
              .map((f) => `**${f.name}** (${Math.max(0, Math.round(f.ageMs / 1000))}s ago)`)
              .join(", ")}${s.wiredFeeds > 1 ? ` — team coaching live (${s.wiredFeeds} on your squad)` : ""}`;
      await interaction.reply({
        content: [
          `**GSI:** ${gsi}`,
          `**Voice:** ${deps.voice.connected ? "✅ connected" : "❌ not in a channel"} (queue: ${deps.voice.queueLength})`,
          `**Feeds:** ${squad}`,
          `**Coach:** ${deps.quiet.get() ? "🔇 muted (`/coach quiet` to unmute)" : "🎙️ speaking"}`,
          `**TTS:** ${s.ttsProviders.join(" → ")}`,
          `**LLM:** ${s.llmModel ?? "disabled (rule-based lines only)"}`,
          `**Memory:** ${s.sessionsOnFile} past match${s.sessionsOnFile === 1 ? "" : "es"} on file`,
        ].join("\n"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }
}

/** The friend-facing install steps — one self-contained message. Deliberately
 *  uses Steam's own "Browse local files" to open the right folder (works no matter
 *  which drive/library CS2 lives in, with NO script for the friend to run), and
 *  offers two ways in: the attached file, OR — for a friend who'd rather not
 *  download anything — pasting the cfg text shown inline. `host` is shown so they
 *  can sanity-check where their game will post; `cfg` is the file contents to
 *  paste. Stays well under Discord's 2000-char limit at any realistic token size. */
function setupInstructions(host: string, cfg: string): string {
  return [
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
    "Then **fully restart CS2** and run **`/coach status`** — you'll show up under **Feeds** in ~10s.",
    `_Points your game at \`${host}\`._`,
  ].join("\n");
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
    await interaction.user.send({ content: guide, files: [makeFile()] });
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
    });
  }
}

/** A click on the `/coach song` button picker — update() swaps the ephemeral
 *  picker message for the outcome, so the buttons disappear once one is used. */
async function handleSongButton(interaction: ButtonInteraction, deps: BotDeps): Promise<void> {
  const song = SONGS[interaction.customId.slice("song:".length) as keyof typeof SONGS];
  if (!song) {
    await interaction.update({ content: "That song's gone from the playlist.", components: [] });
    return;
  }
  const blocked = songBlocked(deps, song);
  if (blocked) {
    await interaction.update({ content: blocked, components: [] });
    return;
  }
  await interaction.update({ content: startSong(deps, song), components: [] });
}
