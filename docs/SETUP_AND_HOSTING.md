# XOFT AI CORE — setup and going live

This guide takes you from the zip file to a live, HTTPS-protected XOFT AI CORE that your own PC connects to.
Keys and where to get them: [API_KEYS.md](API_KEYS.md). Optional AI gateways: [AI_GATEWAYS.md](AI_GATEWAYS.md). Device runtime: [DEVICE_RUNTIME.md](DEVICE_RUNTIME.md).

## 0. How the pieces fit (read this first)

```
            ┌────────────── your public server (VPS) ───────────────┐
 Browser ──►│ Caddy (HTTPS) ──► XOFT AI CORE (Node 22 + SQLite data) │◄── AI providers (OpenAI, Gemini, Claude, …, or none)
 Phone   ──►│                        ▲                               │
            └────────────────────────┼───────────────────────────────┘
                                     │ HTTPS (the agent calls OUT to your server)
                            ┌────────┴─────────┐
                            │ pc-agent on YOUR │  ← runs on the computer you want XOFT to control
                            │ own PC (Node 22) │    (files, browser, terminal, apps). It cannot run on the server.
                            └──────────────────┘
```

* **XOFT AI CORE (server)** — the brain, dashboard, API, memory, missions, scheduler. Hosted online.
* **pc-agent (your PC)** — the hands. Controls *that* computer, so it runs there, and connects outward to your server. No router port-forwarding needed.
* **Voice companion** — a web page (`/companion.html`) that uses your browser's microphone.
* **Does not work on serverless hosts** (Vercel, Netlify, Cloudflare Workers): XOFT is a long-running process with WebSockets, a scheduler and a SQLite file.

## 1. What to use (recommended stack)

| Need | Recommendation | Where |
|---|---|---|
| Server | Any small Linux VPS (2 vCPU / 2–4 GB RAM is plenty without local models). Ubuntu 24.04 LTS. | Hetzner Cloud https://www.hetzner.com/cloud · DigitalOcean https://www.digitalocean.com · Vultr https://www.vultr.com · or any provider you trust |
| Domain + DNS | Any registrar; Cloudflare DNS is free and convenient | https://www.cloudflare.com · https://www.namecheap.com |
| HTTPS | Caddy (automatic certificates) — already configured in `deploy/` | https://caddyserver.com |
| Runtime | Docker + Compose (recommended) **or** Node.js 22+ with systemd | https://docs.docker.com/engine/install · https://nodejs.org |
| PaaS alternative | Railway https://railway.com · Render https://render.com · Fly.io https://fly.io — need a **persistent volume** mounted at `/app/data`, WebSocket support, and a Node 22 / Dockerfile build. Follow their docs; the included `Dockerfile` is the build. | |

Prices and free tiers change — check the provider sites. (The Docker + Caddy route below is the one this project documents in full.)

## 2. Prepare the server (one time)

```bash
# on a fresh Ubuntu 24.04 server, as root or with sudo
adduser xoft && usermod -aG sudo xoft
# Docker (official convenience script — see https://docs.docker.com/engine/install/ubuntu/)
curl -fsSL https://get.docker.com | sh
usermod -aG docker xoft
# firewall: SSH + web only
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
```
Point your domain at the server: create an **A record** `xoft.yourdomain.com → <server IP>` (if you use Cloudflare's proxy, set SSL mode to *Full (strict)*).

## 3. Get the code on the server

```bash
# from your computer, in the folder that contains XOFT-AI-CORE.zip
scp XOFT-AI-CORE.zip xoft@YOUR_SERVER_IP:~
# on the server
unzip XOFT-AI-CORE.zip && cd XOFT-AI-CORE   # (or push it to a private Git repo and git clone)
```

## 4. Configure

```bash
cp .env.example .env
# create YOUR dashboard password and paste it as AUTH_API_KEYS:
openssl rand -hex 32
nano .env
```
Minimum `.env` for production:
```
NODE_ENV=production
AUTH_API_KEYS=<the long random value you just generated>
REQUIRE_AUTH_IN_PRODUCTION=true
TRUST_PROXY=1
# plus at least one AI provider key when you want AI answers, e.g.:
GEMINI_API_KEY=...
```
**Important:** in production mode XOFT refuses to start without `AUTH_API_KEYS` — that is a deliberate safety rule protecting *your own* server from being open to the internet. It is not an AI-provider key; AI keys are all optional.

Every key and its source: [API_KEYS.md](API_KEYS.md).

## 5. Start it (Docker + Caddy, HTTPS automatic)

```bash
DOMAIN=xoft.yourdomain.com docker compose -f deploy/docker-compose.caddy.yml up -d --build
docker compose -f deploy/docker-compose.caddy.yml ps          # both "running"/"healthy"
curl https://xoft.yourdomain.com/healthz                      # {"ok":true,...}
```
Open `https://xoft.yourdomain.com`. The dashboard asks for an API key: enter your `AUTH_API_KEYS` value.

Without Docker: install Node 22, `npm ci --omit=dev`, set `HOST=127.0.0.1` and `TRUST_PROXY=1` in `.env`, use `deploy/xoft-core.service` (systemd) and put Caddy/Nginx in front.

Local trial on your own PC first (no domain, no HTTPS): `npm install && cp .env.example .env` (set `NODE_ENV=development`) `&& npm start`, then open http://localhost:3000.

## 6. Add your AI provider(s)

* Put keys in `.env` and restart (`docker compose … up -d`), **or**
* For FreeLLMAPI / LiteLLM: *Settings → AI providers* (enter key → Save → Test connection).

Check: `GET /api/ai/status` or the Settings page. No provider = XOFT still runs; only AI requests say "no AI provider available".

## 7. Connect your PC (pc-agent)

On the PC you want XOFT to control (Node.js 22+ installed):
```powershell
cd XOFT-AI-CORE\pc-agent
npm install
node src\index.js                 # first run creates config.json and exits
```
Edit `config.json`:
* `coreUrl` → `https://xoft.yourdomain.com`
* `apiKey` → your `AUTH_API_KEYS` value (used once to register)
* `workspaces` → folders XOFT may work in; or run `node src\index.js --add-workspace Projects "C:\Projects"`
* `allowedRoots`, `appAllowlist` → the only folders/apps the legacy file/app tools can touch

Run `node src\index.js` again. It registers and waits. **You** then approve it: Dashboard → *Devices* → trust the device (or run the `curl …/trust` line the agent prints). Next: *Device Runtime* page → grant permissions (Browser, Files, Workspaces, Terminal…) — nothing works until you grant it.

Browser control: start Chrome with `--remote-debugging-port=9222 --user-data-dir=C:\xoft-chrome` (a non-default folder is required by Chrome 136+), or set `"browser": {"autoLaunch": true}`.
Start at login: `node src\index.js --install-startup`.
Emergency: `node src\index.js --halt` stops everything on the PC (kills running commands); `--resume` undoes it. The dashboard **HALT** button and the core emergency stop do the same remotely; only a human at the PC can resume.

## 8. Voice

Open `https://xoft.yourdomain.com/companion.html` (HTTPS is required for the microphone) → *Start listening* → say "Hey Xoft, …". Risky commands (delete, deploy, send…) ask for confirmation first.

## 9. Operating it

```bash
docker compose -f deploy/docker-compose.caddy.yml logs -f xoft-core      # logs
git pull && docker compose -f deploy/docker-compose.caddy.yml up -d --build   # update (or upload a new zip)
# backup the data volume (memory, missions, settings, journal) — do this regularly:
docker run --rm -v xoft-ai-core_xoft-data:/d -v "$PWD":/b alpine tar czf /b/xoft-data-$(date +%F).tgz -C /d .
```
(Volume name comes from the `name:` in the compose file; confirm with `docker volume ls`.)

**Security checklist:** long random `AUTH_API_KEYS` · HTTPS only · firewall 22/80/443 · never commit `.env` · back up `data/` · grant device permissions narrowly, prefer time-boxed grants · keep `policy.terminal.build` on `confirm`.

## 10. Troubleshooting

| Problem | Fix |
|---|---|
| "Production startup blocked: AUTH_API_KEYS…" | Set `AUTH_API_KEYS` in `.env` (see step 4). |
| Site not loading / certificate error | DNS A record must point to the server; ports 80/443 open; wait a minute for Caddy. `docker compose … logs caddy`. |
| Dashboard keeps asking for a key / 401 | Enter the exact `AUTH_API_KEYS` value. |
| "No AI provider available" | Add a key (API_KEYS.md) and restart; Settings → *Test connection* for gateways. |
| Rate limit errors for everyone | `TRUST_PROXY=1` missing behind Caddy. |
| Agent never appears / stays untrusted | `coreUrl` must be the https URL; trust it on the Devices page. |
| Browser tools fail | Chrome not started with the debug port (step 7). |
| Microphone blocked | Must be HTTPS; allow the permission in the browser. |

## 11. What is and isn't verified

See the status tables in [DEVICE_RUNTIME.md](DEVICE_RUNTIME.md) and [AI_GATEWAYS.md](AI_GATEWAYS.md). In short: logic, security rules and APIs are covered by automated tests (real files, real processes, local fake gateway). **Not verified in the build environment:** the real server over HTTP (express/ws could not be installed offline), Docker/Caddy deployment, real Chrome automation, the microphone, the dashboard visuals, and the real FreeLLMAPI/LiteLLM programs. Do a smoke test after deploying: healthz → login → Settings → chat → connect agent → one harmless file read.
