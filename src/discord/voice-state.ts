import { clearJsonState, loadJsonState, saveJsonState } from "../json-state.js";

/**
 * Remembers the last voice channel across restarts. The file lives in state/
 * (a Docker volume on the hosted deploy), so a redeploy or crash puts the
 * coach straight back into its channel instead of leaving it silently gone.
 */
const STATE_FILE = process.env.VOICE_STATE_FILE ?? "state/voice.json";

export interface SavedVoiceChannel {
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
    if (typeof parsed?.channelId === "string") {
      return { channelId: parsed.channelId };
    }
    return null;
  });
}
