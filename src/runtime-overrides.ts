import { config } from "./config.js";

/**
 * Session-scoped runtime overrides for a handful of config settings, so the owner can
 * tweak them live via `/coachadmin set` without a redeploy. Mirrors the tts/voices.ts
 * module-singleton pattern: ONE mutable object, seeded from the frozen config at import,
 * read LIVE by each consumer on every use.
 *
 * NOT persisted — a restart reverts every value to its env default (the user's deliberate
 * choice, same as the session-scoped mute flag), so a forgotten live tweak can never
 * silently outlive the session. Only settings consumers already read live each use belong
 * here; settings captured at object construction (LLM model/effort, playback volume) are
 * overridden via setters on those objects instead (LlmCoach/VoiceCoach), not here.
 */

export type SquadRecapMode = "off" | "leaders" | "full";

interface Overrides {
  nickname: string | undefined;
  teamTactics: boolean;
  warmupSpeech: boolean;
  squadRecap: SquadRecapMode;
  debug: boolean;
}

const overrides: Overrides = {
  nickname: config.coach.playerNickname,
  teamTactics: config.coach.teamTactics,
  warmupSpeech: config.coach.warmupSpeech,
  squadRecap: config.leetify.squadRecap,
  debug: config.coach.debug,
};

/** Live view + setters. Consumers import `runtime` and read its getters in place of
 *  the corresponding `config.*` value; the owner admin surface drives the setters. */
export const runtime = {
  get nickname(): string | undefined {
    return overrides.nickname;
  },
  setNickname(v: string | undefined): void {
    overrides.nickname = v;
  },
  get teamTactics(): boolean {
    return overrides.teamTactics;
  },
  setTeamTactics(v: boolean): void {
    overrides.teamTactics = v;
  },
  get warmupSpeech(): boolean {
    return overrides.warmupSpeech;
  },
  setWarmupSpeech(v: boolean): void {
    overrides.warmupSpeech = v;
  },
  get squadRecap(): SquadRecapMode {
    return overrides.squadRecap;
  },
  setSquadRecap(v: SquadRecapMode): void {
    overrides.squadRecap = v;
  },
  get debug(): boolean {
    return overrides.debug;
  },
  setDebug(v: boolean): void {
    overrides.debug = v;
  },
};
