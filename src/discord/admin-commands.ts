import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { log } from "../log.js";
import { STEAMID64_RE } from "../config.js";
import { type BotDeps, renderStatus } from "./bot.js";

// Owner-only control command, registered ONLY to a private admin guild (see
// BotDeps.admin) so it never appears in the public server. Kept SEPARATE from `coach`
// so the public command's contexts/registration are untouched. Use is hard-gated on the
// owner id in handleAdminCommand — the private-guild registration only hides its existence.
export const adminCommand = new SlashCommandBuilder()
  .setName("coachadmin")
  .setDescription("Owner-only coach controls")
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub.setName("status").setDescription("Detailed status — every feed's SteamID64 and its linked Discord user"),
  )
  .addSubcommand((sub) => sub.setName("settings").setDescription("Show the current live settings vs their env defaults"))
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Change a setting on the fly (resets to the env default on restart)")
      .addStringOption((o) =>
        o
          .setName("key")
          .setDescription("Which setting to change")
          .setRequired(true)
          .addChoices(
            { name: "nickname (spoken player name)", value: "nickname" },
            { name: "team-tactics (on/off)", value: "team-tactics" },
            { name: "warmup-speech (on/off)", value: "warmup-speech" },
            { name: "squad-recap (off/leaders/full)", value: "squad-recap" },
            { name: "debug logging (on/off)", value: "debug" },
            { name: "llm-model", value: "llm-model" },
            { name: "llm-fast-model", value: "llm-fast-model" },
            { name: "llm-effort (low/medium/high/max)", value: "llm-effort" },
            { name: "volume (0.1-2)", value: "volume" },
          ),
      )
      .addStringOption((o) => o.setName("value").setDescription("The new value (leave blank only to clear the nickname)")),
  )
  .addSubcommandGroup((g) =>
    g
      .setName("link")
      .setDescription("View or fix Steam↔Discord account links")
      .addSubcommand((s) => s.setName("list").setDescription("List all Steam↔Discord links on file"))
      .addSubcommand((s) =>
        s
          .setName("set")
          .setDescription("Manually link a Discord user to a SteamID64 (overrides auto-capture)")
          .addUserOption((o) => o.setName("user").setDescription("The Discord user to link").setRequired(true))
          .addStringOption((o) => o.setName("steamid64").setDescription("Their 17-digit SteamID64 (7656…)").setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName("remove")
          .setDescription("Remove a link — by SteamID64, or all links for a Discord user")
          .addStringOption((o) => o.setName("steamid64").setDescription("The SteamID64 to unlink"))
          .addUserOption((o) => o.setName("user").setDescription("Remove ALL links for this Discord user")),
      ),
  )
  .addSubcommandGroup((g) =>
    g
      .setName("sessions")
      .setDescription("Inspect or prune recorded match history")
      .addSubcommand((s) => s.setName("list").setDescription("Show the most recent recorded matches"))
      .addSubcommand((s) => s.setName("delete-last").setDescription("Delete the most recent recorded match"))
      .addSubcommand((s) => s.setName("clear").setDescription("Wipe ALL recorded match history")),
  )
  .addSubcommandGroup((g) =>
    g
      .setName("tts")
      .setDescription("Inspect or manage the TTS audio cache")
      .addSubcommand((s) => s.setName("stats").setDescription("Show cache size (entries + bytes)"))
      .addSubcommand((s) => s.setName("prewarm").setDescription("Re-synthesize all cacheable lines in the background"))
      .addSubcommand((s) => s.setName("clear").setDescription("Empty the TTS audio cache")),
  )
  .toJSON();

/** Register the owner-only command to the private admin guild only — an upsert by name,
 *  so it's idempotent across restarts and the guild ends up holding exactly this command.
 *  No-op when the admin surface is disabled (COACH_ADMIN_GUILD_ID unset). Best-effort: a
 *  missing bot membership in that guild is logged, never thrown, so it can't break boot. */
export async function registerAdminCommand(ready: Client<true>, adminGuildId: string | undefined): Promise<void> {
  if (!adminGuildId) return; // surface disabled
  try {
    const guild = await ready.guilds.fetch(adminGuildId);
    await guild.commands.create(adminCommand);
    log.info("bot", `Owner-only /coachadmin registered in admin guild ${guild.name}`);
  } catch (err) {
    log.warn(
      "bot",
      `Could not register /coachadmin in guild ${adminGuildId} — is the bot a member of it? ${err instanceof Error ? err.message : err}`,
    );
  }
}

// ── owner-only admin surface ───────────────────────────────────────────────

/** /coachadmin dispatch. HARD owner gate FIRST: keyed on the gateway-authenticated
 *  interaction.user.id (NEVER the self-asserted Steam link). This is defense-in-depth
 *  even though the command is only registered in the private admin guild — if anyone
 *  else ever joins that guild, they still can't use it. All replies are ephemeral. */
export async function handleAdminCommand(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
  const ownerId = deps.admin?.ownerId;
  if (!ownerId || interaction.user.id !== ownerId) {
    await interaction.reply({ content: "That's an owner-only control.", flags: MessageFlags.Ephemeral });
    return;
  }
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  if (group === "link") {
    switch (sub) {
      case "list":
        await interaction.reply({ content: renderLinks(deps), flags: MessageFlags.Ephemeral });
        return;
      case "set":
        await handleLinkSet(interaction, deps);
        return;
      case "remove":
        await handleLinkRemove(interaction, deps);
        return;
    }
    return;
  }
  if (group === "sessions") {
    switch (sub) {
      case "list":
        await interaction.reply({ content: renderSessions(deps), flags: MessageFlags.Ephemeral });
        return;
      case "delete-last": {
        const last = deps.sessions.recent(1)[0];
        if (!last) {
          await interaction.reply({ content: "No recorded matches on file.", flags: MessageFlags.Ephemeral });
          return;
        }
        // Bind the confirm to THIS record's timestamp (epoch ms — no colons, so it
        // survives the customId split) so the click deletes the previewed match, not
        // whatever is newest at click time if a match records during the confirm window.
        await interaction.reply({
          content: `⚠️ Delete the most recent match — **${last.ourScore}-${last.theirScore}** ${last.map ?? "?"}?`,
          components: [adminConfirmRow(`admin:sessdel:${Date.parse(last.endedAt)}`, "Delete")],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      case "clear": {
        const n = deps.sessions.count();
        if (n === 0) {
          await interaction.reply({ content: "No recorded matches on file.", flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({
          content: `⚠️ Wipe **all ${n}** recorded match${n === 1 ? "" : "es"}? This can't be undone.`,
          components: [adminConfirmRow("admin:sessclear", "Wipe all")],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
    return;
  }
  if (group === "tts") {
    switch (sub) {
      case "stats":
        await interaction.reply({ content: renderTts(deps), flags: MessageFlags.Ephemeral });
        return;
      case "prewarm": {
        if (!deps.tts.cacheStats()) {
          await interaction.reply({ content: "TTS audio cache is disabled (`TTS_CACHE_ENABLED=false`) — nothing to prewarm.", flags: MessageFlags.Ephemeral });
          return;
        }
        deps.tts.prewarm();
        await interaction.reply({
          content: "🔥 Re-prewarm started in the background — already-cached lines are skipped. Check `/coachadmin tts stats` in a bit.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      case "clear": {
        const stats = deps.tts.cacheStats();
        if (!stats) {
          await interaction.reply({ content: "TTS audio cache is disabled (`TTS_CACHE_ENABLED=false`).", flags: MessageFlags.Ephemeral });
          return;
        }
        if (stats.entries === 0) {
          await interaction.reply({ content: "TTS cache is already empty.", flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({
          content: `⚠️ Clear **${stats.entries}** cached line${stats.entries === 1 ? "" : "s"} (${formatBytes(stats.bytes)})? They'll re-synthesize on next use (or run \`tts prewarm\`).`,
          components: [adminConfirmRow("admin:ttsclear", "Clear cache")],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
    return;
  }
  switch (sub) {
    case "status":
      await interaction.reply({ content: renderAdminStatus(deps), flags: MessageFlags.Ephemeral });
      return;
    case "settings":
      await interaction.reply({ content: renderSettings(deps), flags: MessageFlags.Ephemeral });
      return;
    case "set": {
      const key = interaction.options.getString("key", true);
      const value = interaction.options.getString("value") ?? null;
      const result = deps.settings.set(key, value);
      await interaction.reply({
        content: result.ok ? `${result.message}\n_(resets to the env default on restart)_` : `⚠️ ${result.message}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }
}

/** Owner `/coachadmin settings`: current live value of every settable key, flagging the
 *  ones that differ from their env default (i.e. changed this session). */
function renderSettings(deps: BotDeps): string {
  const rows = deps.settings.list().map((s) => {
    const changed = s.value !== s.envDefault;
    return `• \`${s.key}\` = **${s.value}**${changed ? ` _(env default: ${s.envDefault})_` : ""}`;
  });
  return ["**Live settings** — change with `/coachadmin set <key> <value>`. All reset to env on restart.", ...rows]
    .join("\n")
    .slice(0, 1990);
}

/** Owner `/coachadmin sessions list`: the most recent recorded matches (result, score,
 *  map, own K/D, how long ago) — the history the cross-session form lines are built from. */
function renderSessions(deps: BotDeps): string {
  const recent = deps.sessions.recent(10);
  if (recent.length === 0) return "No recorded matches on file yet.";
  const now = Date.now();
  const rows = recent.map((r) => {
    const res = r.won === undefined ? "❔" : r.won ? "✅ W" : "❌ L";
    const kd = r.kills !== undefined && r.deaths !== undefined ? ` — ${r.kills}/${r.deaths}` : "";
    const ms = now - Date.parse(r.endedAt);
    const when = Number.isFinite(ms) ? ` _(${humanAge(ms)} ago)_` : "";
    return `• ${res} **${r.ourScore}-${r.theirScore}** ${r.map ?? "?"}${kd}${when}`;
  });
  return [`**Recent matches — ${deps.sessions.count()} on file (showing ${recent.length})**`, ...rows].join("\n").slice(0, 1990);
}

/** Owner `/coachadmin tts stats`: the audio cache size, or that it's disabled. */
function renderTts(deps: BotDeps): string {
  const stats = deps.tts.cacheStats();
  if (!stats) return "TTS audio cache is **disabled** (`TTS_CACHE_ENABLED=false`).";
  return `**TTS cache:** ${stats.entries} line${stats.entries === 1 ? "" : "s"}, ${formatBytes(stats.bytes)}.`;
}

/** Compact byte size (B/KB/MB) for the owner readouts. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Shared footnote: a manual link change is a stopgap — the per-payload auto-capture
 *  (index.ts) re-asserts the cfg-baked id the next time that friend's game connects. */
const LINK_STOPGAP_NOTE =
  "\n_Note: links auto-capture from each friend's cfg whenever they play, so this can revert next time their game connects — for a permanent fix, have them re-run `/coach setup` on the right account._";

/** A destructive-action confirm row: a Danger confirm (custom id carries the action)
 *  plus a Cancel, both routed through the `admin:` button dispatch. */
function adminConfirmRow(confirmId: string, confirmLabel: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel(confirmLabel).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("admin:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );
}

/** `/coachadmin link set <user> <steamid64>` — manual owner override of a pairing.
 *  Applies straight away for a new or identical link; asks to confirm when it would
 *  OVERWRITE an existing pairing to a different Discord user. */
async function handleLinkSet(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
  const user = interaction.options.getUser("user", true);
  const steam64 = interaction.options.getString("steamid64", true).trim();
  if (!STEAMID64_RE.test(steam64)) {
    await interaction.reply({ content: `\`${steam64}\` isn't a valid SteamID64 (17 digits starting 7656…).`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (user.bot) {
    await interaction.reply({ content: "That's a bot account — link a real user.", flags: MessageFlags.Ephemeral });
    return;
  }
  const existing = deps.links.get(steam64);
  if (!existing || existing.discordId === user.id) {
    deps.links.set(steam64, user.id);
    await interaction.reply({
      content: `✅ Linked **${existing?.steamName ?? steam64}** \`${steam64}\` → <@${user.id}>.${LINK_STOPGAP_NOTE}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({
    content:
      `⚠️ \`${steam64}\`${existing.steamName ? ` (**${existing.steamName}**)` : ""} is already linked to <@${existing.discordId}>. ` +
      `Re-link it to <@${user.id}>?`,
    components: [adminConfirmRow(`admin:linkset:${steam64}:${user.id}`, "Overwrite")],
    flags: MessageFlags.Ephemeral,
  });
}

/** `/coachadmin link remove` — by `steamid64` (one pairing) or by `user` (all of their
 *  SteamID64s, incl. alts). Always confirms first (it's destructive). */
async function handleLinkRemove(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
  const steam64 = interaction.options.getString("steamid64")?.trim() || null;
  const user = interaction.options.getUser("user");
  if (!steam64 && !user) {
    await interaction.reply({ content: "Give me a `steamid64` to unlink, or a `user` to remove all their links.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (steam64 && user) {
    await interaction.reply({ content: "Pick one: a `steamid64` OR a `user`, not both.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (steam64) {
    if (!STEAMID64_RE.test(steam64)) {
      await interaction.reply({ content: `\`${steam64}\` isn't a valid SteamID64.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const existing = deps.links.get(steam64);
    if (!existing) {
      await interaction.reply({ content: `No link on file for \`${steam64}\`.`, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({
      content: `⚠️ Remove the link \`${steam64}\`${existing.steamName ? ` (**${existing.steamName}**)` : ""} → <@${existing.discordId}>?`,
      components: [adminConfirmRow(`admin:linkrm:s:${steam64}`, "Remove")],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const owned = deps.links.list().filter((l) => l.discordId === user!.id);
  if (owned.length === 0) {
    await interaction.reply({ content: `No links on file for <@${user!.id}>.`, flags: MessageFlags.Ephemeral });
    return;
  }
  // Cap + clamp: a user with many alts could otherwise blow past Discord's 2000-char
  // limit and the reply would throw (mirrors renderLinks' caps).
  const CAP = 20;
  const which =
    owned.slice(0, CAP).map((l) => `\`${l.steam64}\`${l.steamName ? ` (${l.steamName})` : ""}`).join(", ") +
    (owned.length > CAP ? ` +${owned.length - CAP} more` : "");
  await interaction.reply({
    content: `⚠️ Remove **${owned.length}** link${owned.length === 1 ? "" : "s"} for <@${user!.id}>? ${which}`.slice(0, 1990),
    components: [adminConfirmRow(`admin:linkrm:u:${user!.id}`, "Remove all")],
    flags: MessageFlags.Ephemeral,
  });
}

/** Confirm-button dispatch for the owner-only link mutations. Re-gates on the owner id
 *  (defense-in-depth — these only ever appear in the private guild's ephemeral messages,
 *  but a component is never trusted blindly) and edits the prompt in place with the
 *  outcome. customIds: admin:cancel | admin:linkset:<steam64>:<discordId> |
 *  admin:linkrm:s:<steam64> | admin:linkrm:u:<discordId>. */
export async function handleAdminButton(interaction: ButtonInteraction, deps: BotDeps): Promise<void> {
  if (!deps.admin || interaction.user.id !== deps.admin.ownerId) {
    await interaction.reply({ content: "That's an owner-only control.", flags: MessageFlags.Ephemeral });
    return;
  }
  const [, action, a, b] = interaction.customId.split(":");
  if (action === "cancel") {
    await interaction.update({ content: "Cancelled — nothing changed.", components: [] });
    return;
  }
  if (action === "linkset") {
    deps.links.set(a, b);
    await interaction.update({ content: `✅ Linked \`${a}\` → <@${b}>.${LINK_STOPGAP_NOTE}`, components: [] });
    return;
  }
  if (action === "linkrm" && a === "s") {
    const ok = deps.links.remove(b);
    await interaction.update({
      content: ok ? `🗑️ Removed the link for \`${b}\`.${LINK_STOPGAP_NOTE}` : `No link on file for \`${b}\` — nothing to remove.`,
      components: [],
    });
    return;
  }
  if (action === "linkrm" && a === "u") {
    const n = deps.links.removeAllForDiscord(b);
    await interaction.update({
      content: n > 0 ? `🗑️ Removed ${n} link${n === 1 ? "" : "s"} for <@${b}>.${LINK_STOPGAP_NOTE}` : `No links on file for <@${b}>.`,
      components: [],
    });
    return;
  }
  if (action === "sessclear") {
    const n = deps.sessions.clear();
    await interaction.update({ content: `🗑️ Wiped ${n} recorded match${n === 1 ? "" : "es"}.`, components: [] });
    return;
  }
  if (action === "sessdel") {
    const r = deps.sessions.deleteByEndedAt(Number(a));
    await interaction.update({
      content: r
        ? `🗑️ Deleted the match (**${r.ourScore}-${r.theirScore}** ${r.map ?? "?"}).`
        : "That match is no longer on file — nothing deleted (re-run to see the current latest).",
      components: [],
    });
    return;
  }
  if (action === "ttsclear") {
    const removed = deps.tts.clearCache();
    await interaction.update({
      content: `🗑️ Cleared ${removed.entries} cached line${removed.entries === 1 ? "" : "s"} (${formatBytes(removed.bytes)}). Run \`/coachadmin tts prewarm\` to refill.`,
      components: [],
    });
    return;
  }
  await interaction.update({ content: "That control's expired — run the command again.", components: [] });
}

/** Owner `/coachadmin status`: the normal readout plus a per-feed table that exposes each
 *  feed's SteamID64 (hidden from the public status) cross-referenced to its linked Discord
 *  user — so a misconfigured or griefing feed can be identified by who's behind it. */
function renderAdminStatus(deps: BotDeps): string {
  const feeds = deps.feedsDetailed();
  const FEED_CAP = 16;
  const feedLines =
    feeds.length === 0
      ? ["_none connected right now._"]
      : feeds.slice(0, FEED_CAP).map((f) => {
          const tags = [f.isPrimary ? "primary" : null, f.isAuthority ? "authority" : null].filter(Boolean).join("/");
          const role = tags ? ` _(${tags})_` : "";
          const state = f.confirmed ? "✅ confirmed" : `⚠️ ${f.reason ?? "unconfirmed"}`;
          const who = f.discordId ? `<@${f.discordId}>` : "**UNLINKED**";
          return `• **${f.name ?? "?"}** \`${f.steam64}\` → ${who} — ${state}, ${Math.round(f.ageMs / 1000)}s ago${role}`;
        });
  const more = feeds.length > FEED_CAP ? [`_+${feeds.length - FEED_CAP} more_`] : [];
  // The detailed feed table is the POINT of this command, so render it FIRST and let the
  // base readout (also available via /coach status) take the leftover budget — otherwise a
  // busy/griefed lobby's long base status would truncate the table. The "(incl. idle feeds)"
  // note also explains why this count can exceed the base "Feeds:" line, which only counts
  // feeds fresh within feedStaleMs while this lists everything not yet idle-reaped.
  const detailed = [`**Feeds (detailed) — ${feeds.length}** _(incl. idle feeds)_`, ...feedLines, ...more].join("\n");
  return `${detailed}\n\n${renderStatus(deps)}`.slice(0, 1990);
}

/** Owner `/coachadmin links`: every Steam↔Discord pairing on file (the read half of link
 *  management — set/remove land in a later pass). Newest-linked first. */
function renderLinks(deps: BotDeps): string {
  const links = deps.links.list();
  if (links.length === 0) {
    return "No Steam↔Discord links on file yet — they're captured automatically when a friend runs `/coach setup` and then plays a round.";
  }
  const CAP = 25;
  const now = Date.now();
  const rows = links
    .slice(0, CAP)
    .map((l) => `• **${l.steamName ?? "(unknown)"}** \`${l.steam64}\` → <@${l.discordId}> _(${humanAge(now - l.linkedAt)} ago)_`);
  const head = `**Account links — ${links.length} on file**${links.length > CAP ? ` (showing ${CAP})` : ""}`;
  return [head, ...rows].join("\n").slice(0, 1990);
}

/** Compact age formatter (s/m/h/d) for the owner readouts. */
function humanAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
