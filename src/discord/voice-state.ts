import { clearJsonState, loadJsonState, saveJsonState } from "../json-state.js";

/**
 * Remembers the last voice channel across restarts. The file lives in state/
 * (a Docker volume on the hosted deploy), so a redeploy or crash puts the
 * coach straight back into its channel instead of leaving it silently gone.
 */
const STATE_FILE = process.env.VOICE_STATE_FILE ?? "state/voice.json";

/** Mute (`/coach quiet`) lives in its own file so a redeploy doesn't silently
 *  un-mute the coach — the saved voice channel is already restored on restart, so
 *  mute being the one thing that resets was an inconsistency. */
const QUIET_FILE = process.env.QUIET_STATE_FILE ?? "state/quiet.json";

export interface SavedVoiceChannel {
  guildId: string;
  channelId: string;
}

export function saveVoiceChannel(saved: SavedVoiceChannel): void {
  saveJsonState(STATE_FILE, "voice", saved);
}

export function clearVoiceChannel(): void {
  clearJsonState(STATE_FILE, "voice");
}

export function loadVoiceChannel(): SavedVoiceChannel | null {
  return loadJsonState(STATE_FILE, "voice", (raw) => {
    const parsed = raw as Partial<SavedVoiceChannel>;
    if (typeof parsed?.guildId === "string" && typeof parsed?.channelId === "string") {
      return { guildId: parsed.guildId, channelId: parsed.channelId };
    }
    return null;
  });
}

export function saveQuiet(on: boolean): void {
  saveJsonState(QUIET_FILE, "quiet", { on });
}

/** Restored mute state; defaults to false (speaking) when nothing's saved or the
 *  file is unreadable — i.e. exactly today's behaviour for a fresh install. */
export function loadQuiet(): boolean {
  return (
    loadJsonState(QUIET_FILE, "quiet", (raw) => {
      const parsed = raw as { on?: unknown };
      return typeof parsed?.on === "boolean" ? parsed.on : null;
    }) ?? false
  );
}
