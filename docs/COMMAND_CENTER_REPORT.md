# XOFT Dashboard Implementation Report

Frontend is vanilla ES modules (no React/build step), so the dashboard was built as ES-module components in `public/js/dashboard/` (one file per requested component) using the same `render()/cleanup` view contract as the existing views. The reference image was not attached, so the visual language follows the written spec.

Legend: CONNECTED = wired to a real endpoint/event; BROWSER-VERIFIED = passed `scripts/verify-command-center.mjs` (real Chromium, real `public/` files, **stub** backend); LIVE = not verified against the real XOFT server (see Remaining).

| Feature | Status | API / event used | Verification |
|---|---|---|---|
| Top bar (status, network, model, notifications, user menu) | IMPLEMENTED + CONNECTED | /api/status, /api/providers/overview, /api/approvals, existing WS state | browser-verified |
| System status (CPU/mem/disk/uptime/server/network) | IMPLEMENTED + CONNECTED | **new** GET /api/system/telemetry (os/statfs; null shown as "unavailable", never faked) | unit + browser |
| AI providers (6, health, model, latency, expand, retry, switch) | IMPLEMENTED + CONNECTED | **new** GET /api/providers/overview (reads router + ModelHealthManager; no keys/URLs), GET /api/ai/models, POST /api/ai/model | unit + browser |
| Memory panel | IMPLEMENTED + CONNECTED | /api/memory, /api/knowledge-graph/stats, /api/status | browser |
| XOFT CORE (8 states, SVG/CSS, reduced motion) | IMPLEMENTED + CONNECTED | task.* / task_* EventBus events over existing /ws, /api/tasks resync, emergencyStop | unit + browser |
| Command input (send, quick commands) | IMPLEMENTED + CONNECTED | POST /api/chat (same session as Chat view) | browser |
| Voice | IMPLEMENTED BUT UNVERIFIED | POST /api/voice/transcribe (needs mic + STT key) | not tested |
| Attach | PLACEHOLDER (disabled, labelled) | /api/chat has no attachment support | — |
| Current task / Live activity | IMPLEMENTED + CONNECTED | /api/tasks, EventBus over /ws | browser |
| System log (filter/clear/open) | IMPLEMENTED + CONNECTED | /api/activity (+ WS warn/err). CLEAR is view-only | browser |
| Approval card | IMPLEMENTED + CONNECTED | /api/approvals, /approve, /reject | browser |
| WS connect/reconnect/resync | IMPLEMENTED + CONNECTED | reuses `ws.js` (single socket) | browser |
| Bottom nav (8) | IMPLEMENTED + CONNECTED | AGENTS -> existing `#missions` (no agents view exists) | browser |
| Responsive desktop/tablet/mobile, PWA shell | IMPLEMENTED + BROWSER-VERIFIED | sw.js precache bumped to v3 | browser (install prompt not tested) |
| First-load sequence + stored preference | IMPLEMENTED + CONNECTED | real healthz/status/memory/tools checks | browser |
| a11y (skip link, labels, focus, live region) | IMPLEMENTED | — | partial (no screen reader test) |

Also changed: `api.js` now shares one API-key prompt across concurrent 401s (previously one prompt per request); model endpoint now fails closed on an empty catalog (`src/providers/modelCatalog.js`).

## Tests
- New: 28 node tests (logic, telemetry, provider overview, model catalog) — pass.
- Browser harness: 71/71 pass.
- Full suite: 210 pass / 27 fail. All 27 fail with `Cannot find package 'express'` (npm registry is blocked in my sandbox, so `express` could not be installed). The pristine upload fails the same 27 the same way, so no regression is *shown*, but those 27 tests (incl. apiAuth, realtimeServer, e2e) have **not** run against my `index.js` changes. Run `npm install && npm test` locally.

## Remaining
- Start the real server and click through login/chat/approval/provider switch (never done here).
- Real-server checks: /healthz, /readyz, /api/system/telemetry, /api/providers/overview.
- Provider "ONLINE" only appears after a real request succeeds; unused configured providers show STANDBY by design.

## Round 2 additions (all unit-tested; none run against the real server)

| Feature | Status | Where |
|---|---|---|
| Privacy classifier + routing (PUBLIC..SECRET). SECRET never leaves the machine (fails closed if no local model); SENSITIVE -> local, else redacted cloud. **OFF by default**: set `PRIVACY_ROUTING=true` | IMPLEMENTED + TESTED (pattern-based, not semantic) | `src/privacy/`, `ProviderRouter` |
| Mission scheduler (priority, deadline, failures, budget/stuck, provider health) + bounded parallel `run-batch` | IMPLEMENTED + TESTED | `src/scheduler/`, GET `/api/missions/next`, POST `/api/missions/run-batch` |
| Watchdog + diagnostics (HEALTHY/DEGRADED/WARNING/CRITICAL); pauses active missions on CRITICAL. Runs every 30s (`WATCHDOG_ENABLED`) | IMPLEMENTED + TESTED | `src/watchdog/`, GET `/api/diagnostics` |
| Goal-drift check | IMPLEMENTED, **advisory lexical heuristic only** | `src/missions/GoalDrift.js`, GET `/api/missions/:id/drift` |
| Self-development foundation: propose -> sandbox copy (syntax + tests) -> apply (named human approver, backup, post-check, auto-rollback) -> rollback. Safety modules are protected from modification | IMPLEMENTED + TESTED (now has canary deploy — see below; still does not generate patches) | `src/selfdev/`, `/api/selfdev/*` (admin only) |
| Dashboard: Active Missions (pause/resume/stop/inspect), Autonomy, Diagnostics panels, STOP XOFT button | IMPLEMENTED + BROWSER-VERIFIED (stub backend) | `public/js/dashboard/` |

Tests: 264 total, 237 pass, 27 fail (the same express-missing failures). Browser harness: 80/80.

## 2026-09-29 update — the "Still NOT built" list below is now built
AutomationFactory (`src/automation/AutomationFactory.js`), tool generation
(`src/selfdev/ToolGenerator.js`, routed through the existing propose/sandbox/apply
gate above), autonomous deployment/canary (`src/selfdev/DeploymentManager.js`,
watches real Watchdog health post-apply and auto-rolls back on CRITICAL),
episodic + procedural memory (`src/memory/EpisodicMemory.js`,
`ProceduralMemory.js` — ExperienceStore's failure ledger is untouched and still
separate), specialist agents (`src/agents/specialists/`), per-domain autonomy
(`src/autonomy/DomainAutonomy.js`, layered on the existing global level),
an independent kill switch (`src/security/KillSwitch.js` — sentinel file +
SIGUSR2, no dashboard/API required, plus `scripts/kill-switch.mjs`), the
server-side half of wake word/VAD (`src/voice/WakeWordService.js` — real
energy-based VAD and wake-phrase matching; continuous mic listening is still
honestly client-only), and live WhatsApp/Twilio/provider checks
(`WhatsAppService.checkLive()`, `TwilioService.checkLive()`,
`GET /api/integrations/live-check`). Windows/browser/screen executors
(`pc-agent/`) were left untouched, as noted below. Full suite in this sandbox
(no network, `npm install` could not run): 268 pass, 19 fail — all 19 are the
same pre-existing `express`/`dotenv` missing-package failures, confirmed
against the baseline; no regressions.

## Genuinely still open
Windows/browser/screen executors (`pc-agent/`) were left as-is rather than
extended with CDP-based navigation — that would need a raw WebSocket client
or the `ws` package (not installable here, no network) and was judged too
large a scope addition to bolt on safely without test coverage against a
real Chrome instance. Continuous client-side wake-word listening (the
non-server half of #17) still needs a native/browser client with mic access,
same as before.
