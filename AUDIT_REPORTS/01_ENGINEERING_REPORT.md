# XOFT — Engineering Audit & Hardening Report

**Scope of this pass:** audit the actual uploaded source (`xoft-core-complete.zip`),
verify what's real, fix concrete bugs/inconsistencies found, and report honestly.
Per the governing instructions, this was **not** a rewrite. No architecture was
replaced, no working feature was removed, no test was disabled.

---

## 1. Executive Summary

The uploaded source is a mature, already well-built implementation of the
XOFT spec — not a skeleton and not a set of stubs. Every major subsystem
called for (orchestrator, executive brain, task planner/queue, memory with
provenance, provider router with health/fallback, device registry + PC
agent + Android companion, approval system, permission system,
prompt-injection guard, activity log, autonomy manager, missions, proactive
engine, connectors, PWA frontend) exists, is wired together in
`src/index.js`, and is exercised by a real test suite.

**165/165** core tests pass and **6/6** pc-agent tests pass, both from a
clean install. A clean production-mode startup, `/healthz`, `/readyz`, and
the PWA's static assets were all verified live in this session.

This pass found the codebase honest about its own limitations (WhatsApp and
telephony are correctly gated behind `REQUIRES_THIRD_PARTY_SERVICE` errors
rather than faked) and found **no** secrets, **no** unsandboxed shell
access, and **no** path-traversal gaps in the areas inspected.

Concrete problems found and fixed this pass (all documentation/consistency,
zero code behavior changes):

1. README claimed "Node.js 18 or newer" while `package.json`, the
   Dockerfile, and the `node:sqlite` persistence layer all require **Node
   22.5+**. Fixed.
2. The spec's required README sections for PWA installation, phone
   day-to-day usage, and troubleshooting did not exist. Added, grounded in
   the actual routes/files/error strings in the code (not invented).
3. README section numbers were out of sequence (a duplicated "8", a
   "12a"/"13a" pair placed after "14"). Renumbered.
4. `docs/GOD_LEVEL_AUDIT_2026-09-15.md` is a dated, historical audit that
   says "PWA frontend — MISSING" and "WebSocket — MISSING", both of which
   are now implemented. It was kept (it's a legitimate point-in-time
   record) but flagged at the top as historical, pointing to
   `docs/FEATURE_COMPARISON.md` as the current source of truth.

No source code (`src/`, `pc-agent/`, `public/`) required a behavioral fix in
the areas audited this pass — see §8 for what wasn't fully inspected.

---

## 2. Actual Source Architecture

Confirmed directly from the repository (not from prior docs):

```
xoft-core/
├── src/                    # XOFT Core (Node 22, ESM, Express + ws)
│   ├── index.js            # single entrypoint wiring ~35 subsystems + ~90 REST routes
│   ├── orchestrator/       executive/    reasoning/     planner/
│   ├── providers/          memory/       devices/       security/
│   ├── tools/              agents/       connectors/    background/
│   ├── automation/         workflows/    goals/         missions/
│   ├── proactive/          autonomy/     recovery/      context/
│   ├── events/             realtime/     notifications/ voice/
│   ├── personality/        confidence/   intelligence/  vision/
│   ├── approval/           activity/     persistence/   config/
│   └── advisor/
├── pc-agent/               # Windows/Linux agent (CommonJS), typed allowlisted executors
│   └── src/executors/      system, applications, browser, files, screen, media
├── android-companion/      # Native Android companion (Gradle/Kotlin)
├── public/                 # PWA: vanilla HTML/CSS/JS, manifest.json, sw.js
├── apps/{mobile,desktop}   # OPTIONAL: React Native + Tauri universal-client experiment
├── packages/xoft-protocol  # Shared TS types for the optional universal clients
├── data/                   # gitignored — SQLite + JSON state
├── test/                   # 29 test files, 165 tests (node:test)
└── docs/                   # feature status, contracts, deployment, audits
```

Persistence is **mixed by design**: device identity/tokens and the durable
store are on SQLite (`node:sqlite`, Node 22.5+); most other subsystems
(missions, goals, rules, personality, activity log, permissions, etc.) are
JSON-file-backed under `data/`. This is documented honestly in
`docs/PRODUCTION_READINESS.md` as a known scaling limit, not hidden.

---

## 3. Files Created

- `XOFT_ENGINEERING_REPORT.md` (this file)

No new source files were created — per the governing rule against building
a second competing implementation, and because nothing audited was actually
missing at the code level (only at the documentation level).

## 4. Files Modified

| File | Change |
|---|---|
| `README.md` | Fixed Node version requirement (18 → 22.5+, matching `package.json`/Dockerfile/`node:sqlite`); added §19 PWA installation, §20 phone day-to-day usage, §21 troubleshooting; renumbered §12a/§13a/duplicate §8 sequentially (14-18) |
| `docs/GOD_LEVEL_AUDIT_2026-09-15.md` | Added a "historical snapshot, not current status" banner pointing to `docs/FEATURE_COMPARISON.md` |

## 5. Files Removed

None.

---

## 6. Features Already Present (verified against actual code, not docs)

- AI provider abstraction with 5 providers (OpenAI, Gemini, Claude, Grok,
  Ollama) behind one router, task-type-aware ordering, health tracking,
  fallback, and an explicit "Ollama always last" local-fallback design.
- Orchestrator + Executive Brain pipeline: understand → context → memory →
  reason → plan → risk → permission → execute → verify → respond.
- Task Planner + Task Queue: priority draining, idempotent re-enqueue,
  `scheduleAt` with validation, dry-run preview, rollback/undo.
- Memory: short-term, long-term structured, vector (semantic), importance
  scoring, conflict resolution, consolidation, retention, knowledge graph,
  provenance-tagged, real per-ID and per-filter deletion, device-scoped
  access control on the `DELETE /api/memory/:id` route.
- Approval system, Permission system (hierarchical, TTL-expiring grants,
  fresh-checked on every call, default-deny), Emergency Stop, Device Threat
  Monitor, Prompt Injection Guard (boundary-wrapping, not naive blocking).
- Device Registry/Manager with typed command queue, idempotency, and a
  real PC agent (Windows/Linux) with allowlisted executors and a
  path-traversal guard on every filesystem operation.
- Realtime layer: `EventBus` + WebSocket `RealtimeServer` (not polling).
- Background: `BackgroundJobManager`, `MonitorManager`, `ProactiveEngine`,
  `WorkflowEngine`, `AutonomyManager` (0-5 ladder), `MissionManager`.
- PWA: real manifest + service worker + 8 views (chat, tasks, approvals,
  memory, automation, devices, activity, settings), reconnecting WebSocket
  client.
- Connector layer (`http-json` / `mcp-http`) for arbitrary external
  services, credentials server-side only.
- Honest placeholders for WhatsApp and telephony (`send_whatsapp_message`,
  `make_phone_call`) that throw a specific "not configured" error rather
  than simulating success.
- SQLite dependency-doctor script (`npm run verify:deps`), Dockerfile with
  a real `/healthz` HEALTHCHECK, docker-compose, GitHub Actions CI
  (backend tests + Docker build + optional Android/universal-client jobs).

## 7. Features Implemented During This Work

None at the code level — see §1. Documentation gaps were closed (§4).

## 8. Features Partially Implemented / Not Independently Verified This Pass

- **Universal client experiment** (`apps/mobile` React Native, `apps/desktop`
  Tauri, `packages/xoft-protocol`) — explicitly optional per spec, structurally
  reviewed only; `pnpm`/Gradle/Android SDK are not available in this sandbox,
  so `pnpm --filter @xoft/protocol typecheck`, `pnpm --dir apps/mobile
  typecheck`, `pnpm --dir apps/desktop build`, and the Android Gradle build
  were **not executed** here. CI (`.github/workflows/ci.yml`) does run them.
- **Docker image build** — no `docker` binary is available in this sandbox,
  so `docker build` / `docker compose up` were **not executed** here. The
  Dockerfile was reviewed line-by-line (correct base image, non-root user,
  real `/healthz` healthcheck matching the actual route, correct `npm ci
  --omit=dev`) but not run.
- **Live provider calls** (OpenAI/Gemini/Claude/Grok/ElevenLabs/Whisper) —
  not exercised with real credentials, since none were provided; the test
  suite already covers these paths with mocks, which is the correct
  approach per the governing rules (never fake a live integration).

## 9. Optional Connectors (status, unchanged by this pass)

| Connector | Status | Requires |
|---|---|---|
| WhatsApp messaging | CONTRACT ONLY | WhatsApp Business API account or native companion app |
| Phone calls | CONTRACT ONLY | Twilio account or native companion app |
| Phone screen control / notifications / SMS / camera-mic capture | CONTRACT ONLY | Native Android/iOS companion app + OS permissions |
| Voice TTS | READY | `ELEVENLABS_API_KEY` |
| Voice STT (Whisper) | READY | `OPENAI_API_KEY` |
| Gmail / Calendar | READY | `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` |
| Web search | READY | `BRAVE_SEARCH_API_KEY` (page fetch itself is LIVE) |
| Ollama local model | READY, opt-in | `OLLAMA_ENABLED=true` + local Ollama install |
| Arbitrary MCP/HTTP connectors (e.g. Canva) | READY | `XOFT_CONNECTORS_JSON` with a real endpoint |

Full detail with file paths: `docs/FEATURE_COMPARISON.md`.

## 10. Features Not Implemented (by design, documented honestly in-repo)

- Wake-word / always-listening voice — inherently client-side (needs a
  live microphone), not something a backend can provide.
- Sandboxed coding-agent execution — an infrastructure/deployment decision
  for wherever XOFT is hosted, not repo code.
- Multi-instance/HA scaling, user accounts beyond a single shared API key,
  full transactional DB migration of all JSON-backed state — documented as
  "still required before serious public multi-user deployment" in
  `docs/PRODUCTION_READINESS.md`.

## 11. AI Provider Status

Abstraction is real and correctly structured (`AIProvider` interface,
5 concrete providers, `ProviderRouter`, `ModelHealthManager`). No provider
is mandatory; `availableProviders()` only reports a provider as available
if its key is actually set (verified: server boots and warns honestly with
zero keys configured). Task-type-aware preference ordering and
primary/fallback override via `AI_PRIMARY_PROVIDER` / `AI_FALLBACK_PROVIDERS`
were reviewed in `ProviderRouter._preferenceFor()` and match the documented
behavior.

## 12. Reasoning/Agent Status

Executive Brain, Reasoning Engine, Confidence Engine, Advisor Agent, and
Intelligence Director (plan critique/preflight) are all real AI-router
calls with structured JSON output and honest fallback-on-parse-failure
(fails closed to "uncertain," never fabricates a confident score). Verified
by reading `ConfidenceEngine`, `AdvisorAgent`, `IntelligenceDirector`,
`NotificationClassifier` directly, and by the passing
`intelligenceDirector.test.js` / `adaptiveAgent.test.js` suites.

## 13. Memory Status

Provenance-tagged, deletable (by ID and by filter), device-scoped on the
delete route, importance-scored, conflict-resolved, consolidated, and
backed by a lightweight knowledge graph — no external vector DB required.
`memoryApi.test.js`, `memoryArchitecture.test.js` pass.

## 14. Task Engine Status

Real priority queue with idempotent re-enqueue (verified: "enqueueing the
same task twice does not run it twice concurrently" test passes),
`scheduleAt` with input validation, dry-run preview, rollback/undo for
undoable tool calls, self-verification (`Self-verification` test suite:
tools without a `verify()` are marked *unverified*, not silently assumed
successful — this is exactly the spec's "never report success simply
because a command returned without throwing" requirement, and it's
enforced in code, not just claimed).

## 15. Background Automation Status

`BackgroundJobManager` (retry backoff, pause/resume),
`MonitorManager`/`ProactiveEngine` (condition-based suggestions with a
verified bug fix already in place for suggestions that used to get stuck
"fired once, never again" — the code comment documents the fix and the
test suite covers it), `WorkflowEngine`, `RulesEngine`. All run inside
XOFT Core, independent of the browser tab.

## 16. PWA Status

**IMPLEMENTED.** Verified live in this session: `/` returns 200,
`/manifest.json` returns 200 with `display: standalone`, `/sw.js` returns
200. 8 real views under `public/js/views/`. WebSocket client
(`public/js/ws.js`) reconnects and re-syncs. No React — plain HTML/CSS/JS
as the project requires. Installation requires HTTPS (or localhost) to
trigger the browser's install prompt; this is documented in the new README
§19, not a bug.

## 17. PC Agent Status

Typed, allowlisted command executors only (`system.*`, `applications.*`,
`browser.*`, `files.*`, `screen.*`, `media.*`) — no generic
execute-anything endpoint found anywhere in `pc-agent/src`. File operations
are gated through a single `resolveWithinRoots()` chokepoint that resolves
the real path and requires it to be inside a configured root; this was
read directly and is correct. 6/6 pc-agent tests pass, including startup
registration tests confirming it never requests elevated privileges by
default.

## 18. WhatsApp Status

**CONTRACT ONLY** — `send_whatsapp_message` is registered so the
planner/AI can see it exists, but calling it throws
`'send_whatsapp_message requires a WhatsApp Business API account — not
configured.'` Verified by reading `placeholderTools.js` directly. This is
the correct behavior per the zero-fake-completion rule.

## 19. Voice/Call Status

TTS (ElevenLabs) and STT (Whisper) are real, working API integrations, gated
on the relevant key being set — verified by reading `VoiceService.js`
directly (correct error messages when unconfigured, correct endpoints when
configured). `make_phone_call` (actual telephony) is CONTRACT ONLY, same
honest-failure pattern as WhatsApp.

## 20. Security Status

- No secrets found in tracked files (regex-scanned for common API key
  shapes across `.js`/`.json`/`.md`).
- `.gitignore` correctly excludes `node_modules/`, `data/`, `.env`,
  `public/generated/`, `*.log`.
- API auth: shared-secret (`AUTH_API_KEYS`), `Authorization: Bearer` or
  `X-API-Key`; production boot is **blocked** if unset and
  `REQUIRE_AUTH_IN_PRODUCTION=true` (default) — verified by reading the
  startup guard directly.
- `AUTO_TRUST_LOCAL` defaults to `false`, only applies to loopback
  connections, must be explicitly opted into.
- Permission system: hierarchical (namespace or leaf), TTL-expiring grants,
  checked fresh on every tool execution (no caching — a revoke takes effect
  immediately), default-deny for unknown permissions.
- `ToolRegistry.execute()` gates in order: emergency stop → permission
  check → the tool's own implementation-status check. This is the single
  chokepoint every tool call passes through.
- Prompt Injection Guard wraps untrusted content in a random-marker
  boundary the content itself cannot forge, with an explicit
  don't-follow-instructions-inside-this instruction — used for external
  content (notifications, advisor context) rather than trying to be a
  perfect classifier.
- Device-scoped route protection (`requireOwnDevice` / `requireAdmin`)
  applied consistently across `/api/devices/*`.

No security defect was found in the areas inspected this pass.

## 21. Database/Persistence Status

SQLite (`node:sqlite`, WAL mode) for the durable store, device identities,
and device command lifecycle; JSON files under `data/` for the rest — both
documented accurately, not oversold. `npm run verify:deps` (dependency
doctor) runs and passes.

## 22. Test Results

```
Core (xoft-core):    165 tests / 44 suites — 165 pass, 0 fail
PC Agent:              6 tests /  1 suite  —   6 pass, 0 fail
```

Both re-run clean from a fresh `data/` directory with no `.env` present
(the auth-key mismatch seen mid-session was caused by a leftover `.env`
from my own manual startup testing polluting a later test run — removing
it restored a clean pass; this was not a product defect).

## 23. E2E Results

`test/e2eIntegration.test.js` ("Phase 3O — end-to-end integration") passes
all 3 scenarios: device lifecycle + scoped memory + realtime + revocation;
restart survival across task queue/idempotency/background automation
(a scheduled task and a monitor both survive a full process restart on the
same data directory); emergency stop is real and observable (not just a
status flag).

## 24. Build Results

`npm install` (root and `pc-agent/`): clean, no vulnerabilities flagged by
npm's own summary. `node --check src/index.js`-equivalent (the file
imports and runs cleanly) confirmed via actual startup.

## 25. Production Startup Results

Clean startup verified live: SQLite experimental-feature warning (expected,
harmless, now documented in README troubleshooting), "XOFT core listening
on port 3000," honest warning when no AI provider key is set,
`SIGTERM` → graceful shutdown log line. `/healthz` and `/readyz` both
return `200` with accurate service/storage/connector info.

## 26. Deployment Status

Dockerfile and `docker-compose.yml` reviewed and structurally correct
(Node 22 base image matching `engines.node`, non-root `node` user, real
healthcheck against the actual `/healthz` route, SQLite volume). **Not**
executed in this sandbox (no `docker` binary available) — flag this for a
real Docker build/run before calling it deployment-verified end-to-end.

## 27. GitHub Readiness

`.gitignore`, `.env.example`, `package.json` + lockfile, `Dockerfile`,
`docker-compose.yml`, CI (`ci.yml`, `release.yml`), README, and deployment
docs are all present and now internally consistent (Node version fixed).
No secrets present. Not pushed to GitHub — no authorization was given and
no authenticated GitHub access is available in this environment.

## 28. Zero-Budget Capabilities

Confirmed live: XOFT Core boots, serves the PWA, and responds to
`/healthz`/`/readyz` with **zero** API keys and **zero** paid services
configured, using SQLite for storage. Chat/reasoning features correctly
require at least one AI provider key (there is no way around an LLM call
needing an LLM), but that key can be any one of OpenAI/Gemini/
Claude/Grok, all optional relative to each other, or a local Ollama model.

## 29. External Services Required (for which features)

| Feature | External service |
|---|---|
| Chat/reasoning/planning | Any one of OpenAI, Gemini, Claude, Grok API keys, **or** a local Ollama install |
| Semantic memory search | OpenAI (embeddings) |
| Email / Calendar | Google OAuth credentials |
| Web search | Brave Search API key |
| Voice TTS | ElevenLabs API key |
| Voice STT | OpenAI API key (Whisper) |
| Image/video generation | OpenAI / Gemini API keys |
| WhatsApp | WhatsApp Business API account |
| Phone calls | Twilio account |
| Phone-native automation (SMS, notifications, camera, accessibility) | A native Android/iOS companion app (Android one exists as a scaffold + agent; iOS does not exist) |

## 30. Known Limitations

- Single shared API key for authentication; no per-user accounts/sessions.
- Most non-device state is JSON-file-backed, not a transactional DB — fine
  at single-user scale, a real limitation at multi-user/HA scale (already
  documented honestly in `docs/PRODUCTION_READINESS.md`).
- iOS has no native companion app (Android does, as a Gradle-scaffolded
  polling agent with AccessibilityService support).
- The universal client experiment (`apps/mobile`, `apps/desktop`) is
  early-stage and not required for normal use of XOFT.
- Docker build and the pnpm/Android workspace commands were reviewed but
  not executed in this sandbox — verify in an environment with Docker/
  pnpm/Gradle before treating deployment as fully proven end-to-end.

## 31. Exact Commands to Run Locally

```bash
cd xoft-core
npm install
cp .env.example .env
# edit .env: at minimum, decide on an AI provider key if you want chat/reasoning
npm test                 # 165 tests
node src/index.js        # starts on :3000; NODE_ENV=development skips the auth-required gate

# PC agent (optional, separate machine/process):
cd pc-agent
npm install
npm test                 # 6 tests
npm start                # or: npm run pair    (first-time device pairing)
```

## 32. Exact Commands to Build

```bash
# Backend image
docker build -t xoft-core .

# Dependency integrity check
npm run verify:deps

# Optional universal clients (not required for normal use)
pnpm install --no-frozen-lockfile
pnpm --filter @xoft/protocol typecheck
pnpm --dir apps/mobile typecheck
pnpm --dir apps/desktop build

# Optional Android companion
cd android-companion
gradle --no-daemon :app:assembleDebug
```

## 33. Exact Deployment Steps

1. `cp .env.example .env`; set `NODE_ENV=production`, a long random
   `AUTH_API_KEYS` value, and at least one AI provider key.
2. `docker compose up -d --build`.
3. Put a TLS-terminating reverse proxy (Caddy/Nginx/Cloudflare Tunnel) in
   front of it — the app itself does not ship a certificate, and the PWA
   will not be installable without HTTPS (or `localhost`).
4. Verify `GET /healthz` and `GET /readyz` return `200`.
5. Open the URL on your phone in Chrome (Android) or Safari (iOS) and
   install it — see README §19 for exact steps.
6. Optionally pair the PC agent (`cd pc-agent && npm run pair`) and/or
   build and install the Android companion APK.
7. Back up the `xoft-data` Docker volume regularly (it holds SQLite + all
   JSON state).

## 34. Recommended Next Development Tasks

In priority order, per the project's own `docs/PRODUCTION_READINESS.md`
and this audit:

1. Replace the single shared API key with per-device pairing + rotation
   (biggest security gap for anything beyond single-owner use).
2. Migrate the remaining JSON-backed state to a transactional store if
   multi-instance/HA is ever a goal — not needed for the current
   single-user, single-instance zero-budget target.
3. Build out the iOS native companion (Android already exists as a
   scaffold + working agent).
4. Verify the Docker build and the optional pnpm/Gradle workspace in an
   environment that has those tools (this sandbox does not).
5. Configure real credentials for at least one AI provider and run a live
   end-to-end chat → task → approval → completion flow manually, since
   the test suite (correctly) mocks all external AI calls.

---

*This report reflects only what was directly inspected, run, or read in
this session. Where something could not be verified (Docker build,
pnpm/Gradle workspace, live provider calls), that is stated explicitly
above rather than assumed.*
