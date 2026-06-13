# CS2 Coach 🎙️

An AI voice coach for Counter-Strike 2. While you play Premier or Competitive, it reads the game's official **Game State Integration** (GSI) feed, decides what to say (instant rule-based lines plus Claude for tactical and economy calls), turns it into speech, and **speaks it into your Discord voice channel** — so you and your friends all hear it.

```
┌─ Gaming PC (Windows) ─┐           ┌─ Hosted server (VPS, Docker) ──────────────┐
│  CS2 + one .cfg file  │  HTTP(S)  │  GSI listener → tracker → coach engine     │
│  (no software needed) ├──────────▶│       ├─ rules (instant lines)             │
└───────────────────────┘           │       └─ Claude (freezetime tactics)       │
                                    │  → TTS (Deepgram) → Discord voice bot ─────┼──▶ 🔊 your voice channel
                                    └────────────────────────────────────────────┘
```

**The preferred setup is a hosted server.** CS2's GSI just POSTs JSON to whatever URL you put in a config file, so the gaming PC runs nothing at all — the only trace of the project is that one cfg file. For development you can also run it locally (`127.0.0.1`, same PC); the performance impact is negligible (~100 MB RAM, ~0–2% of one core, no GPU, no game hooks). See [docs/HOSTING.md](docs/HOSTING.md) for both setups and deployment.

## What it can and can't see

GSI is Valve's official, VAC-safe telemetry feed — but during your own match it deliberately exposes only **your own** state:

| ✅ Available | ❌ Not available (spectator-only) |
|---|---|
| Your HP, armor, money, equipment value, weapons/ammo | Anyone's **position** (even your own) |
| Your kills this round, K/D/A, MVPs | **Enemy** health, money, weapons (and teammates' — *unless they run the coach too*) |
| Round phase (freezetime/live/over), bomb planted/defused/exploded | The **kill feed** (who killed whom) |
| Team scores, loss-bonus streaks, per-round win history | Round clock / bomb countdown (derived locally instead) |
| Map, mode, halftime, match point, game over | Grenade trajectories and the bomb's position (your own carried C4 *is* in your inventory) |

So the coach can never call enemy positions or alive counts — nothing can while you're playing; Valve simply doesn't expose that data ([docs/RESEARCH.md](docs/RESEARCH.md) has the full breakdown). Everything below is built within those limits.

> **Bomb-plant timing:** Valve intentionally delays the plant signal to players by a randomized ~1–2 s (anti-abuse), so plant reactions are slightly late by design.

## What the coach does

**Economy**
- Buy / save / force calls from your money and loss bonus.
- Enemy-economy reads — their consecutive losses are the *one* enemy signal GSI sends, and they drive anti-eco warnings and "they can rebuy now" calls.

**Mid-round**
- Retake-or-save calls (Claude weighs your gear, kit, HP, the score and whether you're mid-clutch — it never calls "save" while you're winning a fight, on match point, or into a money reset).
- Clock callouts derived locally: "35 seconds, get a plan", "ten on the bomb" — and when *you're* the one carrying the C4 with no plant, the nudge says so.

**Reactions** — routine 1–2 kill frags stay silent on purpose.
- Special kills — knife, Zeus, grenade/molotov, and your own teamkills, detected from your active weapon, inventory diffs and the scoreboard.
- Multikills and match-point moments.
- Spectator narration — while you're dead, GSI shows the teammate you're watching, so the coach narrates their kills by name.

**Memory**
- Death forensics — died flashed, burned out in your own molly, died holding unthrown nades, repeated opening-second deaths: all remembered and used against you.
- Match memory — a round-by-round story (buys, results, pistols, streaks, highlights) fed into every Claude prompt, so advice references what actually happened.
- Session memory — matches persist to disk, so the coach starts tonight already knowing your recent results, pistol-round record, map record and recurring bad habits, and calls back to them.

**Strategy**
- Freezetime calls from a built-in per-map playbook, rotated through different angles (sites, pace, utility, anti-reads) so it doesn't repeat itself.

**Set pieces** — the long, spoken moments. These run at full reasoning effort; mid-round lines stay tuned for speed.
- Timeout calls and speeches — four straight losses with a tactical timeout in the bank gets called out, and when you take one the coach fills the pause with a regroup speech (theirs gets a jab).
- Mental coaching on round losses and at halftime.
- Post-match wrap-up — 50–90 spoken words on what decided the match, your numbers, and one thing to fix.
- Leetify recap — once [Leetify](https://leetify.com/) finishes parsing the demo (typically 5–15 min) the coach reads their headline numbers out in voice, waiting until you're not mid-game. Needs a Leetify account; the data is spoken live and never stored.

**With friends** — when your squad runs the same cfg, all of the above goes team-wide: synced buy calls, drop suggestions by name, and teammate-highlight callouts, while staying honest about the players it can't see (see [Play with your friends](#7-play-with-your-friends-multi-player)).

The persona throughout is a dry, sarcastic, permanently unimpressed coach — by design.

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
4. Optional but recommended: put your server ID in `DISCORD_GUILD_ID` so slash commands appear instantly instead of within ~1 hour.

### 3. Pick your TTS voice

- **Deepgram (recommended):** sign up at https://console.deepgram.com (no card needed, **$200 free credit** — at this project's usage that's 2+ years free). Put the API key in `DEEPGRAM_API_KEY`.
- **Free fallback:** nothing to do — `edge` (Microsoft Edge voices) works with no key and is already in the fallback chain.

### 4. Claude (optional — the "smart" half of the coach)

Put an Anthropic API key in `ANTHROPIC_API_KEY` (https://platform.claude.com). Without it the coach still works with instant rule-based lines. Two model tiers:

- `COACH_LLM_MODEL` (default `claude-opus-4-8`) — slow moments: freezetime buy calls, halftime talks, match wrap-ups.
- `COACH_LLM_FAST_MODEL` (default `claude-haiku-4-5`) — mid-round moments where a line landing 3 s earlier beats a smarter one: retake/save calls, round-end reactions, teamkill roasts. Set it equal to `COACH_LLM_MODEL` for Opus everywhere.

Optional: `PLAYER_NICKNAME` — the spoken name for you (defaults to your Steam name, which TTS may mangle).

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

In Discord: join a voice channel with your friends, run **`/coach join`**, then queue your match. Check **`/coach status`** to confirm game state is flowing (start a match or warmup — the menu alone sends little), and test the voice with **`/coach say glhf`**.

**Logs.** While running, the coach writes two files per session to `logs/`:

- `gsi-<timestamp>.ndjson` — every raw GSI payload plus the events derived from it, one JSON object per line (~1–5 MB/match). This is the ground truth for debugging a missed or wrong detection: `npm run replay -- logs/gsi-<timestamp>.ndjson` re-derives events from a capture with the current code and diffs them against what the live session said.
- `coach-<timestamp>.log` — mirrored console output (spoken lines, drops, LLM/TTS latency).

Set `GSI_LOG_PAYLOADS=false` to turn the payload capture off; old files can be deleted freely.

### 7. Play with your friends (multi-player)

The coach reads the whole squad, not just you. Each friend's CS2 client only exposes its *own* player to GSI — but pointing several clients at the same coach unions those feeds into a real team view: everyone's money and loadouts, who's alive, who's carrying the bomb, who just popped off.

Setup is the same cfg, shared:

1. You already generated `cs2/gamestate_integration_coach.cfg` in step 5 (pointed at the hosted coach, with the shared `GSI_TOKEN` baked in).
2. **Send that exact same file to each friend.** They drop it in their own `…\csgo\cfg\` folder and restart CS2 — nothing per-friend to edit. Each client tags its own Steam ID, and the coach demuxes the feeds automatically.
3. In `.env`, set `COACH_PRIMARY_STEAM64` to **your** SteamID64 so cross-session memory and the Leetify recap stay tied to your account even if a friend's game connects first. (`/coach status` shows how many feeds are wired in.)

What changes when 2+ of you are wired:

- **Team economy** — freezetime buy calls see everyone's money, so the coach syncs the buy and calls drops by name ("Mouse, you're loaded — drop a rifle for Andy").
- **Named highlights** — a teammate's own triple/quad/ace gets called out by their in-game name (routine kills still stay silent — it aggregates, it doesn't narrate everyone).
- **Honest by default** — the coach only ever speaks about the players it can actually see. It won't claim "you're the last one alive" or "everyone's broke" unless you tell it the squad is fully wired: set `COACH_SQUAD_SIZE` (e.g. `5`) to unlock those whole-team calls. Leave it unset and the coach always hedges to "the players I can see" — safe even if someone forgets to launch.

Set `COACH_TEAM_TACTICS=false` to switch the team-economy/drop calls off and keep the coach focused on you alone.

## Commands

| Command | What it does |
|---|---|
| `/coach join` | Joins the voice channel you're in |
| `/coach leave` | Leaves voice |
| `/coach quiet` | Mutes/unmutes the coach mid-match (game tracking continues) |
| `/coach say <text>` | Speak arbitrary text (test) |
| `/coach status` | GSI freshness, squad feeds wired in, voice/queue, mute state, TTS chain, LLM model, session memory |
| `/coach song [title]` | Plays one of the coach's covers — pick from buttons or pass a title (EZ4ENCE, Xue Hua Piao Piao, Zenzenzense, White Pony); picking while one plays switches songs |
| `/coach stop` | Stops the song; coaching lines resume |

## Costs

| Service | Cost |
|---|---|
| Discord bot | Free |
| GSI | Free (built into CS2) |
| Deepgram TTS | ~$6.75/mo at heavy usage — **$200 signup credit ≈ 2+ years free** |
| Claude (Opus smart tier + Haiku mid-round) | ~$4–10/mo at 20 matches/mo (all-Haiku: ~$1/mo) |
| Leetify post-match stats | Free (their public API; you need a Leetify account) |
| Hosting (VPS) | ~$5/mo ($0 if you run it locally instead) |

## Is this allowed? (VAC)

Yes. GSI is an official Valve feature, used by every tournament HUD and countless streamer overlays: the game pushes data out over HTTP, nothing reads memory or touches the game process, and the data sent while playing is deliberately limited by Valve. Stay passive — Valve's Fair Play Guidelines prohibit *automation* (input simulation), which this project never does.

## Project layout

```
src/
  index.ts            wiring
  config.ts           env config
  gsi/server.ts       HTTP listener for CS2's POSTs (responds 200 instantly)
  gsi/roster.ts       multi-feed demux — fuses you + friends into one team view
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
scripts/simulate.ts           offline synthetic-GSI harness (npm run sim)
scripts/replay-log.ts         re-derives events from a capture and diffs them (npm run replay)
scripts/deploy.ts             pushes the current main to the hosted server (npm run deploy)
cs2/                  generated gamestate_integration_coach.cfg lands here
```
