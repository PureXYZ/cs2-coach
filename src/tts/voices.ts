import { config, type CoachVoice } from "../config.js";
import { loadJsonState, saveJsonState } from "../json-state.js";
import { log } from "../log.js";

export type { CoachVoice } from "../config.js";

/**
 * Which ElevenLabs voice the coach speaks with right now. The registry of
 * switchable voices comes from config (the ELEVENLABS_VOICES env, or a single
 * fallback voice); the live selection is persisted to state/ — a Docker volume
 * on the hosted deploy — so a `/coach voice` switch survives a redeploy or crash,
 * exactly like the joined voice channel does (see discord/voice-state.ts).
 */
const STATE_FILE = process.env.VOICE_SELECTION_FILE ?? "state/voice-selection.json";

/** The full list of switchable voices (config registry; always ≥1). */
export function voices(): CoachVoice[] {
  return config.tts.elevenlabs.voices;
}

/** Look a voice up by its slug (the Discord choice value). */
export function findVoice(key: string): CoachVoice | undefined {
  return voices().find((v) => v.key === key);
}

// Lazily resolved on first use (so the startup deprecation log fires once, in
// order), then cached and updated in place by setVoice().
let current: CoachVoice | null = null;

/** The voice in effect right now. */
export function currentVoice(): CoachVoice {
  if (!current) current = resolveInitial();
  return current;
}

/** The ElevenLabs voice id to synthesize with when a line gives no override. */
export function currentVoiceId(): string {
  return currentVoice().voiceId;
}

/**
 * Switch the coach voice and persist it. Returns the new voice, or null if the
 * key isn't one of the registry voices (so the caller can reject it).
 */
export function setVoice(key: string): CoachVoice | null {
  const voice = findVoice(key);
  if (!voice) return null;
  current = voice;
  saveSelection(voice.key);
  log.info("tts", `Coach voice set to ${voice.label} (${voice.voiceId})`);
  return voice;
}

/** Startup default: a still-valid persisted pick, else the first configured voice. */
function resolveInitial(): CoachVoice {
  const registry = voices();
  const savedKey = loadSelection();
  if (savedKey) {
    const saved = registry.find((v) => v.key === savedKey);
    if (saved) return saved;
    log.warn("tts", `Saved voice "${savedKey}" is no longer configured — using the default`);
  }
  return registry[0];
}

function saveSelection(key: string): void {
  saveJsonState(STATE_FILE, "tts", { key });
}

function loadSelection(): string | null {
  return loadJsonState(STATE_FILE, "tts", (raw) => {
    const parsed = raw as { key?: unknown };
    return typeof parsed?.key === "string" ? parsed.key : null;
  });
}
