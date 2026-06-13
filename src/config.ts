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

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
}

function floatEnv(name: string, fallback: number, min?: number, max?: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  // Fail at startup, not as a silent per-request 422 that demotes the provider.
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
    throw new Error(`${name} must be between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

export type TtsProviderName = "deepgram" | "elevenlabs" | "edge";

export const config = {
  gsi: {
    port: intEnv("GSI_PORT", 3000),
    // Echoed by CS2 in every payload (from the cfg's auth block). Empty = accept all.
    token: optional("GSI_TOKEN"),
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
      voiceId: optional("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb"),
      modelId: optional("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5"),
      // 0–1 scale (the dashboard shows these as percentages).
      stability: floatEnv("ELEVENLABS_STABILITY", 0.3, 0, 1),
      similarityBoost: floatEnv("ELEVENLABS_SIMILARITY", 1.0, 0, 1),
      style: floatEnv("ELEVENLABS_STYLE", 0.5, 0, 1),
      // Speech rate multiplier, unlike the others — ElevenLabs accepts 0.7–1.2.
      speed: floatEnv("ELEVENLABS_SPEED", 1.0, 0.7, 1.2),
    },
    edge: {
      voice: optional("EDGE_TTS_VOICE", "en-US-GuyNeural"),
    },
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
    effort: optional("COACH_LLM_EFFORT", "low"),
    maxTokens: intEnv("COACH_LLM_MAX_TOKENS", 150),
    // Freezetime is ~15s; if Claude hasn't answered by then the line is useless.
    timeoutMs: intEnv("COACH_LLM_TIMEOUT_MS", 9000),
    // Mid-round calls go stale even faster (a retake call is worthless at 12s post-plant).
    fastTimeoutMs: intEnv("COACH_LLM_FAST_TIMEOUT_MS", 6000),
  },

  coach: {
    // Spoken name the coach uses for the player ("Nice one, Andy!"). Defaults to Steam name.
    playerNickname: optional("PLAYER_NICKNAME") || undefined,

    // --- multi-feed team coaching (friends running the same GSI cfg) ---
    // The PRIMARY feed is the user whose Steam account owns cross-session memory
    // and the Leetify recap. Set it to your SteamID64 so those bind to YOUR
    // account even if a friend's CS2 connects to the coach first. Unset = adopt
    // the first feed seen and pin it for the session (correct when you run solo).
    primarySteam64: optional("COACH_PRIMARY_STEAM64") || undefined,
    // How many of you run the coach. Setting this is the ONLY thing that lets the
    // coach speak with whole-team certainty ("you're the last one alive",
    // "everyone's broke"). Leave it unset and the coach always hedges to "the
    // players I can see" — safe even when someone forgets to launch the cfg.
    squadSize: intEnv("COACH_SQUAD_SIZE", 0) || undefined,
    // Team-economy tactics: buy-sync calls and named drop suggestions at
    // freezetime, plus last-man framing. On by default; set false to keep the
    // coach focused on the primary player and skip the team-econ calls.
    teamTactics: optional("COACH_TEAM_TACTICS", "true") !== "false",
  },

  leetify: {
    // After the match, poll Leetify (they parse the demo server-side) and
    // SPEAK the headline numbers in voice once they land — only between
    // games, never mid-match. Needs the player to have a Leetify account;
    // works keyless at stricter rate limits.
    enabled: optional("LEETIFY_ENABLED", "true") !== "false",
    apiKey: optional("LEETIFY_API_KEY") || undefined,
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
