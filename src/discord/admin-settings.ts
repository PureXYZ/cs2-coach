import { config } from "../config.js";
import { runtime, type SquadRecapMode } from "../runtime-overrides.js";
import type { LlmCoach } from "../coach/llm.js";
import type { VoiceCoach } from "./voice.js";

/**
 * The owner-only live-settings control behind `/coachadmin set` and `/coachadmin settings`.
 * A small allowlist of safe keys, each with its own parse/validate/apply — NOT a generic
 * any-field setter. Composed here (not in the bot) because the construction-captured
 * settings (LLM model/effort, volume) live as setters on the LlmCoach/VoiceCoach
 * instances, while the read-live ones flow through the runtime-overrides singleton.
 * Squad size and primary SteamID64 are deliberately absent (env-only).
 */
export interface SettingsControl {
  /** Current live value + env default for every settable key (for the `settings` view). */
  list(): Array<{ key: string; label: string; value: string; envDefault: string }>;
  /** Parse + apply a value to one key. `raw` is null when the value option was omitted. */
  set(key: string, raw: string | null): { ok: boolean; message: string };
}

interface SettingDef {
  key: string;
  label: string;
  current: () => string;
  envDefault: () => string;
  apply: (raw: string | null) => { ok: boolean; message: string };
}

const onOff = (b: boolean): string => (b ? "on" : "off");

/** on/off-style parse; null when unrecognized so the caller can reject with a hint. */
function parseBool(raw: string | null): boolean | null {
  if (raw === null) return null;
  const v = raw.trim().toLowerCase();
  if (["on", "true", "yes", "y", "1", "enable", "enabled"].includes(v)) return true;
  if (["off", "false", "no", "n", "0", "disable", "disabled"].includes(v)) return false;
  return null;
}

export function buildSettingsControl(deps: { llm: LlmCoach | null; voice: VoiceCoach }): SettingsControl {
  const { llm, voice } = deps;

  const boolDef = (
    key: string,
    label: string,
    get: () => boolean,
    set: (v: boolean) => void,
    envDefault: boolean,
  ): SettingDef => ({
    key,
    label,
    current: () => onOff(get()),
    envDefault: () => onOff(envDefault),
    apply: (raw) => {
      const b = parseBool(raw);
      if (b === null) return { ok: false, message: `\`${label}\` takes on/off — got "${raw ?? "(nothing)"}".` };
      set(b);
      return { ok: true, message: `✅ ${label} is now **${onOff(b)}**.` };
    },
  });

  const applyModel = (raw: string | null, set: (m: string) => void, what: string): { ok: boolean; message: string } => {
    if (!llm) return { ok: false, message: "LLM is disabled (no ANTHROPIC_API_KEY) — nothing to set." };
    const m = raw?.trim();
    if (!m) return { ok: false, message: `Give a model id for the ${what}.` };
    set(m);
    return { ok: true, message: `✅ ${what} is now **${m}**. (An unknown id just falls back to canned lines.)` };
  };

  const defs: SettingDef[] = [
    {
      key: "nickname",
      label: "nickname",
      current: () => runtime.nickname ?? "(Steam name)",
      envDefault: () => config.coach.playerNickname ?? "(Steam name)",
      apply: (raw) => {
        const name = raw?.trim() || undefined;
        runtime.setNickname(name);
        return {
          ok: true,
          message: name ? `✅ Coach will call you **${name}**.` : "✅ Nickname cleared — back to your Steam name.",
        };
      },
    },
    boolDef("team-tactics", "team-tactics", () => runtime.teamTactics, (v) => runtime.setTeamTactics(v), config.coach.teamTactics),
    boolDef("warmup-speech", "warmup-speech", () => runtime.warmupSpeech, (v) => runtime.setWarmupSpeech(v), config.coach.warmupSpeech),
    boolDef("debug", "debug logging", () => runtime.debug, (v) => runtime.setDebug(v), config.coach.debug),
    {
      key: "squad-recap",
      label: "squad-recap",
      current: () => runtime.squadRecap,
      envDefault: () => config.leetify.squadRecap,
      apply: (raw) => {
        const v = raw?.trim().toLowerCase();
        if (v !== "off" && v !== "leaders" && v !== "full") {
          return { ok: false, message: `\`squad-recap\` takes off / leaders / full — got "${raw ?? "(nothing)"}".` };
        }
        runtime.setSquadRecap(v as SquadRecapMode);
        return { ok: true, message: `✅ Squad recap mode is now **${v}**.` };
      },
    },
    {
      key: "llm-model",
      label: "llm-model",
      current: () => llm?.currentModel ?? "(LLM disabled)",
      envDefault: () => config.llm.model,
      apply: (raw) => applyModel(raw, (m) => llm!.setModel(m), "smart-tier model"),
    },
    {
      key: "llm-fast-model",
      label: "llm-fast-model",
      current: () => llm?.currentFastModel ?? "(LLM disabled)",
      envDefault: () => config.llm.fastModel,
      apply: (raw) => applyModel(raw, (m) => llm!.setFastModel(m), "mid-round model"),
    },
    {
      key: "llm-effort",
      label: "llm-effort",
      current: () => (llm ? llm.currentEffort || "(omitted)" : "(LLM disabled)"),
      envDefault: () => config.llm.effort || "(omitted)",
      apply: (raw) => {
        if (!llm) return { ok: false, message: "LLM is disabled (no ANTHROPIC_API_KEY) — nothing to set." };
        const v = raw?.trim().toLowerCase();
        if (v !== "low" && v !== "medium" && v !== "high" && v !== "max") {
          return { ok: false, message: `\`llm-effort\` takes low / medium / high / max — got "${raw ?? "(nothing)"}".` };
        }
        llm.setEffort(v);
        return { ok: true, message: `✅ Smart-tier effort is now **${v}**.` };
      },
    },
    {
      key: "volume",
      label: "volume",
      current: () => String(voice.currentVolume),
      envDefault: () => String(config.voice.volume),
      apply: (raw) => {
        const n = Number(raw);
        if (raw === null || raw.trim() === "" || !Number.isFinite(n) || n < 0.1 || n > 2) {
          return { ok: false, message: `\`volume\` takes a number 0.1–2 — got "${raw ?? "(nothing)"}".` };
        }
        voice.setVolume(n);
        const note = n === 1 ? "" : " _(a non-default gain routes audio through ffmpeg — fine on the hosted droplet)_";
        return { ok: true, message: `✅ Coach volume is now **${n}**.${note}` };
      },
    },
  ];

  const byKey = new Map(defs.map((d) => [d.key, d]));
  return {
    list: () => defs.map((d) => ({ key: d.key, label: d.label, value: d.current(), envDefault: d.envDefault() })),
    set: (key, raw) => {
      const def = byKey.get(key);
      if (!def) return { ok: false, message: `Unknown setting "${key}".` };
      return def.apply(raw);
    },
  };
}
