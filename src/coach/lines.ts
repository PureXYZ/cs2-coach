// Canned lines, persona: a sarcastic, snide, perpetually unimpressed esports
// coach — the user's explicit preference (consensual roast). Spoken register on
// purpose: short sentences, contractions, CS slang, the occasional swear. The
// informational payload (buy calls, retake/save, scores, clocks) must survive
// every joke; sarcasm is the wrapper, never the content. Authored via a
// writers-room workflow (4 comedic lenses → per-group judges), hand-curated.
//
// Barrel module: the line pools and builders are split by domain under ./lines/
// (pure reorganization, zero behavior change). This file re-exports the complete
// public surface so every `import { ... } from ".../lines.js"` keeps working, and
// owns cacheableLineTexts() — the only cross-domain aggregator.

export { pick } from "./lines/pick.js";
export { mapDisplayName } from "./lines/maps.js";
export { economyLine } from "./lines/economy.js";
export {
  bombPlantedLine,
  bombDefusedLine,
  bombExplodedLine,
  lateRoundLine,
  lateRoundCarrierNamed,
  bombTenLine,
  retakeDecisionLine,
} from "./lines/bomb.js";
export {
  killLine,
  knifeKillLine,
  zeusKillLine,
  nadeKillLine,
  lowHpKillLine,
  teamkillLine,
  teammateKillLine,
  teammateMultiKillLine,
  teammateMultiKillDuo,
  lastManStandingLine,
  deathLine,
  mvpLine,
} from "./lines/kills.js";
export {
  matchStartLine,
  warmupSpeechLine,
  roundWonLine,
  roundLostLine,
  halfEndLine,
  otNextLine,
  otHalfLine,
  halftimeLine,
  matchPointLine,
  matchEndLine,
} from "./lines/rounds.js";
export {
  timeoutCallLine,
  ourTimeoutSpeechLine,
  theirTimeoutLine,
  leetifyRecapLine,
} from "./lines/breaks.js";
export { squadOpeningDeathsLine, tiltLine } from "./lines/squad.js";

// The cacheable pools live with their builders; import them here only to keep the
// TTS whitelist a single concatenation (see cacheableLineTexts below).
import {
  BOMB_TEN_CT_FIGHTING,
  BOMB_TEN_CT,
  BOMB_TEN_T_FIGHTING,
  BOMB_TEN_T,
  BOMB_TEN_NEUTRAL,
  LATE_ROUND_CARRIER,
  LATE_ROUND_T,
  LATE_ROUND_CT,
  LATE_ROUND_NEUTRAL,
  PLANTED_CT,
  PLANTED_T,
  PLANTED_NEUTRAL,
  DEFUSED_CT,
  DEFUSED_T,
  DEFUSED_NEUTRAL,
  EXPLODED_T,
  EXPLODED_CT,
  EXPLODED_NEUTRAL,
} from "./lines/bomb.js";
import { ZEUS_KILL } from "./lines/kills.js";
import { MATCH_POINT_US, MATCH_POINT_THEM } from "./lines/rounds.js";

/**
 * Every static, fully-resolved line the TTS layer is allowed to pre-synthesize and
 * cache (no score/name/HP/money interpolation). Single source of truth for the TTS
 * cache whitelist + the prewarm list — these are the same const arrays the pick()
 * functions above draw from, so a line edited in one place can never drift from the
 * cache. Raw (un-normalized) strings: the TTS layer normalizes once at synth time.
 */
export function cacheableLineTexts(): string[] {
  return [
    ...BOMB_TEN_CT_FIGHTING, ...BOMB_TEN_CT, ...BOMB_TEN_T_FIGHTING, ...BOMB_TEN_T, ...BOMB_TEN_NEUTRAL,
    ...LATE_ROUND_CARRIER, ...LATE_ROUND_T, ...LATE_ROUND_CT, ...LATE_ROUND_NEUTRAL,
    ...ZEUS_KILL,
    ...PLANTED_CT, ...PLANTED_T, ...PLANTED_NEUTRAL,
    ...DEFUSED_CT, ...DEFUSED_T, ...DEFUSED_NEUTRAL,
    ...EXPLODED_T, ...EXPLODED_CT, ...EXPLODED_NEUTRAL,
    ...MATCH_POINT_US, ...MATCH_POINT_THEM,
  ];
}
