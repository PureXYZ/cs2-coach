import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function intEnv(name: string, fallback: number, min?: number, max?: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  // Reject trailing garbage ("3000abc") and decimals — parseInt would silently truncate.
  if (!/^-?\d+$/.test(raw.trim())) throw new Error(`${name} must be an integer, got "${raw}"`);
  const n = Number.parseInt(raw, 10);
  // Fail at startup, not as a silent per-request 422 that demotes the provider.
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
    throw new Error(`${name} must be between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

function floatEnv(name: string, fallback: number, min?: number, max?: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  // Reject trailing garbage ("1.2abc") — parseFloat is lenient and would silently truncate.
  if (!/^-?\d+(?:\.\d+)?$/.test(raw.trim())) throw new Error(`${name} must be a number, got "${raw}"`);
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  // Fail at startup, not as a silent per-request 422 that demotes the provider.
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
    throw new Error(`${name} must be between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

export type TtsProviderName = "deepgram" | "elevenlabs" | "edge";

/** A selectable ElevenLabs coach voice (the choices behind `/coach voice`). */
export interface CoachVoice {
  /** Stable slug — the Discord choice value and the key persisted on switch. */
  key: string;
  /** Human label shown in Discord (e.g. "Coach"). */
  label: string;
  /** The ElevenLabs voice id this speaks with. */
  voiceId: string;
  /** Per-voice speech-rate multiplier (ElevenLabs, 0.7–1.2). Undefined = inherit
   *  the global ELEVENLABS_SPEED. */
  speed?: number;
  /** Per-voice playback gain (0.1–2, like COACH_VOLUME). Undefined = inherit the
   *  global COACH_VOLUME. Applied at playback only when ElevenLabs synthesized the line. */
  volume?: number;
}

// ElevenLabs accepts a 0.7–1.2 speech-rate multiplier; playback gain matches
// COACH_VOLUME's 0.1–2 range. Shared so the env validation and the dashboards agree.
const VOICE_SPEED_RANGE = [0.7, 1.2] as const;
const VOICE_VOLUME_RANGE = [0.1, 2] as const;

/**
 * Validate an optional per-voice numeric setting peeled off an ELEVENLABS_VOICES
 * entry. The value is already known-numeric (the peel only takes numeric tails),
 * so this just range-checks it — a typo'd speed would otherwise reach ElevenLabs
 * as a per-line 422 and silently demote the provider; a typo'd volume would just
 * play at a wrong gain. Fail loudly at startup instead, like floatEnv.
 */
function voiceSetting(
  raw: string | undefined,
  field: "speed" | "volume",
  entry: string,
  [min, max]: readonly [number, number],
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseFloat(raw);
  if (n < min || n > max) {
    throw new Error(
      `ELEVENLABS_VOICES entry "${entry}" ${field} must be between ${min} and ${max}, got "${raw}"`,
    );
  }
  return n;
}

/** label → stable slug for the Discord choice value / persisted selection. */
function voiceKey(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Parse ELEVENLABS_VOICES — a comma-separated list of `Label:voiceId[:speed[:volume]]`
 * entries, the first of which is the default switchable voice. `speed` (0.7–1.2)
 * and `volume` (0.1–2) are optional per-voice overrides of the global
 * ELEVENLABS_SPEED / COACH_VOLUME; omit them to inherit the globals (to set only
 * volume, give speed too, since they're positional). When the list is unset there's
 * a single unnamed voice using `fallbackVoiceId` (ELEVENLABS_VOICE_ID), so the app
 * works with no voice list configured. Throws on a malformed list rather than
 * silently shipping a broken voice id. (Voice ids/names are deployment config —
 * they live in the env, never hard-coded here.)
 */
function parseVoices(raw: string, fallbackVoiceId: string): CoachVoice[] {
  if (!raw.trim()) return [{ key: "default", label: "Default", voiceId: fallbackVoiceId }];
  const voices: CoachVoice[] = [];
  const seen = new Set<string>();
  const seenVoiceIds = new Set<string>();
  const numeric = /^\d+(?:\.\d+)?$/;
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    // A label may contain colons but a voiceId never does, so parse from the
    // RIGHT: peel up to two trailing NUMERIC fields (speed then volume) off the
    // end — but never the colon that separates Label from voiceId (keep one).
    // What's left is the original `Label:voiceId`, split on its last colon as before.
    let work = entry;
    const settings: string[] = [];
    while (settings.length < 2) {
      const dot = work.lastIndexOf(":");
      if (dot < 0) break;
      const tail = work.slice(dot + 1).trim();
      const head = work.slice(0, dot);
      // Stop if the tail isn't a number, or peeling it would consume the
      // Label:voiceId colon (so a digit-only voiceId is never mistaken for a setting).
      if (!numeric.test(tail) || !head.includes(":")) break;
      settings.unshift(tail);
      work = head;
    }
    const [speedRaw, volumeRaw] = settings;
    const sep = work.lastIndexOf(":");
    const label = sep > 0 ? work.slice(0, sep).trim() : "";
    const voiceId = sep > 0 ? work.slice(sep + 1).trim() : "";
    if (!label || !voiceId) {
      throw new Error(`ELEVENLABS_VOICES entry "${entry}" must be "Label:voiceId" (optionally ":speed:volume")`);
    }
    // Discord caps a slash-command choice name at 100 chars — fail loudly here
    // rather than letting addChoices() throw opaquely and break registration of
    // every command.
    if (label.length > 100) {
      throw new Error(`ELEVENLABS_VOICES label "${label}" exceeds Discord's 100-character limit`);
    }
    // ElevenLabs voice ids are alphanumeric. Reject a typo at startup instead of
    // shipping it into the request URL and getting a per-line 4xx that silently
    // demotes the provider mid-match (same reasoning as intEnv/floatEnv above).
    // The format reminder also catches a mis-typed setting that landed in the
    // voiceId slot (e.g. a stray "1.5" or "0.9x" — those fail this same check).
    if (!/^[A-Za-z0-9]+$/.test(voiceId)) {
      throw new Error(
        `ELEVENLABS_VOICES entry "${entry}" has an invalid voiceId "${voiceId}" — expected "Label:voiceId[:speed[:volume]]" (speed 0.7-1.2, volume 0.1-2)`,
      );
    }
    // Per-voice speed/volume are resolved by voiceId (findVoiceById), so the same
    // id across two entries would make every lookup return the FIRST entry's
    // tuning — a silently wrong rate/gain for the rest. Give each switchable voice
    // a distinct id; fail loudly here like the other malformed-list cases.
    if (seenVoiceIds.has(voiceId)) {
      throw new Error(`ELEVENLABS_VOICES lists voiceId "${voiceId}" more than once — each switchable voice needs a distinct voice id`);
    }
    seenVoiceIds.add(voiceId);
    const speed = voiceSetting(speedRaw, "speed", entry, VOICE_SPEED_RANGE);
    const volume = voiceSetting(volumeRaw, "volume", entry, VOICE_VOLUME_RANGE);
    // Disambiguate colliding/empty slugs so every choice value stays unique.
    const base = voiceKey(label) || `voice-${voices.length + 1}`;
    let key = base;
    for (let n = 2; seen.has(key); n++) key = `${base}-${n}`;
    seen.add(key);
    voices.push({ key, label, voiceId, speed, volume });
  }
  if (voices.length === 0) throw new Error("ELEVENLABS_VOICES is set but contains no valid voices");
  return voices;
}

// A valid SteamID64 is the literal 7656 prefix + 13 digits (17 digits total).
// Shared so config validation and the multi-feed roster agree on what binds.
export const STEAMID64_RE = /^7656\d{13}$/;

// COACH_PRIMARY_STEAM64 must be a real SteamID64 or it silently never matches a
// feed's provider.steamid — the primary then never binds and memory/Leetify
// quietly attach to whoever connects first. Fail loudly at startup instead.
function steamId64Env(name: string): string | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  if (!STEAMID64_RE.test(raw)) {
    throw new Error(`${name} must be a 17-digit SteamID64 (7656…), got "${raw}"`);
  }
  return raw;
}

// COACH_LLM_EFFORT is passed straight to the Anthropic API; a typo'd value would
// otherwise reach the provider and fail per-request. Validate it loudly at startup
// instead. Empty string is allowed (it means "omit the effort field").
function effortEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw === "") return "";
  const valid = ["low", "medium", "high", "max"];
  if (!valid.includes(raw)) {
    throw new Error(`${name} must be one of ${valid.join(", ")} (or empty to omit), got "${raw}"`);
  }
  return raw;
}

// GSI_TOKEN is interpolated verbatim into the generated KeyValues cfg; a quote,
// space or newline would break that file's syntax. Restrict it to cfg-safe chars
// and fail at startup rather than emit a malformed cfg.
function tokenEnv(name: string): string {
  const raw = process.env[name] ?? "";
  if (raw !== "" && !/^[A-Za-z0-9._-]+$/.test(raw)) {
    throw new Error(
      `${name} must contain only letters, digits, dot, dash or underscore (no quotes/spaces/newlines), got an invalid value`,
    );
  }
  return raw;
}

export const config = {
  gsi: {
    port: intEnv("GSI_PORT", 3000, 1, 65535),
    // Echoed by CS2 in every payload (from the cfg's auth block). Empty = accept all.
    token: tokenEnv("GSI_TOKEN"),
    // Append every payload (+ derived events) to logs/gsi-*.ndjson for offline analysis.
    logPayloads: optional("GSI_LOG_PAYLOADS", "true") !== "false",
    // Multi-feed: a teammate's feed counts as "connected/fresh" (toward alive
    // counts, team economy and the whole-team-certainty gate) only within this
    // many ms of its last payload. Must sit ABOVE the 10s cfg heartbeat — an
    // alive-but-idle player can go ~10s between payloads, and a tighter window
    // would falsely mark them gone (and could mis-fire a last-man call). 15s
    // matches the engine's own PAYLOAD_FRESH_MS, sized off captured 11s gaps.
    // (Death itself is detected from the player block, not from this timeout.)
    feedStaleMs: intEnv("GSI_FEED_STALE_MS", 15000),
    // A feed silent this long is reaped (the friend closed CS2 / left): its
    // per-feed tracker and roster entry are dropped. Well above the 10s cfg
    // heartbeat so a normal between-rounds lull never evicts a live player.
    feedIdleMs: intEnv("GSI_FEED_IDLE_MS", 60000),
    // Multi-feed: when the global-event authority is re-elected (the active feed
    // went silent), two feeds can briefly emit the same round/bomb transition.
    // A second copy of the same global type within this window is dropped. Real
    // matches never repeat a global this fast, so the only effect is collapsing
    // that re-election overlap. (The sim sets this to 0 to test back-to-back
    // matches in compressed time.)
    globalSeamMs: intEnv("GSI_GLOBAL_SEAM_MS", 4000),
    // A last-man-alive call is only honest while the death that caused it is
    // recent; past this the situation has likely already resolved. Drives the
    // freshness gate on last-man framing.
    lastManFreshMs: intEnv("GSI_LASTMAN_FRESH_MS", 3000),
    // Auto-prune logs/ files (coach-*.log, gsi-*.ndjson, decisions-*.ndjson)
    // older than this at startup, so an always-on droplet doesn't fill its disk.
    // 0 = keep forever.
    logRetentionDays: intEnv("GSI_LOG_RETENTION_DAYS", 14),
  },

  discord: {
    token: required("DISCORD_TOKEN"),
    // If set, slash commands register instantly in this one server.
    // Without it, global registration can take up to an hour to appear.
    guildId: optional("DISCORD_GUILD_ID") || undefined,
  },

  tts: {
    // Order to try providers in. Any provider missing credentials is skipped.
    order: (optional("TTS_PROVIDER", "deepgram,edge")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) as TtsProviderName[],
    deepgram: {
      apiKey: optional("DEEPGRAM_API_KEY") || undefined,
      // aura-2-apollo-en / aura-2-electra-en are the "energetic" personas.
      model: optional("DEEPGRAM_TTS_MODEL", "aura-2-apollo-en"),
      // Deepgram's Opus default is a muffled 12 kbps; 64 kbps matches Discord's
      // own voice bitrate. Billing is per character, so this costs nothing extra.
      bitrate: intEnv("DEEPGRAM_TTS_BITRATE", 64000),
    },
    elevenlabs: {
      apiKey: optional("ELEVENLABS_API_KEY") || undefined,
      // The switchable coach voices (first = default). From ELEVENLABS_VOICES (a
      // named list) when set; otherwise a single voice using ELEVENLABS_VOICE_ID.
      voices: parseVoices(
        optional("ELEVENLABS_VOICES"),
        optional("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb"),
      ),
      modelId: optional("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5"),
      // 0–1 scale (the dashboard shows these as percentages).
      stability: floatEnv("ELEVENLABS_STABILITY", 0.3, 0, 1),
      similarityBoost: floatEnv("ELEVENLABS_SIMILARITY", 1.0, 0, 1),
      style: floatEnv("ELEVENLABS_STYLE", 0.5, 0, 1),
      // Speech rate multiplier, unlike the others — ElevenLabs accepts 0.7–1.2.
      // The DEFAULT rate; a voice can override it per-entry in ELEVENLABS_VOICES.
      speed: floatEnv("ELEVENLABS_SPEED", 1.0, 0.7, 1.2),
    },
    edge: {
      voice: optional("EDGE_TTS_VOICE", "en-US-GuyNeural"),
    },
  },

  voice: {
    // Playback gain applied to the coach's spoken lines in the Discord voice channel.
    // 1.0 (default) = source level, and keeps the zero-transcode fast path: the
    // provider's Opus is demuxed straight to Discord — no codec, no re-encode. Any
    // OTHER value routes the audio through an Opus decode → gain → re-encode pass
    // (handled by @discordjs/voice's inline volume, which pulls in `opusscript`) and
    // adds only a few ms of latency (benchmarked ~5 ms to first audio; steady-state
    // ~100x real-time), so only set it for a deliberate server-wide level change. The
    // added lag is imperceptible next to the ~200-330 ms TTS time-to-first-audio.
    // 0.9 = 10% quieter; 2 = +6 dB
    // (may clip). Range 0.1–2 — silencing the coach is /coach mute's job, not a 0 here.
    // This affects coach lines only — playlist songs always play at source level.
    // For a per-listener change, Discord's right-click → User Volume slider is better.
    // The DEFAULT gain; an ElevenLabs voice can override it per-entry in ELEVENLABS_VOICES.
    volume: floatEnv("COACH_VOLUME", 1.0, 0.1, 2),
  },

  llm: {
    // The Claude-powered tactical coach. Disabled automatically when no API key is set;
    // the rule engine still provides instant lines either way.
    apiKey: optional("ANTHROPIC_API_KEY") || undefined,
    enabled: !!process.env.ANTHROPIC_API_KEY && optional("LLM_ENABLED", "true") !== "false",
    // Smart tier — slow moments (freezetime, halftime, match end) where quality wins.
    // claude-opus-4-8 = smartest. For lower latency/cost set COACH_LLM_MODEL=claude-haiku-4-5.
    model: optional("COACH_LLM_MODEL", "claude-opus-4-8"),
    // Fast tier — mid-round moments (retake/save call, round-end react, teamkill) where a
    // line that lands 3 seconds earlier beats a smarter one. Set to the same value as
    // COACH_LLM_MODEL if you'd rather have Opus everywhere.
    fastModel: optional("COACH_LLM_FAST_MODEL", "claude-haiku-4-5"),
    // Reasoning effort for the smart tier (low | medium | high | max). Opus 4.8
    // defaults to "high"; "low" is ~20% faster for these one-liner replies.
    // Only sent on smart-tier calls (Haiku errors on it); empty string = omit.
    effort: effortEnv("COACH_LLM_EFFORT", "low"),
    maxTokens: intEnv("COACH_LLM_MAX_TOKENS", 150),
    // Freezetime is ~15s; if Claude hasn't answered by then the line is useless.
    timeoutMs: intEnv("COACH_LLM_TIMEOUT_MS", 9000),
    // Mid-round calls go stale even faster (a retake call is worthless at 12s post-plant).
    fastTimeoutMs: intEnv("COACH_LLM_FAST_TIMEOUT_MS", 6000),
  },

  coach: {
    // Spoken name the coach uses for the player ("Nice one, Andy!"). Defaults to Steam name.
    playerNickname: optional("PLAYER_NICKNAME") || undefined,

    // The coach's own PUBLIC address — where CS2 should POST its game state. The
    // single source of truth baked into the cfg by both `npm run cfg` and the
    // `/coach setup` Discord command. A full https:// URL (TLS on 443) or
    // http://host:port is used verbatim; a bare host/IP becomes http://host:GSI_PORT.
    // Point it at a stable DOMAIN so a server IP change never breaks an installed
    // cfg. Required for `/coach setup` (the bot can't self-detect its public address
    // from inside a container). Unset = `npm run cfg` falls back to the LAN IP (dev).
    publicHost: optional("COACH_PUBLIC_HOST") || undefined,

    // --- multi-feed team coaching (friends running the same GSI cfg) ---
    // The PRIMARY feed is the user whose Steam account owns cross-session memory
    // and the Leetify recap. Set it to your SteamID64 so those bind to YOUR
    // account even if a friend's CS2 connects to the coach first. Unset = adopt
    // the first feed seen and pin it for the session (correct when you run solo).
    // A malformed id used to silently never bind the primary (it could never
    // match a real provider.steamid); steamId64Env now throws at startup instead.
    primarySteam64: steamId64Env("COACH_PRIMARY_STEAM64"),
    // How many of you run the coach. Setting this is the ONLY thing that lets the
    // coach speak with whole-team certainty ("you're the last one alive",
    // "everyone's broke"). Leave it unset and the coach always hedges to "the
    // players I can see" — safe even when someone forgets to launch the cfg.
    squadSize: intEnv("COACH_SQUAD_SIZE", 0, 0, 5) || undefined,
    // Team-economy tactics: buy-sync calls and named drop suggestions at
    // freezetime, plus last-man framing. On by default; set false to keep the
    // coach focused on the primary player and skip the team-econ calls.
    teamTactics: optional("COACH_TEAM_TACTICS", "true") !== "false",
    // A longer pre-match scouting SPEECH during the warmup window (before round 1),
    // where there's no buy call to race. When the Leetify match-start feature is on
    // (LEETIFY_MATCH_START) the speech leans on the player's map/recent form. On by
    // default; safe even if CS2 sends little/no warmup (the speech is simply dropped
    // the instant round 1 goes live, never played over the pistol buy). Set false to
    // keep match start to the single round-1 greeting line.
    warmupSpeech: optional("COACH_WARMUP_SPEECH", "true") !== "false",
    // Verbose tracing: turns on log.debug() output (the silent-drop reasons the
    // engine emits, etc.). Off by default — this is noisy and only for diagnosing
    // why a moment did or didn't speak.
    debug: optional("COACH_DEBUG") === "true",
    // Append every spoken/fallback decision to logs/decisions-*.ndjson for offline
    // review of what the coach chose to say (text redacted for Leetify recaps).
    // Off by default.
    logDecisions: optional("COACH_LOG_DECISIONS") === "true",
  },

  leetify: {
    // After the match, poll Leetify (they parse the demo server-side) and
    // SPEAK the headline numbers in voice once they land — only between
    // games, never mid-match. Needs the player to have a Leetify account;
    // works keyless at stricter rate limits.
    enabled: optional("LEETIFY_ENABLED", "true") !== "false",
    apiKey: optional("LEETIFY_API_KEY") || undefined,
    // Enrich the match-start line / warmup speech with the player's Leetify form —
    // a single keyless /v3/profile fetch (no demo-parse wait) gives map W/L, "you
    // just played this map", recent direction and an aim trend, spoken QUALITATIVELY
    // (no numbers) the moment the map is known. On by default; needs a Leetify
    // account. Independent of the post-match recap (LEETIFY_ENABLED gates both).
    matchStart: optional("LEETIFY_MATCH_START", "true") !== "false",
    // Squad recap mode, used only when friends are wired AND team tactics are on:
    // "full" (default) reads a short line for every wired friend so the coach can
    // roast the whole board; "leaders" only names whoever topped each stat (gentler
    // — won't air a friend's worst number); "off" keeps the recap to the player alone.
    squadRecap: (["leaders", "full", "off"].includes(optional("LEETIFY_SQUAD_RECAP", "full"))
      ? optional("LEETIFY_SQUAD_RECAP", "full")
      : "full") as "leaders" | "full" | "off",
  },

  // CS2 Premier/Competitive timing constants (MR12 era). GSI sends no clock to players,
  // so these drive locally derived timers. Not officially documented by Valve — adjust
  // here if Valve changes them. Note: Premier freezetime is 20s (competitive MM is 15);
  // only ROUND_SECONDS/BOMB_SECONDS feed the clock callouts, so the default is safe either way.
  timings: {
    freezetimeSeconds: intEnv("FREEZETIME_SECONDS", 15),
    roundSeconds: intEnv("ROUND_SECONDS", 115),
    bombSeconds: intEnv("BOMB_SECONDS", 40),
  },
} as const;
