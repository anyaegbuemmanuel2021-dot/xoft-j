# XOFT Core — Production Deployment Checklist

Verified by static review of `src/config/index.js` and `src/index.js` in this
codebase as of this writing. Docker itself could not be built/run in the
environment this was written in (no `docker` binary available) — the
Dockerfile/docker-compose.yml were reviewed by inspection, not executed.
Run `docker build . && docker compose up` yourself before trusting this in
production, and report back if anything fails.

## 1. Required before going live

- [ ] **`AUTH_API_KEYS`** — set to at least one long, random secret (e.g.
      `openssl rand -hex 32`). Comma-separate multiple keys for multiple
      admins/scripts. Leaving this empty means the entire API is
      unauthenticated for anyone who can reach the port — the code will
      refuse to boot in production without it (`REQUIRE_AUTH_IN_PRODUCTION`,
      see below) but confirm it's actually set, not just that boot succeeded.
- [ ] **`NODE_ENV=production`** — already set in the Dockerfile/compose file.
      This is what triggers the `REQUIRE_AUTH_IN_PRODUCTION` boot-time check.
- [ ] **At least one AI provider key** (`OPENAI_API_KEY`, `GEMINI_API_KEY`,
      `ANTHROPIC_API_KEY`, or `XAI_API_KEY`) — the app boots fine with none
      configured, but `/api/chat` and anything AI-dependent will fail with a
      clear error until one is set. Decide this deliberately rather than
      discovering it live.
- [ ] **A durable volume for `/app/data`** — this is where SQLite and any
      remaining flat-JSON state lives. The provided `docker-compose.yml`
      already mounts a named volume (`xoft-data`); if deploying without
      compose, mount something durable at the same path or data is lost on
      container recreation (not just restart).

## 2. Strongly recommended

- [ ] **Put it behind TLS** — this app itself speaks plain HTTP (`HOST`/
      `PORT` in `src/config/index.js`), with no built-in HTTPS listener. Run
      it behind a reverse proxy (nginx, Caddy, Traefik, a cloud load
      balancer) that terminates TLS, especially since `AUTH_API_KEYS` and
      device tokens are sent as plain headers.
- [ ] **Review `AI_PRIMARY_PROVIDER`/`AI_FALLBACK_PROVIDERS`** — if left
      unset, the router uses its built-in task-aware defaults (Claude first
      for reasoning, etc.). If you want a hard guarantee that XOFT never
      silently calls a provider you haven't reviewed, set
      `AI_PRIMARY_PROVIDER` explicitly and `AI_FALLBACK_ENABLED=false`.
- [ ] **`OLLAMA_ENABLED`** — leave `false` unless you're actually running a
      local Ollama daemon reachable from the container (a container's
      `127.0.0.1` is its own network namespace, not the host's — you'll
      likely need `OLLAMA_BASE_URL=http://host.docker.internal:11434` or
      equivalent for this to work at all in Docker).
- [ ] **Rotate `AUTH_API_KEYS` periodically** — nothing in this codebase
      expires them automatically (a Phase 3F/3M finding, unchanged).
- [ ] **Device tokens** — once devices are trusted via
      `POST /api/devices/:id/trust`, the one-time token shown in that
      response is the only copy. Losing it means revoke + re-trust, not
      recovery.
- [ ] **Back up `/app/data`** — whatever volume/host path you mounted there
      is the entire durable state of the system (tasks, memory, devices,
      experiences). No automated backup mechanism exists in this codebase.

## 3. Optional / situational

- [ ] `SQLITE_PATH` — defaults to `/app/data/xoft.sqlite` in the Docker
      image; only change this if you have a specific volume-layout reason to.
- [ ] `DEVICE_ONLINE_THRESHOLD_MS` / `DEVICE_COMMAND_TIMEOUT_MS` — defaults
      (90s / 30s) are reasonable for a single-user personal-assistant
      deployment; tune if devices are on high-latency networks.
- [ ] `AUTO_TRUST_LOCAL` — leave `false` unless the PC agent and xoft-core
      are deliberately running on the very same machine and you understand
      the tradeoff (any loopback connection is auto-trusted).
- [ ] Voice/media/search integrations (`ELEVENLABS_API_KEY`,
      `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN`,
      `BRAVE_SEARCH_API_KEY`, `IMAGE_MODEL`, `VIDEO_MODEL`) — only needed if
      you're using those specific features; the app runs fine without any
      of them.
- [ ] `XOFT_CONNECTORS_JSON` — only if wiring external MCP-style connectors;
      keep real secrets in the `headers` field of each entry, never
      committed to source control.

## 4. After deploying, verify

- [ ] `GET /healthz` returns `200` — liveness only, no auth required.
- [ ] `GET /readyz` returns `200` and shows the expected `storage` mode and
      any `connectors` you configured.
- [ ] `GET /api/status` (with your `AUTH_API_KEYS` header) shows the AI
      providers you expect under `configuredProviders`, and confirms
      `localModel.enabled` matches your `OLLAMA_ENABLED` choice.
- [ ] Connect a client to `wss://<your-domain>/ws?key=<your-key>` (if
      exposing the realtime bridge externally) and confirm you receive the
      initial `{"type":"connected"}` handshake message.
- [ ] Trust a real device end-to-end once, confirm its token works and an
      admin-only action (e.g. `/trust` again) correctly returns 403 for that
      device's own token — this exercises the device-scoping model for
      real, not just in the test suite.

## 5. Known gaps this checklist can't paper over

- No automated secret rotation, backup, or TLS termination is built into
  this codebase — all three are the operator's responsibility, noted above.
- No load/stress testing has been performed at any point in this project's
  development — validate your expected concurrent load yourself before
  relying on this in a busy setting.
- `ActivityLog` grows unbounded on disk by design — monitor `/app/data` disk
  usage over time on a long-lived deployment.
