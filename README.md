# CS2 Coach 🎙️

An AI voice coach for Counter-Strike 2. It reads the game's official **Game State Integration** (GSI) feed while you play Premier/Competitive, decides coaching lines (instant rules + Claude for tactical/economy talks), synthesizes speech, and **speaks them into your Discord voice channel** so you and your friends all hear it.

```
┌─ Gaming PC (Windows) ─┐           ┌─ Hosted server (VPS, Docker) ──────────────┐
│  CS2 + one .cfg file  │  HTTP(S)  │  GSI listener → tracker → coach engine     │
│  (no software needed) ├──────────▶│       ├─ rules (instant lines)             │
└───────────────────────┘           │       └─ Claude (freezetime tactics)       │
                                    │  → TTS (Deepgram) → Discord voice bot ─────┼──▶ 🔊 your voice channel
                                    └─────────────────────────────────────────────┘
```

**The preferred setup is a hosted server** — CS2's GSI just POSTs JSON to whatever URL you put in a config file, so the gaming PC runs nothing at all; the only trace of the project is the cfg file. For development you can also run it locally (`127.0.0.1` on the same PC) — the performance impact is negligible (~100 MB RAM, ~0–2% of one core, no GPU, no game hooks). See [docs/HOSTING.md](docs/HOSTING.md) for both setups and deployment.

## What the coach can and can't know (while you play)

GSI is Valve's official, VAC-safe telemetry feed — but during your own match it deliberately only exposes **your own** state:

| ✅ Available | ❌ Not available (spectator-only) |
|---|---|
| Your HP, armor, money, equipment value, weapons/ammo | Anyone's **position** (even your own) |
| Your kills this round, K/D/A, MVPs | Teammate/enemy health, money, weapons |
| Round phase (freezetime/live/over), bomb planted/defused/exploded | The **kill feed** (who killed whom) |
| Team scores, loss-bonus streaks, per-round win history | Round clock / bomb countdown (derived locally instead) |
| Map, mode, halftime, match point, game over | Grenade trajectories, the bomb's position (your own carried C4 *is* visible in your inventory) |

So the coach does: **economy calls** (buy/save/force from your money + loss bonus), **enemy-economy reads** (the one enemy signal GSI does send — their consecutive losses — drives anti-eco warnings and "they can rebuy now" calls), **mid-round decisions** (bomb down on CT → a Claude-made retake-or-save call weighing your gear, kit, HP, the score and whether you're visibly mid-clutch — it never calls "save" while you're winning a fight, on match point, or into a money reset), **clock callouts** (derived locally: "35 seconds, get a plan", "ten on the bomb" — and when *you* are the one carrying the C4 with no plant, the nudge says so), **timeout calls** (four straight losses with a tactical timeout in the bank gets called out), **special-kill reactions** (knife, Zeus, grenade/molotov kills and your own teamkills — detected from your active weapon, inventory diffs and the scoreboard counter; routine 1–2 kill frags stay silent on purpose), **spectator narration** (while you're dead, GSI shows the teammate you're watching — the coach narrates their kills by name), **death forensics** (died flashed, burned out in your own molly, died holding unthrown nades, repeated opening-second deaths — all remembered and used against you), **match memory** (a round-by-round story — buys, results, pistols, streaks, highlights — fed into every Claude prompt so advice references what actually happened), **session memory** (matches persist to disk, so the coach comes into tonight knowing your recent results, pistol-round record, map record and recurring bad habits — and calls back to them), **per-map strategy** (freezetime calls from a built-in map playbook, rotated through different angles — sites, pace, utility, anti-reads — so it doesn't repeat itself), **multikill/match-point reactions**, **timeout speeches** (your tactical timeout gets a proper regroup speech filling the pause; theirs gets a jab), **mental coaching** (round losses, halftime talks), and a **post-match wrap-up speech** (after the match the coach takes the floor for 50–90 spoken words — what decided it, your numbers, one thing to fix; once [Leetify](https://leetify.com/) finishes parsing the demo — typically 5–15 minutes — the coach also reads their headline numbers out in voice, waiting for a moment when you're *not* mid-game; needs a Leetify account, data spoken live and never stored). The slow moments (wrap-up, timeout speech) run at full reasoning effort; the mid-round lines stay tuned for speed. The persona is a dry, sarcastic, permanently unimpressed coach — by design. It cannot call enemy positions or alive counts — nothing can while you're playing; Valve simply doesn't expose that data (see [docs/RESEARCH.md](docs/RESEARCH.md) for the full breakdown).

Bomb-plant note: Valve intentionally delays the plant signal to players by a randomized ~1–2 s (anti-abuse), so plant reactions are slightly late by design.

## Setup

These steps work the same whether the coach runs on a hosted server (preferred — see [docs/HOSTING.md](docs/HOSTING.md) for Docker deployment) or locally for development.

### 0. Prerequisites

- **Node.js ≥ 22.12** on the machine running the coach (the hosted setup uses Docker instead — the `Dockerfile` handles this).
- A Discord server where you have admin rights.

### 1. Install

```bash
git clone <this repo>
cd cs2-coach
npm install
cp .env.example .env
```

### 2. Create the Discord bot

1. Go to https://discord.com/developers/applications → **New Application** → name it (e.g. "CS2 Coach").
2. **Bot** tab → **Reset Token** → copy it into `DISCORD_TOKEN` in `.env`. (No privileged intents needed.)
3. **OAuth2 → URL Generator**: check scopes `bot` + `applications.commands`; bot permissions `View Channels`, `Connect`, `Speak`. Open the generated URL and invite the bot to your server.
4. Optional but recommended: put your server ID in `DISCORD_GUILD_ID` (slash commands appear instantly instead of within ~1 hour).

### 3. Pick your TTS voice

- **Deepgram (recommended):** sign up at https://console.deepgram.com (no card needed, **$200 free credit** — at this project's usage that's 2+ years free). Put the API key in `DEEPGRAM_API_KEY`.
- **Free fallback:** nothing to do — `edge` (Microsoft Edge voices) works with no key and is already in the fallback chain.

### 4. Claude (optional, the "smart" half of the coach)

Put an Anthropic API key in `ANTHROPIC_API_KEY` (https://platform.claude.com). Without it the coach still works with instant rule-based lines. Two model tiers:

- `COACH_LLM_MODEL` (default `claude-opus-4-8`) — slow moments: freezetime buy calls, halftime talks, match wrap-ups.
- `COACH_LLM_FAST_MODEL` (default `claude-haiku-4-5`) — mid-round moments where a line landing 3 s earlier beats a smarter one: retake/save calls, round-end reactions, teamkill roasts. Set it equal to `COACH_LLM_MODEL` for Opus everywhere.

Optional personality: `PLAYER_NICKNAME` (spoken name for you — defaults to your Steam name, which TTS may mangle).

### 5. Generate + install the GSI config (the only thing CS2 needs)

```bash
npm run cfg -- --host <ip-or-domain>   # coach on the hosted server (preferred)
npm run cfg -- --host 127.0.0.1        # coach on the same PC as CS2 (dev/testing)
```

This writes `cs2/gamestate_integration_coach.cfg`. Copy that file to the gaming PC at:

```
C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg\
```

Then **restart CS2** (the cfg is only read at launch). The cfg hardcodes the address, so the coach host needs a stable IP or domain. (Hosting details are in [docs/HOSTING.md](docs/HOSTING.md).)

### 6. Run it

On the hosted server it runs as a Docker container — `npm run deploy` (or a push to main) builds and restarts it; see [docs/HOSTING.md](docs/HOSTING.md). Locally:

```bash
npm start        # dev: runs the TypeScript directly via tsx
npm run play     # match day: compiles, then runs the lighter build (node dist/)
```

Either way the process drops itself to below-normal CPU priority at startup, so it can't steal frames from CS2 on a shared PC.

In Discord: join a voice channel with your friends, type **`/coach join`**, then queue your match. Check **`/coach status`** to confirm game state is flowing (start a match or warmup — the menu alone sends little). Test the voice with **`/coach say glhf`**.

While running, every raw GSI payload (plus the events derived from it) is appended to `logs/gsi-<timestamp>.ndjson` — one JSON object per line, ~1-5 MB per match. That's the ground truth for debugging missed or wrong detections: `npm run replay -- logs/gsi-<timestamp>.ndjson` re-derives events from a capture with the current code and diffs them against what the live session said. Console output is mirrored to `logs/coach-<timestamp>.log` (spoken lines, drops, LLM/TTS latency). Set `GSI_LOG_PAYLOADS=false` to turn the payload capture off; old files can be deleted freely.

## Commands

| Command | What it does |
|---|---|
| `/coach join` | Joins the voice channel you're in |
| `/coach leave` | Leaves voice |
| `/coach quiet` | Mutes/unmutes the coach mid-match (game tracking continues) |
| `/coach say <text>` | Speak arbitrary text (test) |
| `/coach status` | GSI freshness, voice/queue, mute state, TTS chain, LLM model, session memory |
| `/coach song [title]` | Plays one of the coach's covers in the voice channel — pick from buttons, or pass a title directly (EZ4ENCE, Xue Hua Piao Piao, Zenzenzense, White Pony); picking while one plays switches songs |
| `/coach stop` | Stops the song; coaching lines resume |

## Costs

| Service | Cost |
|---|---|
| Discord bot | Free |
| GSI | Free (built into CS2) |
| Deepgram TTS | ~$6.75/mo at heavy usage — **$200 signup credit ≈ 2+ years free** |
| Claude (Opus smart tier + Haiku mid-round) | ~$4–10/mo at 20 matches/mo (all-Haiku: ~$1/mo) |
| Leetify post-match stats | Free (their public API; the player needs a Leetify account) |
| Hosting (VPS) | ~$5/mo ($0 if you run it locally instead) |

## Is this allowed? (VAC)

Yes. GSI is an official Valve feature (used by every tournament HUD and countless streamer overlays): the game pushes data out over HTTP, nothing reads memory or touches the game process, and the data while playing is deliberately limited by Valve. Stay passive — Valve's Fair Play Guidelines prohibit *automation* (input simulation), which this project never does.

## Project layout

```
src/
  index.ts            wiring
  config.ts           env config
  gsi/server.ts       HTTP listener for CS2's POSTs (responds 200 instantly)
  gsi/tracker.ts      payload diffing → events (kills, special kills, teamkills,
                      bomb, rounds, spectated-teammate plays, derived clocks)
  gsi/memory.ts       round-by-round match memory (buys, results, highlights,
                      death forensics)
  coach/engine.ts     priorities/cooldowns/timers; routes moments to rules or Claude
  coach/lines.ts      instant rule-based line library
  coach/llm.ts        Claude coach: smart tier (freezetime/halftime/match talk)
                      + fast tier (retake calls, round reactions, teamkill roasts)
                      + long-form speeches (wrap-up, timeout talk, Leetify recap)
  coach/knowledge.ts  economy cheat sheet + per-map strategy playbook for prompts
  coach/session-store.ts  cross-session match history (state/sessions.json) →
                      "recent form" lines for the prompts
  coach/debrief.ts    builds the per-match session record at match end
  leetify.ts          Leetify public-API client (post-match stats, spoken live,
                      never stored)
  tts/                deepgram | elevenlabs | edge, with fallback chain
  discord/bot.ts      slash commands
  discord/voice.ts    voice connection + prioritized speech queue
scripts/generate-gsi-cfg.ts   writes the cfg for the gaming PC
scripts/simulate.ts           offline GSI replay harness (npm run sim)
scripts/deploy.ts             pushes the current main to the hosted server (npm run deploy)
cs2/                  generated gamestate_integration_coach.cfg lands here
```
