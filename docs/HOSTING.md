# Running the coach: hosted vs. local

The app is one self-contained Node process configured entirely by env vars, so the same code runs on a cloud host or on the gaming PC. The only moving part is **where CS2 sends its GSI POSTs** — the `uri` in `gamestate_integration_coach.cfg`.

## Hosted (preferred)

The whole app runs on a cloud host. The gaming PC runs **nothing** — the only trace of the project is the cfg file, and the HTTP POSTs the game itself makes (the same thing tournament players' machines do; no measurable FPS cost).

```
┌─ Gaming PC ────────────┐   HTTPS/HTTP   ┌─ Cloud (VPS / Railway / Fly) ─┐
│ CS2 + cfg file only    ├───────────────▶│ coach app (this repo)         │──▶ Discord voice
└────────────────────────┘    internet    │ → Deepgram TTS, Claude API    │
                                          └───────────────────────────────┘
```

Everything the app talks to (Discord gateway, Deepgram, Anthropic) is outbound from the host — the one *inbound* requirement is the GSI endpoint CS2 POSTs to.

### Option A — small VPS (most certain to work, ~$5/mo)

Hetzner (~€4), DigitalOcean ($6), Lightsail ($5), etc.

1. Install Docker, clone the repo, create `.env` (same vars as local).
2. `docker build -t cs2-coach . && docker run -d --restart unless-stopped --env-file .env -p 3000:3000 cs2-coach`
3. Generate the cfg against the VPS: `npm run cfg -- --host <vps-public-ip>` and copy it to the gaming PC's CS2 cfg folder; restart CS2.

GSI then POSTs over plain HTTP to the VPS. That's acceptable because the payload is just your own game state and the `auth` token (already enforced by the server) rejects strangers — but it is the open internet, so prefer Option B's HTTPS or put the port behind a firewall rule allowing only your home IP.

### Option B — PaaS with HTTPS (cleanest, ~$5/mo)

Railway / Render / Fly.io build straight from the repo (the `Dockerfile` is ready), give you a stable `https://...` domain with a real certificate, and manage restarts/env vars in a dashboard.

Point the cfg at the HTTPS URL (no port): `"uri" "https://your-app.up.railway.app"`.

**One caveat:** Valve documents HTTPS support for GSI with strict certificate validation. A PaaS domain has a globally trusted cert so it *should* pass, but verify it on first deploy (watch the host logs for incoming POSTs after a CS2 restart). If HTTPS turns out flaky, fall back to Option A's plain HTTP + token.

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
docker run -d --name coach --restart unless-stopped --env-file .env \
  -p 3000:3000 -v coach-state:/app/state cs2-coach
sleep 5
docker logs --tail 8 coach 2>&1
```

(The `coach-state` volume persists the last-joined voice channel — so a restarted coach rejoins automatically; `/coach leave` clears it — the `/coach voice` selection, and `sessions.json`, the cross-session match history the coach's "remember last night" callbacks come from.)

Two ways to trigger it:

1. **Manual:** `npm run deploy` — SSHes into `DEPLOY_HOST` (set in `.env`) and runs the script.
2. **Automatic:** the `Deploy` GitHub Actions workflow runs the same script on every push to main. It needs two repo secrets (Settings → Secrets and variables → Actions): `DEPLOY_HOST` (e.g. `root@1.2.3.4`) and `DEPLOY_SSH_KEY` (the private half of a dedicated keypair whose public half sits in the host's `authorized_keys`, prefixed with `restrict,command="/root/deploy.sh"` — so even a leaked key can only trigger a deploy, nothing else).

**Caveat learned the hard way:** DigitalOcean App Platform (and similar gVisor-sandboxed PaaS) cannot run this app — they block the UDP traffic Discord voice needs, so `/coach join` times out even though the bot logs in. Use a real VM (droplet/VPS).

### Operational tips

- `GET http://<host>:3000/` is a health check returning the last-payload age — point an uptime monitor at it.
- Keep `GSI_TOKEN` long and random (it's the only auth on the GSI endpoint).
- If the host or container restarts, the bot rejoins the last voice channel on its own (persisted in the `coach-state` volume).
- The cross-session match history lives in the same volume (`state/sessions.json`, capped at 50 matches) — deleting it just resets the coach's memory of past sessions, nothing else breaks.

## Local (dev/testing)

Everything on the gaming PC: the cfg points at `http://127.0.0.1:3000`, and `npm start` runs the coach alongside the game.

**Performance impact is negligible.** The coach is an idle event loop that wakes for ~10 small JSON POSTs/second during action; audio is passed through pre-encoded (no transcoding) and TTS/LLM work happens on remote APIs. Expect ~100 MB RAM and ~0–2% of one core — far below what Discord's own client uses. No GPU use, no game hooks, nothing injected.

Re-point the cfg at the hosted server later with `npm run cfg -- --host <host>` and re-copy it to the CS2 cfg folder (the cfg is only read at game launch).
