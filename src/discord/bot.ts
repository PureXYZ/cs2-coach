import {
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { log } from "../log.js";
import type { VoiceCoach } from "./voice.js";

export interface BotDeps {
  token: string;
  guildId?: string;
  voice: VoiceCoach;
  status: () => {
    gsiAgeMs: number | null;
    ttsProviders: string[];
    llmModel: string | null;
  };
}

const commands = [
  new SlashCommandBuilder()
    .setName("coach")
    .setDescription("CS2 AI coach")
    .addSubcommand((sub) => sub.setName("join").setDescription("Join your current voice channel"))
    .addSubcommand((sub) => sub.setName("leave").setDescription("Leave the voice channel"))
    .addSubcommand((sub) =>
      sub
        .setName("say")
        .setDescription("Make the coach say something (test)")
        .addStringOption((opt) => opt.setName("text").setDescription("What to say").setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("status").setDescription("Show GSI / voice / TTS status")),
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
      await interaction.deferReply();
      await deps.voice.join(channel);
      await interaction.editReply(`🎙️ Coach is live in **${channel.name}**. Start your match — I'm watching the game state.`);
      return;
    }

    case "leave": {
      deps.voice.leave();
      await interaction.reply("Coach signing off. GG!");
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

    case "status": {
      const s = deps.status();
      const gsi =
        s.gsiAgeMs === null
          ? "❌ no game state received yet — is CS2 running with the cfg installed?"
          : s.gsiAgeMs < 60_000
            ? `✅ live (last update ${(s.gsiAgeMs / 1000).toFixed(1)}s ago)`
            : `⚠️ stale (last update ${Math.round(s.gsiAgeMs / 1000)}s ago)`;
      await interaction.reply({
        content: [
          `**GSI:** ${gsi}`,
          `**Voice:** ${deps.voice.connected ? "✅ connected" : "❌ not in a channel"} (queue: ${deps.voice.queueLength})`,
          `**TTS:** ${s.ttsProviders.join(" → ")}`,
          `**LLM:** ${s.llmModel ?? "disabled (rule-based lines only)"}`,
        ].join("\n"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }
}
