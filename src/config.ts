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

export type TtsProviderName = "deepgram" | "elevenlabs" | "edge";

export const config = {
  gsi: {
    port: intEnv("GSI_PORT", 3000),
    // Echoed by CS2 in every payload (from the cfg's auth block). Empty = accept all.
    token: optional("GSI_TOKEN"),
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
    },
    elevenlabs: {
      apiKey: optional("ELEVENLABS_API_KEY") || undefined,
      voiceId: optional("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb"),
      modelId: optional("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5"),
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
    // claude-opus-4-8 = smartest. For lower latency/cost set COACH_LLM_MODEL=claude-haiku-4-5.
    model: optional("COACH_LLM_MODEL", "claude-opus-4-8"),
    maxTokens: intEnv("COACH_LLM_MAX_TOKENS", 150),
    // Freezetime is ~15s; if Claude hasn't answered by then the line is useless.
    timeoutMs: intEnv("COACH_LLM_TIMEOUT_MS", 9000),
  },

  coach: {
    // Spoken name the coach uses for the player ("Nice one, Andy!"). Defaults to Steam name.
    playerNickname: optional("PLAYER_NICKNAME") || undefined,
  },

  // CS2 Premier/Competitive timing constants (MR12 era). GSI sends no clock to players,
  // so these drive locally derived timers. Not officially documented by Valve — adjust
  // here if Valve changes them.
  timings: {
    freezetimeSeconds: intEnv("FREEZETIME_SECONDS", 15),
    roundSeconds: intEnv("ROUND_SECONDS", 115),
    bombSeconds: intEnv("BOMB_SECONDS", 40),
  },
} as const;
