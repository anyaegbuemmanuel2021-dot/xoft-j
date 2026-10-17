# XOFT — Phase 1 Codebase Audit (2026-09-15)

> **Historical snapshot — not current status.** This audit predates the PWA
> build-out, the WebSocket realtime layer, and the device identity/token
> work; several "MISSING" rows below (PWA frontend, WebSocket/real-time)
> are now implemented. For current, accurate feature status see
> `docs/FEATURE_COMPARISON.md`, which the top-level README points to first.

Scope: xoft-core-v0_9_1-merged.zip, inspected in full before any further changes, per the new master prompt's "audit first, no rewriting" rule.

Session note up front: two things were already touched *before* this master prompt arrived (previous message in this thread asked for a web app + real offline AI). Both turn out to already comply with the new spec rather than conflicting with it — see §9.

## 1. Entry point & runtime

- `src/index.js` — single Express app, ~990 lines, all routes inline (no router modules). ~90 REST endpoints. `node --test` → **52/52 passing**.
- No WebSocket, no socket.io anywhere in `src/` or `pc-agent/`. All device/task status is REST polling. **Conflicts with the new spec's "prefer WebSocket for real-time events over polling."**
- Root `package.json` deps: `express`, `dotenv`, `helmet`, `express-rate-limit` only. Genuinely lightweight — fits the i3/8GB/HDD target machine constraint already.

## 2. Auth

- Shared-secret only: `AUTH_API_KEYS` (comma-separated), checked via `Authorization: Bearer` or `X-API-Key` header against a flat list (`src/index.js:214-227`).
- **No user accounts, no sessions, no per-user data.** One key = full access to everything.
- Production boot is blocked if `REQUIRE_AUTH_IN_PRODUCTION=true` (default) and no key is set — good deterministic safety rail.
- `AUTO_TRUST_LOCAL` + `isLoopback()` auto-trusts devices connecting from 127.0.0.1 — off by default, intended for the local PC agent only.
- **Gap vs. new spec:** spec calls for "users, sessions, device identity, token rotation." None of that exists — this is single-owner software today.

## 3. Storage / persistence

- Mixed: `src/persistence/SqliteStore.js` exists and is used by `DeviceTokenService` and part of `index.js`, but most subsystems still persist to flat JSON files in `/data` (`missions.json`, `goals.json`, `tasks.json`, `activity_log.json`, `autonomy.json`, `personality.json`, `rules.json`, `workflows.json`, `monitors.json`, `knowledge_graph.json`, `permissions.json`, `user_style.json`, `long_term_memory.json`, `background_jobs.json`).
- Works fine at single-user scale on an HDD (small files, infrequent writes). **Not** a real database migration — "SQLite" in `STORAGE_MODE` is aspirational for most of the state today.

## 4. AI / Providers (`src/providers/`)

- `AIProvider.js` (interface) + `OpenAIProvider`, `GeminiProvider`, `ClaudeProvider`, and now `OllamaProvider` (added this session — see §9), all behind `ProviderRouter.js` with per-task-type preference lists and health-based fallback (`ModelHealthManager`).
- Genuinely replaceable/pluggable — matches the spec's "AI Router with interchangeable providers, never hard-coded to one."
- `availableProviders()` only reports a provider as available if its API key is actually set — no pretending.

## 5. Task / planning / execution

- `src/planner/TaskPlanner.js` — real state machine-ish flow (plan → approval gate → execute → resume-after-approval), per-execution permission enforcement (fixed in an earlier session per project history), confidence gating, dry-run/rollback.
- `src/missions/` — higher-level Mission wraps TaskPlanner for multi-step goals.
- `src/approval/` — pending-approval queue; approving a standalone (non-task) approval now actually executes it (fixed earlier).
- Task states exist but are simpler than the spec's full `CREATED→PENDING→AUTHORIZED→SCHEDULED→READY→RUNNING→VERIFYING→COMPLETED/FAILED→RETRY/RECOVERING` machine — currently closer to `plan→approval?→running→completed/failed/cancelled`. **No explicit idempotency key / attempt-number field on tasks.**

## 6. Background / autonomy / workflows

- `src/background/BackgroundJobManager.js`, `MonitorManager.js` — scheduled/recurring jobs and condition monitors exist and are tested.
- `src/workflows/` — WorkflowEngine exists.
- `src/autonomy/AutonomyManager.js` — numeric level (`autonomy.level`) with a label; `/api/autonomy` GET/POST. Simpler than the spec's 0-5 ladder but the same concept.
- `src/recovery/` exists (failure classification / retry) — not yet inspected line-by-line this pass; flagged for a closer look before Phase 3.

## 7. Devices / PC Agent

- `src/devices/DeviceManager.js`, `DeviceRegistry.js`, `ComputerUseEngine.js` on the core side.
- `pc-agent/` (Node, CommonJS, `pkg`-buildable to a Windows `.exe`) — **polls** core for commands (no WebSocket), dispatches through a **typed, allowlisted command switch** (`system.*`, `applications.*`, `browser.*`, `files.*`, `screen.*`, `media.*`) with an explicit `appAllowlist` / `allowedRoots` — this already matches the new spec's "typed commands, no generic execute-anything endpoint" requirement well.
- `android-companion/` — Gradle scaffold (build.gradle, settings.gradle, AndroidManifest, res/) added in an earlier session; no actual app logic yet — still a skeleton.
- `apps/mobile/` — React Native (RN 0.81.4) JS/TS app, `src/App.tsx` + `api.ts` + `storage.ts`; JS-only, no native `android/`/`ios/` folders (matches earlier audit finding).
- `apps/desktop/` — Tauri shell (`src-tauri/`, `main.ts`) — present, minimal, not required by the new architecture but not in the way either.
- `packages/xoft-protocol/` — shared TS types package, thin.

## 8. Frontend (`public/`)

- Before this session: `index.html` (44 lines) + `dashboard.js` (94 lines) — a bare status page hitting a handful of endpoints. Covered maybe 5% of the ~90-endpoint API surface.
- This session (in progress, per your prior "turn this into a web app, offline-capable" request): `public/css/app.css`, `public/js/api.js`, `public/js/dom.js` written — sidebar-SPA shell + an API client with response caching and an offline mutation queue. **Views not yet built** — chat/missions/memory/etc. screens don't exist yet. No `manifest.json` or service worker yet either.

## 9. Reconciling this session's prior changes with the new master prompt

Two changes were made just before this master prompt arrived:

1. **`OllamaProvider.js`** (local-model fallback) — checked against your new "AI architecture" rules: *"Do NOT run a local AI model **by default**... Cloud AI providers may be used for reasoning."* The provider is `OLLAMA_ENABLED=false` by default, adds zero new npm dependencies (plain `fetch` to a local HTTP port), and only activates if you explicitly opt in and have a local model running — it's a fallback, not a default. **No conflict** — leaving it in place unless you'd rather strip it entirely.
2. **Frontend scaffold** (`api.js`, `dom.js`, `app.css`) — this **is** exactly what the new spec calls for structurally (`public/{index.html,css,js,icons,manifest.json,service-worker.js}`, no React). Nothing to undo; it's a head start on the PWA rebuild, not a detour.

Nothing else was rewritten. No views, no service worker, no manifest, no PC-agent or auth changes were made.

## 10. Gap analysis (Phase 2, quick pass)

| Area | Status | Note |
|---|---|---|
| AI provider abstraction | **EXISTS** | Solid, replaceable, health-tracked |
| Typed PC-agent commands | **EXISTS** | Already allowlisted, no raw-exec endpoint |
| Approval / permission gating | **EXISTS** | Real enforcement, tested |
| Task planning & execution | **EXISTS**, NEEDS IMPROVEMENT | Missing idempotency keys, simpler state machine than spec |
| Background jobs / monitors / workflows | **EXISTS** | Tested |
| PWA frontend | **MISSING** (in progress) | Shell only so far |
| WebSocket / real-time events | **MISSING** | Currently 100% polling |
| User accounts / sessions / device identity tokens | **MISSING** | Single shared API key today |
| Real database migration | **NEEDS IMPROVEMENT** | SQLite exists but most state is still flat JSON |
| Android companion app | **NEEDS IMPROVEMENT** | Gradle scaffold only, no logic |
| Local-model (offline AI) fallback | **EXISTS** | Added this session, opt-in, compliant |
| Generic/unsandboxed remote-exec surface | **not present** | Good — nothing dangerous found here |
| Duplicated systems | **none found** | No competing managers for the same responsibility observed |

## 11. Recommended next step

Your call on priority — options, not a decision:
- **Frontend**: finish the PWA (views + manifest + service worker) on top of the existing API, since it's already mid-flight and doesn't touch the backend risk areas.
- **Backend**: WebSocket layer for real-time device/task events (biggest architectural gap vs. the new spec).
- **Backend**: user accounts / device identity, replacing the shared-API-key model (biggest security gap).

No code has been written for any of these three yet — audit only, as requested.
