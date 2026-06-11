# Running the coach: local vs. hosted

The app is one self-contained Node process configured entirely by env vars, so the same code runs on the gaming PC, a laptop, or a cloud host. The only moving part is **where CS2 sends its GSI POSTs** — the `uri` in `gamestate_integration_coach.cfg`.

## Mode 1 — everything on the gaming PC (testing, current setup)

The cfg points at `http://127.0.0.1:3000`, and `npm start` runs the coach alongside the game.

**Performance impact is negligible.** The coach is an idle event loop that wakes for ~10 small JSON POSTs/second during action; audio is passed through pre-encoded (no transcoding) and TTS/LLM work happens on remote APIs. Expect ~100 MB RAM and ~0–2% of one core — far below what Discord's own client uses. No GPU use, no game hooks, nothing injected.

Re-point the cfg later with: `npm run cfg -- --host <new-host>` and re-copy it to the CS2 cfg folder.

## Mode 1.5 — another machine on your LAN (e.g. a laptop)

Same as Mode 1, but generate the cfg on the laptop with `npm run cfg` (auto-detects its LAN IP) and give it a DHCP reservation. If macOS's firewall is enabled, allow Node to accept connections:

```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$(which node)"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$(which node)"
```

(macOS 15+ may also show a "Local Network" permission prompt — approve it.) Windows-side: nothing; outbound is allowed by default.

## Mode 2 — fully hosted (the "zero footprint" end state)

Move the whole app to a cloud host. Then the gaming PC runs **nothing** — the only trace of the project is the cfg file, and the HTTP POSTs the game itself makes (the same thing tournament players' machines do; no measurable FPS cost).

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
3. Regenerate the cfg against the VPS: `npm run cfg -- --host <vps-public-ip>` and copy it to the gaming PC's CS2 cfg folder; restart CS2.

GSI then POSTs over plain HTTP to the VPS. That's acceptable because the payload is just your own game state and the `auth` token (already enforced by the server) rejects strangers — but it is the open internet, so prefer Option B's HTTPS or put the port behind a firewall rule allowing only your home IP.

### Option B — PaaS with HTTPS (cleanest, ~$5/mo)

Railway / Render / Fly.io build straight from the repo (the `Dockerfile` is ready), give you a stable `https://...` domain with a real certificate, and manage restarts/env vars in a dashboard.

Point the cfg at the HTTPS URL (no port): `"uri" "https://your-app.up.railway.app"`.

**One caveat to verify on first deploy:** Valve documents HTTPS support for GSI with strict certificate validation. A PaaS domain has a globally trusted cert so it *should* pass, but this is the one link we couldn't fully verify in research — test it before tearing down the local setup (watch the host logs for incoming POSTs after a CS2 restart). If HTTPS turns out flaky, fall back to Option A's plain HTTP + token.

### What changes vs. local — honestly, almost nothing

| Concern | Effect |
|---|---|
| GSI update latency | +20–60 ms internet RTT. The game waits for each 2XX before the next POST, so effective rate drops from ~10/s to ~5–8/s. Irrelevant for coaching lines. |
| Discord voice | Cloud → Discord is usually *better* than residential routing. |
| Secrets | Discord/Deepgram/Anthropic keys move to the host's env vars. |
| The cfg file | Regenerate once with the host's address; done. |
| Mac setup | Never needed. |

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

(The `coach-state` volume persists the last-joined voice channel, so a restarted coach rejoins automatically; `/coach leave` clears it.)

Two ways to trigger it:

1. **Manual:** `npm run deploy` — SSHes into `DEPLOY_HOST` (set in `.env`) and runs the script.
2. **Automatic:** the `Deploy` GitHub Actions workflow runs the same script on every push to main. It needs two repo secrets (Settings → Secrets and variables → Actions): `DEPLOY_HOST` (e.g. `root@1.2.3.4`) and `DEPLOY_SSH_KEY` (the private half of a dedicated keypair whose public half sits in the host's `authorized_keys`, prefixed with `restrict,command="/root/deploy.sh"` — so even a leaked key can only trigger a deploy, nothing else).

**Caveat learned the hard way:** DigitalOcean App Platform (and similar gVisor-sandboxed PaaS) cannot run this app — they block the UDP traffic Discord voice needs, so `/coach join` times out even though the bot logs in. Use a real VM (droplet/VPS).

### Operational tips

- `GET http://<host>:3000/` is a health check returning the last-payload age — point an uptime monitor at it.
- Keep `GSI_TOKEN` long and random (it's the only auth on the GSI endpoint).
- If the host restarts, the bot must rejoin voice — run `/coach join` again (auto-rejoin is an easy future addition: persist the last channel ID and rejoin on startup).
