# CS2 Coach — Research Report

*Compiled June 10, 2026, from a 28-agent research workflow (6 research areas + adversarial verification of every load-bearing claim + 3 gap-filling follow-ups). Claims below marked **verified** survived independent fact-checking by separate agents instructed to refute them.*

## The headline questions

### Can the coach run on the laptop, separate from the gaming PC?

**Yes — verified.** CS2's Game State Integration is push-based: the *game client* HTTP-POSTs JSON to whatever `uri` you put in a cfg file, with no localhost restriction. Production tools do exactly this (cs2mqtt documents a remote-host URI; tournament HUDs POST across machines; an Android bomb-timer app points the cfg at a phone). The gaming PC needs only the single cfg file — no software, no agent, nothing that could affect game performance.

Practical requirements:
- Cfg location (changed from CSGO — note the extra `game\`): `<Steam>\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg\gamestate_integration_<name>.cfg`
- The cfg is read **only at game launch** — edit it, restart CS2. No reload command exists.
- Windows: no firewall changes (outbound allowed by default). macOS: if the application firewall is on, allow incoming for `node` via `socketfilterfw`; macOS 15 also has a "Local Network" privacy permission.
- Bind the listener to `0.0.0.0`, give the laptop a static IP/DHCP reservation.
- Plain HTTP + the cfg's `auth` token block is the standard LAN setup (HTTPS technically supported but cert validation makes it impractical on a LAN IP).
- Engine defaults are slow (`throttle 1.0` ≈ 1 update/sec); set `buffer 0.1` / `throttle 0.1` explicitly for ~100–300 ms event latency. The game won't send the next POST until the previous one gets a 2XX — respond 200 immediately, process async.

### What does GSI provide while *playing* Premier/Competitive?

**Own-player + round-level data only — verified.** This is a deliberate Valve anti-cheat design and is identical in Premier, casual, and community play.

Available while playing:
- `provider` — your SteamID (constant), app version, timestamp
- `map` — name, mode, phase (warmup/live/intermission/gameover), round number, both teams' **scores**, **consecutive_round_losses** (loss-bonus tracking!), timeouts, per-round **win-method history** (`t_win_bomb`, `ct_win_elimination`, …)
- `round` — phase (freezetime/live/over), `bomb` (planted/exploded/defused), `win_team`
- `player` — name, team, activity, **state** (health, armor, helmet, flashed/smoked/burning, **money**, round_kills, round_killhs, **equip_value**, defusekit — round_totaldmg turned out to be observer-only, never sent in play), **weapons** (name/type/ammo/active), **match_stats** (K/A/D, MVPs, score)

Not available while playing (GOTV/spectator-only — verified against library maintainers' 2025–26 statements):
- `allplayers_*` (teammates AND enemies: positions, health, money, weapons — nothing)
- `player_position` (not even your own position)
- `phase_countdowns` (no round clock, no bomb timer — derive locally from phase transitions)
- `bomb` standalone component (carrier/position/countdown), `allgrenades`
- Kill feed (who killed whom) — you only see your own `round_kills` counter increment

Critical implementation gotchas (all encoded in `src/gsi/tracker.ts`):
1. **The player block switches identity when you die** and auto-spectate a teammate. Always compare `player.steamid === provider.steamid` before treating it as the user.
2. **Bomb-plant signal is delayed ~1–2 s randomized** for players (Valve anti-abuse, since 2015, still active per May 2026 maintainer statements). Derived bomb countdowns are approximate.
3. Timing constants for locally derived clocks (1:55 round, 15 s freezetime, 40 s bomb) are community knowledge, not Valve-documented — kept configurable in `.env`.
4. Premier reports `map.mode = "competitive"` (no distinct "premier" value; medium confidence).

### Is it VAC-safe?

**Yes — verified.** GSI is an official Valve feature: the game pushes data outward; nothing reads memory, injects, or overlays. It's used by tournament HUDs and streamer tools universally, with no GSI-related ban reports found. The one bright line from Valve's Fair Play Guidelines: **"Never use any automation for any reason"** — the coach must stay read-only (no input simulation, no auto-pressing keys), which this design respects.

## Discord voice in 2026: the DAVE constraint

**Discord's DAVE end-to-end-encryption protocol became mandatory for all non-stage voice connections on March 1–2, 2026** (verified). Bots without DAVE support are rejected at the voice gateway (close code 4017). This dictates the library choice:

- ✅ **discord.js 14.26.4 + @discordjs/voice 0.19.2** (Node ≥ 22.12) — DAVE ships as a hard dependency via `@snazzah/davey`, with prebuilt binaries for macOS ARM64 and Windows x64 (no compiler needed on either machine). **This is the stack used.**
- ✅ discord.py 2.7.1 `[voice]` — viable second choice (DAVE wheels for mac/win).
- ❌ Pycord — voice broken since DAVE enforcement (issue #3135 open).
- ❌ Any pre-2025 tutorial/library (@discordjs/voice < 0.19, opusscript, sodium deps).

Other verified facts driving the implementation:
- On Node ≥ 22.12 no sodium library is needed (built-in aes-256-gcm).
- **ffmpeg is skippable**: feeding pre-encoded Ogg/Opus or WebM/Opus into `createAudioResource` uses a demux-only path; raw 48 kHz s16le PCM uses an Opus-encode-only path. The TTS providers were chosen to emit these formats natively.
- `@discordjs/opus` is stale and breaks on Apple Silicon; if Opus decode is ever needed (voice receive), use **mediaplex**.
- Queue pattern: one persistent VoiceConnection + one AudioPlayer; play next on `AudioPlayerStatus.Idle`. Never rejoin per clip (each join = handshake + DAVE/MLS group join).
- `GuildVoiceStates` is not a privileged intent. Home NAT works without port forwarding (outbound WSS 443 + UDP hole-punching to ports 50000–65535).

## TTS decision (adversarially re-decided)

The first research pass recommended Cartesia Sonic-3 off a May 2026 benchmark; a follow-up agent querying the live Coval leaderboard found the benchmark methodology changed June 1, 2026 (now counts front-loaded silence), which **reversed the pick**:

| Provider | Perceived TTFA (P50, June 10 2026) | Cost @ ~225K chars/mo | Notes |
|---|---|---|---|
| **Deepgram Aura-2** ✅ primary | ~326 ms (WebSocket) | **$6.75 PAYG — $200 signup credit ≈ 29 months free** | Native 48 kHz; REST `encoding=opus` = Ogg/Opus 48 kHz (zero transcoding for Discord); "energetic" personas (apollo, electra) |
| ElevenLabs Flash v2.5 | ~213 ms (but measured over HTTP/2) | $22/mo (Creator; $11 is first-month promo) | Fastest; native `opus_48000_64`; the upgrade path — implemented as optional provider |
| Cartesia Sonic-3 / 3.5 | 439 ms / 281 ms | $39/mo (Startup; Pro's 100K credits < 225K chars) | Old 188 ms number was masking ~250 ms of leading silence — eliminated on latency *and* price |
| OpenAI TTS | 2,295 ms (tts-1-hd); no WebSocket mode | — | Eliminated for real-time use |
| msedge-tts (free) | decent | $0, no key | Unofficial endpoint, intermittent breakage — implemented as free fallback |
| Azure F0 | unbenchmarked | $0 (500K chars/mo free tier) | Alternative free fallback if edge-tts breaks permanently |

## LLM coaching brain

- **Hybrid architecture validated** by prior art and 2025–26 academic literature on AI game commentary: instant rule/template lines for twitch events (< 100 ms), LLM for freezetime/halftime/match moments.
- Latency: Claude Haiku 4.5 ≈ 0.8 s TTFT + ~93 tok/s → full 80-token line in ~1.6 s; comfortably inside the ~15 s freezetime. Opus 4.8 is slower but smarter — both fit the freezetime window; the engine falls back to rule lines on a 9 s timeout either way.
- Cost (verified June 2026 pricing): Haiku 4.5 ($1/$5 per MTok) ≈ **$0.03/match, $0.58/month** at 20 matches. Opus 4.8 ($5/$25) ≈ 15× that — still only ~$3–9/month. Prompt caching doesn't engage at this prompt size (below the 4096-token minimum cacheable prefix on Haiku).
- No existing project combines CS2 GSI + LLM + Discord voice — closest prior art is `martinszuc/dota-discord-bot` (Dota 2 GSI → TTS → discord.py voice, validates every pipeline link) and `tejashah88/gaming-ai-coach`. This project fills a real gap.
- GSI library landscape: TypeScript is the strong ecosystem (`csgogsi` v5.0.1 used by the Lexogrine HUD ecosystem; `cs2-gsi-z`); Python GSI libs are stale. (This project parses payloads directly — the payload shape is simple enough that a dependency wasn't warranted.)

## v2: talking back to the coach (researched, feasible, not yet built)

- Voice **receive** works in @discordjs/voice 0.19.2 (the DAVE-receive bugs of 0.19.0/0.19.1 were fixed March 2026; zero new receive issues filed since). Caveats: Discord doesn't officially document bot receive; possible brief packet loss during DAVE rekeys when members join/leave.
- Pipeline: `connection.receiver.subscribe(userId, {end: {behavior: AfterSilence, duration: 800}})` → per-user Opus packets → **mediaplex** decode (darwin-arm64 prebuilds) → mono downmix → **Deepgram STT** (Nova-3 streaming $0.0048/min ≈ $2.88 for 10 h/mo, or Flux with built-in end-of-turn detection; same $200 credit as TTS) → gate on a spoken **"hey coach"** trigger phrase in the transcript (wake-word engines like Porcupine cap free tiers at 3 users; push-to-talk is impractical mid-round) → Claude → existing TTS path.
- Set `selfDeaf: false` when joining (v1 joins deafened).
- Consent: Discord policy + privacy law require disclosed consent for voice capture — for a private friend server, an announce-on-join notice ("transcribing for coaching, audio discarded") plus friends' one-time OK covers it.
- Prior art running this exact stack in 2026: `avatarneil/discord-voice` (@discordjs/voice + davey + per-user receive + streaming Deepgram + multi-vendor TTS).

## v2: richer game data (ranked by value × safety ÷ effort)

1. ~~Console log (`-condebug`) kill feed~~ — **dead end for kills**: verified that CS2 removed the CSGO-era kill/damage console lines; console.log carries chat + matchmaking events only. (Still trivially available for chat-triggered commands.)
2. **Post-match demo pipeline** — the highest-value addition. Official share-code Web API (`GetNextMatchSharingCode`) + Game Coordinator client (`boiler-writter` v1.7.0, `node-globaloffensive`) downloads your Premier demos automatically; `demoinfocs-golang` parses full positions/kills/utility for everyone → post-game Claude analysis. Fully official, post-game only.
3. **Steam Game Recording timelines** — CS2 pushes kill/death markers via the Steam Timelines API into `Steam\userdata\<id>\gamerecordings\timelines\timeline_*.json`. **Verified (including on this machine's own Steam files): written once at session end, not incrementally** — so post-game only. Requires background recording enabled (~6% FPS cost). Free structured kill log within seconds of CS2 exit.
4. **Killfeed OCR / radar CV on a second machine** (capture card or OBS→NDI to the Mac) — the *only* live kill-feed option. VAC-safe by architecture (nothing touches the game machine's processes). Prior art exists (Roboflow cs2-kill-feed dataset, YOLOv8 repos). High effort.
5. Dead ends (verified): `-netconport` requires `-tools` mode on Windows (incompatible with matchmaking); live-spectating your own match was removed in CS2; the "parse your own live demo buffer" trick was patched by Valve within a week of publication.

## Key sources

- GSI component availability: antonpup/CounterStrike2GSI (README + issue #12), lupusbytes/cs2mqtt (issue #278), Valve dev wiki (via mirrors; the wiki itself is behind an anti-bot wall), tsuriga/csgo-gsi-qsguide
- DAVE: discord.com/blog (rollout), daveprotocol.com, discordjs/discord.js issues #11419/#11449/#11441, @snazzah/davey npm
- TTS: Coval live leaderboard API (June 10, 2026), vendor pricing pages (Deepgram, Cartesia, ElevenLabs, Azure)
- Anthropic pricing: platform.claude.com/docs (verified June 10, 2026)
- Demos/recording: akiver/boiler-writter, markus-wa/demoinfocs-golang, jackdlogan/steam-cs2-highlight-extractor, ISteamTimeline docs

## v1.1 "smarter coach" research (June 2026, adversarially verified by a second agent pass)

Facts the match-memory / special-kill / mid-round features are built on:

- **Teamkill via GSI**: `player.match_stats.kills` mirrors the scoreboard K column verbatim (raw field, confirmed in antonpup's `MatchStats.cs`), and a teamkill is −1 K (can go negative). Suicide is also −1 K (`mp_suicide_penalty` default 1, still present in CS2) but zeroes health in the same/adjacent payload. ⇒ **kills decrement while alive during live phase = teamkill** is the soundest available heuristic. CSGO-era-verified; no CS2 payload capture exists publicly — worth one in-game test. `player.state.round_kills` teamkill behavior is undocumented everywhere; indirect evidence (every GSI library detects kills via round_kills increments with zero false-positive issue reports) says it counts enemy kills only.
- **Grenade throws & weapon switch**: after a throw completes (~0.5–1 s), CS2 auto-switches to the *best* weapon (primary > pistol > knife) — never another grenade, knife only when no guns are owned. HE fuse ≈ 1.6 s; molotov ignites on impact (≤30° surfaces, 2 s air failsafe) and burns ~7 s. ⇒ kill-attribution windows: HE 4 s, fire 9 s, and "knife active + recent throw" = nade kill (the no-guns eco case).
- **Economy (MR12, verified 2026)**: pistol $800; cap $16 000; win elim/time $3 250, bomb/defuse $3 500; loss ladder $1 400→$3 400 (lost *pistol* pays $1 900; win drops the counter by one, no reset); plant-but-lost +$800 each, planter/defuser +$300; kills — rifles/pistols $300 (CZ75 is $300 since Apr 2024), SMG $600 (P90 $300), shotgun $900 (XM1014 $600), AWP $100, knife $1 500, **Zeus $100** (since Apr 2024), HE/molly $300; **July 2025: every CT gets +$50 per T killed by any CT**; OT (MR3) resets everyone to $10 000 per half.
- **Active Duty pool (June 2026)**: Ancient, Anubis, Dust2, Inferno, Mirage, Nuke, Overpass. Jan 2025 Train↔Vertigo, Jul 2025 Overpass↔Anubis, Jan 22 2026 Anubis↔Train (Anubis returned reworked: hole between E-box and back-of-B, reversed mid doors).
- **Timings**: round 115 s; freezetime 15 s competitive but **20 s in Premier**; C4 40 s; defuse 10 s / 5 s with kit; plant 3.2 s; round-end → next freezetime 7 s.
- Sources: ValveSoftware/csgo-osx-linux#3113, antonpup/CounterStrike2GSI source, cstrike15_src (`weapon_basecsgrenade.cpp`, `hegrenade_projectile.cpp`, `cs_gamerules.cpp`), prosettings.net, refrag.gg, Liquipedia, HLTV news 40693/42197/43600/43689, totalcsgo.com command DB, counterstrike.fandom.com.
