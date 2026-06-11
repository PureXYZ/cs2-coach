import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../log.js";

/**
 * Remembers the last voice channel across restarts. The file lives in state/
 * (a Docker volume on the hosted deploy), so a redeploy or crash puts the
 * coach straight back into its channel instead of leaving it silently gone.
 */
const STATE_FILE = process.env.VOICE_STATE_FILE ?? "state/voice.json";

export interface SavedVoiceChannel {
  guildId: string;
  channelId: string;
}

export function saveVoiceChannel(saved: SavedVoiceChannel): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(saved), "utf8");
  } catch (err) {
    log.warn("voice", `Could not save voice state: ${err instanceof Error ? err.message : err}`);
  }
}

export function clearVoiceChannel(): void {
  try {
    rmSync(STATE_FILE, { force: true });
  } catch (err) {
    log.warn("voice", `Could not clear voice state: ${err instanceof Error ? err.message : err}`);
  }
}

export function loadVoiceChannel(): SavedVoiceChannel | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<SavedVoiceChannel>;
    if (typeof parsed.guildId === "string" && typeof parsed.channelId === "string") {
      return { guildId: parsed.guildId, channelId: parsed.channelId };
    }
    return null;
  } catch (err) {
    log.warn("voice", `Could not read voice state: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
