# CS2 Coach 🎙️

An AI voice coach for Counter-Strike 2. It reads the game's official **Game State Integration** (GSI) feed while you play Premier/Competitive, decides coaching lines (instant rules + Claude for tactical/economy talks), synthesizes speech, and **speaks them into your Discord voice channel** so you and your friends all hear it.

```
┌─ Gaming PC (Windows) ─┐         ┌─ Laptop (MacBook Air M2) ──────────────────┐
│  CS2 + one .cfg file  │  HTTP   │  GSI listener → tracker → coach engine     │
│  (no software needed) ├────────▶│       ├─ rules (instant lines)             │
└───────────────────────┘  LAN    │       └─ Claude (freezetime tactics)       │
                                  │  → TTS (Deepgram) → Discord voice bot ─────┼──▶ 🔊 your voice channel
                                  └─────────────────────────────────────────────┘
```

**It runs anywhere** — CS2's GSI just POSTs JSON to whatever URL you put in a config file: `127.0.0.1` (same PC, current test setup), a laptop on your LAN, or a cloud host (the zero-footprint end state — the gaming PC then runs nothing at all). See [docs/HOSTING.md](docs/HOSTING.md) for the local → hosted migration; the local performance impact is negligible either way (~100 MB RAM, ~0–2% of one core, no GPU, no game hooks).

## What the coach can and can't know (while you play)

GSI is Valve's official, VAC-safe telemetry feed — but during your own match it deliberately only exposes **your own** state:

| ✅ Available | ❌ Not available (spectator-only) |
|---|---|
| Your HP, armor, money, equipment value, weapons/ammo | Anyone's **position** (even your own) |
| Your kills this round, K/D/A, MVPs | Teammate/enemy health, money, weapons |
| Round phase (freezetime/live/over), bomb planted/defused/exploded | The **kill feed** (who killed whom) |
| Team scores, loss-bonus streaks, per-round win history | Round clock / bomb countdown (derived locally instead) |
| Map, mode, halftime, match point, game over | Grenades, bomb carrier/position |

So the coach does: **economy calls** (buy/save/force from your money + loss bonus), **mid-round decisions** (bomb down on CT → a Claude-made retake-or-save call weighing your gear, kit, HP and the score), **clock callouts** (derived locally: "35 seconds, get a plan", "ten on the bomb"), **special-kill hype** (knife, Zeus, grenade/molotov kills and your own teamkills — detected from your active weapon, inventory diffs and the scoreboard counter), **spectator cheering** (while you're dead, GSI shows the teammate you're watching — the coach cheers their kills by name), **match memory** (a round-by-round story — buys, results, pistols, streaks, highlights — fed into every Claude prompt so advice references what actually happened), **per-map strategy** (freezetime suggestions like nade-stacking a choke on a force buy, from a built-in map playbook), **friend banter** (it reads who's in the voice channel and name-drops, friendly only), **hype** (multikills, MVPs, match point), and **mental coaching** (round losses, halftime talks). It cannot call enemy positions or alive counts — nothing can while you're playing, short of screen-reading (see [docs/RESEARCH.md](docs/RESEARCH.md) for the v2 roadmap).

Bomb-plant note: Valve intentionally delays the plant signal to players by a randomized ~1–2 s (anti-abuse), so plant reactions are slightly late by design.

## Setup

### 0. Prerequisites

- **Node.js ≥ 22.12** on the machine running the coach (the laptop). On macOS: `brew install node`.
- A Discord server where you have admin rights.

### 1. Install

```bash
git clone <this repo>   # or copy the folder to the laptop
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
npm run cfg -- --host 127.0.0.1    # coach on the same PC as CS2 (test setup)
npm run cfg                        # coach on this machine, CS2 elsewhere on the LAN
npm run cfg -- --host <ip-or-domain>  # coach on a specific host (e.g. cloud)
```

This writes `cs2/gamestate_integration_coach.cfg`. Copy that file to the gaming PC at:

```
C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg\
```

Then **restart CS2** (the cfg is only read at launch). If the coach runs on a different machine than CS2, give it a static IP / DHCP reservation — the cfg hardcodes the address. (Remote-host firewall notes are in [docs/HOSTING.md](docs/HOSTING.md).)

### 6. Run it

```bash
npm start
```

In Discord: join a voice channel with your friends, type **`/coach join`**, then queue your match. Check **`/coach status`** to confirm game state is flowing (start a match or warmup — the menu alone sends little). Test the voice with **`/coach say glhf`**.

While running, every raw GSI payload (plus the events derived from it) is appended to `logs/gsi-<timestamp>.ndjson` — one JSON object per line, ~10-30 MB per match. That's the ground truth for debugging missed or wrong detections. Set `GSI_LOG_PAYLOADS=false` to turn it off; old files can be deleted freely.

## Commands

| Command | What it does |
|---|---|
| `/coach join` | Joins the voice channel you're in |
| `/coach leave` | Leaves voice |
| `/coach say <text>` | Speak arbitrary text (test) |
| `/coach status` | GSI freshness, voice/queue, TTS chain, LLM model |

## Costs

| Service | Cost |
|---|---|
| Discord bot | Free |
| GSI | Free (built into CS2) |
| Deepgram TTS | ~$6.75/mo at heavy usage — **$200 signup credit ≈ 2+ years free** |
| Claude (Opus smart tier + Haiku mid-round) | ~$4–10/mo at 20 matches/mo (all-Haiku: ~$1/mo) |

## Is this allowed? (VAC)

Yes. GSI is an official Valve feature (used by every tournament HUD and countless streamer overlays): the game pushes data out over HTTP, nothing reads memory or touches the game process, and the data while playing is deliberately limited by Valve. Stay passive — Valve's Fair Play Guidelines prohibit *automation* (input simulation), which this project never does.

## Roadmap (researched & validated, see [docs/RESEARCH.md](docs/RESEARCH.md))

- **v1.1 — talk to the coach:** voice receive works in @discordjs/voice ≥ 0.19.2 (post-DAVE); pipeline: per-user Opus → mediaplex decode → Deepgram STT → "hey coach" trigger → Claude → TTS. ~$3/mo extra, same Deepgram credit.
- **v1.2 — post-match analysis:** auto-download your Premier demos (official share-code API), parse with demoinfocs-golang → full positions/kill data → Claude match review delivered in Discord.
- **v1.3 — Steam Recording timeline:** kill/death event log written by Steam at session end (post-game only — verified not live).
- **Live kill feed (hard):** only possible via screen capture + OCR on a second machine; VAC-safe but high effort.

## Project layout

```
src/
  index.ts            wiring
  config.ts           env config
  gsi/server.ts       HTTP listener for CS2's POSTs (responds 200 instantly)
  gsi/tracker.ts      payload diffing → events (kills, special kills, teamkills,
                      bomb, rounds, spectated-teammate plays, derived clocks)
  gsi/memory.ts       round-by-round match memory (buys, results, highlights)
  coach/engine.ts     priorities/cooldowns/timers; routes moments to rules or Claude
  coach/lines.ts      instant rule-based line library
  coach/llm.ts        Claude coach: smart tier (freezetime/halftime/match talk)
                      + fast tier (retake calls, round reactions, teamkill roasts)
  coach/knowledge.ts  economy cheat sheet + per-map strategy playbook for prompts
  tts/                deepgram | elevenlabs | edge, with fallback chain
  discord/bot.ts      slash commands
  discord/voice.ts    voice connection + prioritized speech queue
scripts/generate-gsi-cfg.ts   writes the cfg for the gaming PC
scripts/simulate.ts           offline GSI replay harness (npm run sim)
cs2/                  generated gamestate_integration_coach.cfg lands here
```
