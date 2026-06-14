# Running the coach: hosted vs. local

The app is one self-contained Node process configured entirely by env vars, so the same code runs on a cloud host or on the gaming PC. The only moving part is **where CS2 sends its GSI POSTs** — the `uri` in `gamestate_integration_coach.cfg`.

## Hosted (preferred)

The whole app runs on a cloud host. The gaming PC runs **nothing** — the only trace of the project is the cfg file, and the HTTP POSTs the game itself makes (the same thing tournament players' machines do; no measurable FPS cost).

```
┌─ Gaming PC ────────────┐    HTTPS       ┌─ DigitalOcean droplet ────────┐
│ CS2 + cfg file only    ├───────────────▶│ caddy :443 (TLS) ─▶ coach     │──▶ Discord voice
└────────────────────────┘    internet    │ :3000 → Deepgram / 11Labs     │
                                          │ → Claude API                  │
                                          └───────────────────────────────┘
```

Everything the app talks to (Discord gateway, Deepgram/ElevenLabs, Anthropic) is outbound from the host — the one *inbound* requirement is the GSI endpoint CS2 POSTs to, which Caddy fronts with HTTPS.

### The setup — droplet + Caddy reverse proxy

The coach runs as a Docker container on a small VPS (a DigitalOcean droplet, ~$6/mo; Hetzner/Lightsail/etc. work identically) behind [Caddy](https://caddyserver.com), which terminates TLS and reverse-proxies to it. Caddy auto-provisions and renews a Let's Encrypt certificate for the coach's domain, so GSI POSTs arrive over real HTTPS with nothing to manage. Valve's GSI does strict certificate validation; a Let's Encrypt cert is globally trusted, so it passes.

Both containers share a user-defined Docker network (`web`) so Caddy can reach the coach by container name. The coach publishes **no** host ports — it's reachable only through Caddy.

One-time setup on the host:

1. Point a DNS A record (e.g. `coach.example.com`) at the droplet's IP, and set `COACH_PUBLIC_HOST=https://coach.example.com` in `.env`.
2. Create the shared network: `docker network create web`.
3. Write `/root/Caddyfile` — one block routes the domain to the coach container:
   ```
   coach.example.com {
       reverse_proxy coach:3000
       log
   }
   ```
4. Start Caddy (publishes 80/443, persists the issued certs in a volume so they survive a restart):
   ```bash
   docker run -d --name caddy --restart unless-stopped --network web \
     -p 80:80 -p 443:443 \
     -v /root/Caddyfile:/etc/caddy/Caddyfile \
     -v caddy_data:/data -v caddy_config:/config \
     caddy:2
   ```
5. Build and start the coach on the same network (the `deploy.sh` below does this), then generate the cfg against the domain and copy it to the gaming PC's CS2 cfg folder: `npm run cfg -- --host coach.example.com`; restart CS2.

Watch the host logs for incoming POSTs after a CS2 restart to confirm the round-trip.

A PaaS that builds from the `Dockerfile` and hands you an HTTPS domain (Railway / Render / Fly.io) skips the Caddy step — but it **must** be a real VM; gVisor-sandboxed platforms like DigitalOcean App Platform block the UDP that Discord voice needs (see the caveat below).

### Hosted vs. local — what's different? Honestly, almost nothing

| Concern | Effect |
|---|---|
| GSI update latency | +20–60 ms internet RTT. The game waits for each 2XX before the next POST, so effective rate drops from ~10/s to ~5–8/s. Irrelevant for coaching lines. |
| Discord voice | Cloud → Discord is usually *better* than residential routing. |
| Secrets | Discord/Deepgram/Anthropic keys live in the host's env vars. |
| The cfg file | Generated once with the host's address; done. |

### Updating the hosted coach

The host keeps a git clone of the public repo and a deploy script at `/root/deploy.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /root/cs2-coach
git pull --ff-only
docker build -t cs2-coach .
docker rm -f coach >/dev/null 2>&1 || true
docker run -d --name coach --restart unless-stopped --network web --env-file .env \
  -v coach-state:/app/state cs2-coach
sleep 5
docker logs --tail 8 coach 2>&1
```

(The `coach-state` volume persists the last-joined voice channel — so a restarted coach rejoins automatically; `/coach leave`, or the coach auto-leaving an emptied channel, clears it — the `/coach voice` selection, and `sessions.json`, the cross-session match history the coach's "remember last night" callbacks come from.)

Two ways to trigger it:

1. **Manual:** `npm run deploy` — SSHes into `DEPLOY_HOST` (set in `.env`) and runs the script.
2. **Automatic:** the `Deploy` GitHub Actions workflow runs the same script on every push to main. It needs two repo secrets (Settings → Secrets and variables → Actions): `DEPLOY_HOST` (e.g. `root@1.2.3.4`) and `DEPLOY_SSH_KEY` (the private half of a dedicated keypair whose public half sits in the host's `authorized_keys`, prefixed with `restrict,command="/root/deploy.sh"` — so even a leaked key can only trigger a deploy, nothing else).

**Caveat learned the hard way:** DigitalOcean App Platform (and similar gVisor-sandboxed PaaS) cannot run this app — they block the UDP traffic Discord voice needs, so `/coach join` times out even though the bot logs in. Use a real VM (droplet/VPS).

### Operational tips

- `GET https://<domain>/` is a health check returning the last-payload age (Caddy proxies it through to the coach) — point an uptime monitor at it.
- Keep `GSI_TOKEN` long and random (it's the only auth on the GSI endpoint).
- If the host or container restarts, the bot rejoins the last voice channel on its own (persisted in the `coach-state` volume).
- The cross-session match history lives in the same volume (`state/sessions.json`, capped at 50 matches) — deleting it just resets the coach's memory of past sessions, nothing else breaks.

## Local (dev/testing)

Everything on the gaming PC: the cfg points at `http://127.0.0.1:3000`, and `npm start` runs the coach alongside the game.

**Performance impact is negligible.** The coach is an idle event loop that wakes for ~10 small JSON POSTs/second during action; at unity volume audio is passed through pre-encoded (no transcoding), and a non-unity `COACH_VOLUME` or per-voice gain adds a lightweight per-line ffmpeg transcode (so running locally with a gain needs ffmpeg on PATH — `winget install Gyan.FFmpeg` / `apt install ffmpeg`). TTS/LLM work happens on remote APIs. Expect ~100 MB RAM and ~0–2% of one core — far below what Discord's own client uses. No GPU use, no game hooks, nothing injected.

Re-point the cfg at the hosted server later with `npm run cfg -- --host <host>` and re-copy it to the CS2 cfg folder (the cfg is only read at game launch).
