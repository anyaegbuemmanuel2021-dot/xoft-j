# XOFT — Comprehensive Source Audit & Status Matrix

**Method:** every status below is based on reading the actual source in this
session (this pass + the two prior passes on the same repository), plus live
verification where noted (clean install, boot, `/healthz`/`/readyz`, curl
against real routes, the real test suite). Nothing is inferred from
documentation, filenames, or class existence alone. Where I could not
personally execute or observe something, it is marked **NOT VERIFIED** and
says exactly why, per the six-state system this prompt requires:
`ALREADY IMPLEMENTED / PARTIALLY IMPLEMENTED / MISSING / NEEDS HARDENING /
FUTURE INTEGRATION / NOT VERIFIED`.

This repository is not a greenfield project and this audit did not rewrite
it — see the two prior reports (`XOFT_ENGINEERING_REPORT.md`,
`XOFT_CORE_HARDENING_ROUND2.md`) for the specific, small, tested changes
made across this engagement. This document is the requested consolidated
matrix and flow set, current as of this session.

---

## A. Complete Feature Matrix

| Feature | Status | Evidence | Test | Real E2E | Dependency | Remaining Gap |
|---|---|---|---|---|---|---|
| Core orchestration pipeline (understand→plan→risk→permission→approve→execute→verify→recover→learn→respond) | **ALREADY IMPLEMENTED** | `src/executive/ExecutiveBrain.js`, `src/planner/TaskPlanner.js` read line-by-line | `taskIdempotency.test.js`, `verificationAndExperience.test.js`, `e2eIntegration.test.js` | Yes, mocked-provider E2E in `e2eIntegration.test.js` | none | — |
| Request classification (question/command/task/goal/...) | **ALREADY IMPLEMENTED** | `src/executive/ExecutiveClassifier.js` | covered indirectly via `intelligenceDirector.test.js`/`adaptiveAgent.test.js` | mocked | AI provider for the classification call | no dedicated unit test file for the classifier itself |
| Reasoning engine (structured, non-hidden-CoT) | **ALREADY IMPLEMENTED** | `src/reasoning/ReasoningEngine.js` | indirect | mocked | AI provider | — |
| Planner (goal→steps, dependency graph, blockedReason) | **ALREADY IMPLEMENTED** | `src/planner/TaskPlanner.js` | `taskIdempotency.test.js`, `oversizedPlanGuard.test.js` (new) | mocked | AI provider | — |
| Agent-loop step limit | **ALREADY IMPLEMENTED** (fixed this pass) | `MAX_PLAN_STEPS = 40` guard | `oversizedPlanGuard.test.js` | live unit test | none | max duration / wall-clock cap for a single task is NOT separately enforced — see NEEDS HARDENING note below |
| Max task duration / wall-clock timeout | **MISSING** | no timeout found wrapping `TaskPlanner.execute()` itself | none | — | none | a single step can hang as long as its tool's own `await` does; there's no task-level "abort after N minutes" |
| Idempotency (no duplicate external action on retry) | **ALREADY IMPLEMENTED** | `ExecutionRecordStore.findLatestSucceeded` | `taskIdempotency.test.js` (5 tests) | live unit test, crash-recovery scenario included | none | — |
| Ambiguous/dangling execution detection | **ALREADY IMPLEMENTED** | `ExecutionRecordStore.findDangling`, `EXECUTION_AMBIGUOUS` event | `taskIdempotency.test.js` | live unit test | none | **NEEDS HARDENING**: currently auto-retries even for EXTERNAL/HIGH_IMPACT tools instead of requiring fresh approval (flagged in round-2 report §10, not yet fixed) |
| Bounded per-step retries | **ALREADY IMPLEMENTED** | `MAX_RETRIES_PER_STEP = 2` | `verificationAndExperience.test.js` | live | none | — |
| Bounded task-queue concurrency | **ALREADY IMPLEMENTED** | `TaskQueue` default concurrency 2, `TASK_QUEUE_CONCURRENCY` env | `taskQueue.test.js` | live | none | — |
| Adaptive recovery (diagnose→strategy→retry) | **ALREADY IMPLEMENTED** | `src/recovery/RecoveryEngine.js`; risk-escalation refused for `alternative_tool` | `verificationAndExperience.test.js` | live | AI provider for diagnosis | — |
| Self-verification (no false completion) | **ALREADY IMPLEMENTED** | `TaskPlanner._verifyResult`: `verified: null` when no `.verify()` exists | `verificationAndExperience.test.js` | live | none | — |
| Rollback / undo | **ALREADY IMPLEMENTED** | `TaskPlanner.undoTask`, `computeUndo` on tools that support it | indirect | live | tool must implement `computeUndo` | not every tool has one — reported honestly as "not reversible" per step, not a bug |
| Dry-run plan preview | **ALREADY IMPLEMENTED** | `TaskPlanner.previewPlan` | indirect | live | none | — |
| Experience learning (ExperienceStore, feeds RecoveryEngine) | **ALREADY IMPLEMENTED** | `src/planner/ExperienceStore.js`; `RecoveryEngine.chooseStrategy` reads `experienceStore.relevantFor()` | indirect via recovery tests | live | none | — |
| Memory (provenance, deletion, retrieval, consolidation, knowledge graph) | **ALREADY IMPLEMENTED** | `src/memory/*` (9 files) | `memoryApi.test.js`, `memoryArchitecture.test.js` | live | AI provider for embeddings (semantic search only) | semantic search specifically needs `OPENAI_API_KEY`; falls back to keyword/tag retrieval without it — this fallback itself is **NOT VERIFIED live with a real embeddings outage**, only by code inspection |
| Goals → Projects → Tasks hierarchy | **ALREADY IMPLEMENTED** (2-level, not the full 5-level Goal>Project>Mission>Task>Step named in the spec) | `src/goals/GoalSystem.js`: `createGoal`→`createProject`→`linkTask`, real `progress()` rollup from live task statuses | none dedicated | live | none | Missions (`src/missions/MissionManager.js`) are a **separate, parallel** concept, not literally nested under Project — functionally similar but structurally flatter than the spec's 5-level nesting; worth a documentation clarification, not a functional gap |
| Approval system | **ALREADY IMPLEMENTED**, **restart-persistence fixed this pass** | `src/approval/ApprovalSystem.js` now `JsonStore`-backed | `approvalRestart.test.js` (new, 3 tests) | live | none | — |
| Permission system (TTL grants, default-deny, fresh-checked) | **ALREADY IMPLEMENTED** | `src/security/PermissionSystem.js` | `deviceScoping.test.js` and others | live | none | — |
| Emergency stop | **ALREADY IMPLEMENTED** | referenced/enforced in `ToolRegistry.execute()` gate order | indirect | live | none | — |
| Prompt injection guard | **ALREADY IMPLEMENTED** | `src/security/PromptInjectionGuard.js`, unforgeable boundary marker | indirect | live | none | — |
| Device threat monitor / quarantine | **ALREADY IMPLEMENTED** | `src/security/DeviceThreatMonitor.js` referenced by tests | `deviceThreatMonitor.test.js` | live | none | — |
| API authentication (shared key, Bearer/X-API-Key) | **ALREADY IMPLEMENTED** | boot-time guard blocks production start with no key | `apiAuth.test.js` | live, curl-verified this session | none | single shared key, not per-user — flagged as a **NEEDS HARDENING** item in prior report |
| Device tokens (per-device scoping) | **ALREADY IMPLEMENTED** | `DeviceTokenService` | `deviceTokenService.test.js`, `deviceScoping.test.js` | live | none | — |
| WebSocket authentication | **ALREADY IMPLEMENTED** | `RealtimeServer._authenticate` reuses the same key/token check as REST | `realtimeServer.test.js` | live | none | — |
| WebSocket reconnect / resync | **ALREADY IMPLEMENTED** (server side: task/approval/notification state is REST-authoritative, WS is a push channel on top) | `public/js/ws.js` client reconnect logic; server emits full event set | none dedicated to reconnect timing | **NOT VERIFIED live in a real browser** — reviewed the reconnect code, did not drive an actual browser through a disconnect/reconnect cycle in this sandbox | none | needs a manual/browser-automation pass to fully confirm client-side resync behavior end to end |
| Security headers (helmet) | **ALREADY IMPLEMENTED** | `app.use(helmet())` | `securityAgent`-style self-check in `/api/security/status` | live, curl-verified | none | — |
| Rate limiting (general + expensive-endpoint) | **ALREADY IMPLEMENTED** | `express-rate-limit`, 120/min general + 5/10min on expensive routes | none dedicated to the general limiter; `expensiveRateLimit.test.js` covers the strict one | live | none | — |
| CORS policy | **MISSING** (by design — same-origin architecture) | no `cors` middleware found | — | — | none currently | not a gap for the current same-origin PWA-served-from-Core deployment; would need explicit configuration only if a separate frontend origin is ever introduced |
| CSRF protection | **N/A** (not a session-cookie architecture) | no cookie/session middleware found; auth is Bearer/API-key header only | — | — | none | CSRF requires ambient browser-sent credentials (cookies); this architecture doesn't have that attack surface |
| Prompt-injection / untrusted-content isolation | **ALREADY IMPLEMENTED** | see above | — | live | none | — |
| Secret hygiene (no committed keys) | **ALREADY IMPLEMENTED** | regex-scanned this session, none found | — | live, scanned this session | none | — |
| Path traversal protection (PC Agent files) | **ALREADY IMPLEMENTED** | `resolveWithinRoots()` chokepoint, read directly | `deviceTools.test.js`-adjacent coverage | live, code-reviewed | none | — |
| AI provider abstraction (5 providers) | **ALREADY IMPLEMENTED** | `src/providers/*` | `providers.test.js`, `providersBackfill.test.js` | mocked | at least one real key for live chat | live calls to real OpenAI/Gemini/Claude/Grok/Ollama endpoints **NOT VERIFIED** — no credentials provided this session |
| Provider fallback / health tracking | **ALREADY IMPLEMENTED** | `ModelHealthManager`, `ProviderRouter._preferenceFor` | `providers.test.js` | mocked | none | — |
| Ollama (local model) support | **ALREADY IMPLEMENTED as an optional path**, **NOT VERIFIED live** | `OllamaProvider.js`, gated behind `OLLAMA_ENABLED=true` | mocked | no local Ollama install available in this sandbox | requires a local Ollama install | needs a real Ollama instance to confirm live inference |
| Voice: TTS (ElevenLabs) | **ALREADY IMPLEMENTED as code**, **NOT VERIFIED live** | `VoiceService.js` | mocked | no `ELEVENLABS_API_KEY` provided | ElevenLabs API key | needs a real key + live call to confirm |
| Voice: STT (Whisper via OpenAI) | **ALREADY IMPLEMENTED as code**, **NOT VERIFIED live** | `VoiceService.js` | mocked | no key provided | OpenAI API key | same as above |
| Voice: wake word / streaming / barge-in | **MISSING** | not found anywhere in `src/voice/` | — | — | client-side capability, inherently not backend-providable | correctly out of scope per spec §24 |
| Vision (image/screen/document understanding) | **ALREADY IMPLEMENTED as code**, **NOT VERIFIED live** | `VisionInterpreter.js` | `visionInterpreter.test.js` (honest-failure paths tested) | mocked; honestly throws when no vision-capable provider configured | vision-capable provider key | live image analysis not exercised this session |
| Research (web search, source tracking) | **PARTIALLY IMPLEMENTED** | `researchTools.js`; page fetch itself works without a key, but the higher-quality search backend needs `BRAVE_SEARCH_API_KEY` | indirect | **NOT VERIFIED live** (no Brave key provided) | Brave Search API key for full capability | fallback-without-key behavior not exercised live this session |
| Email (Gmail) | **ALREADY IMPLEMENTED as code**, **NOT VERIFIED live** | `emailTools.js`, `GoogleAuth.js` | indirect | no Google OAuth credentials provided | Google OAuth client ID/secret/refresh token | needs a real Google account + OAuth flow to confirm |
| Calendar (Google) | **ALREADY IMPLEMENTED as code**, **NOT VERIFIED live** | `calendarTools.js` | indirect | same as email | same as email | same as email |
| File management tools | **ALREADY IMPLEMENTED** | PC Agent `files.js` executor | pc-agent test suite (6 tests) | live, path-safety reviewed directly | requires PC Agent process running and paired | multi-file bulk operations not separately stress-tested |
| Computer use (screen, app launch, browser) | **ALREADY IMPLEMENTED as code**, **NOT VERIFIED against a real live desktop this session** | `pc-agent/src/executors/{applications,browser,screen}.js`, `ComputerUseEngine` | `computerUseEngine.test.js` | mocked OS calls in test; not run against a real OS this session | a real paired Windows/Linux PC Agent | needs a live machine to fully confirm |
| Automation (rules/triggers/conditions) | **ALREADY IMPLEMENTED** | `src/automation/RulesEngine.js` | `backgroundAutomationRestart.test.js` | live | none | — |
| Background jobs / scheduler | **ALREADY IMPLEMENTED**, restart-accurate | `BackgroundJobManager`, `MonitorManager` | `backgroundAutomationRestart.test.js` | live | none | — |
| Workflow engine (structured, reusable) | **ALREADY IMPLEMENTED** | `WorkflowEngine.js` | `backgroundAutomationRestart.test.js` (double-run guard) | live | none | — |
| Proactive assistance | **ALREADY IMPLEMENTED**, permission/autonomy-aware | `ProactiveEngine.js` | `proactiveEngine.test.js` | live | none | — |
| Autonomy levels (0–5) | **ALREADY IMPLEMENTED** | `AutonomyManager.canAutoExecute` used by `ApprovalSystem.evaluate` | `autonomy.test.js`, `autoTrustLocal.test.js` | live | none | — |
| Notifications | **ALREADY IMPLEMENTED (in-app/event)**, **push NOT VERIFIED** | `NotificationClassifier`, event emission on task/approval/device events | indirect | live for in-app; Web Push not independently exercised this session | VAPID keys/browser push subscription for actual push delivery | Web Push specifically not exercised live |
| Multi-device registry (identity, trust, capabilities, heartbeat) | **ALREADY IMPLEMENTED** | `DeviceRegistry`, `DeviceManager` | `deviceManager.test.js`, `deviceScoping.test.js` | live | none | — |
| Device trust model (new device starts untrusted) | **ALREADY IMPLEMENTED** | confirmed by reading `DeviceRegistry` default trust state and `AUTO_TRUST_LOCAL` default-false, loopback-only opt-in | `autoTrustLocal.test.js` | live | none | — |
| Windows/Linux PC Agent | **ALREADY IMPLEMENTED**, typed/allowlisted, **NOT VERIFIED against a real physical Windows machine this session** | `pc-agent/src/` (6 executors), path-safety reviewed | 6 pc-agent tests, all pass | tests mock OS calls; no real Windows box available in this sandbox | a real machine, paired and running the agent | needs a live Windows/Linux box to fully confirm end-to-end |
| Android companion | **PARTIALLY IMPLEMENTED** (real logic, thin, never run on a device) | `android-companion/app/src/main/java/com/xoft/companion/` — 7 Kotlin files, 139 lines total: real register/heartbeat/poll/dispatch loop, real `AccessibilityService` gesture/text/scroll actions, real `startActivity` app launching, honest "accessibility service is not enabled by the user" failure path | **none** — no unit or instrumented test files exist for the Android module | CI only runs `gradle assembleDebug` (compiles the APK); **no install, no registration, no command execution, no screen control has ever been run on an emulator or physical device** | a physical or emulated Android device, `ADB`, manual test pass | this is the single biggest gap between "code exists" and "capability verified" in the whole repository — treat Android as compile-verified only |
| iOS companion | **MISSING** | no iOS project anywhere in the repo | — | — | would need a new Swift/SwiftUI project | correctly listed as future integration |
| Web application (chat/tasks/missions/goals/memory/approvals/devices/automation/activity/settings) | **ALREADY IMPLEMENTED** | `public/js/views/*` (8 view files) | none dedicated to frontend logic (no browser-based test harness in this repo) | **NOT VERIFIED with a real browser interaction** this session — curl-verified that the routes/assets serve correctly, did not drive the UI with a browser automation tool | none | needs a manual or Playwright-style pass to verify UI interactions, not just asset delivery |
| PWA installability (manifest, service worker) | **ALREADY IMPLEMENTED**, **NOT VERIFIED as an actual installed app on a phone** | `public/manifest.json` (`display: standalone`), `public/sw.js`; both confirmed to return `200` and correct content-type live this session | none | **NOT VERIFIED**: no real phone/browser install-and-launch cycle was performed in this sandbox (no phone available) | HTTPS deployment + a real phone/browser | see §97 for exactly what's needed |
| PWA offline behavior / honest offline states | **PARTIALLY IMPLEMENTED / NOT VERIFIED** | app-shell caching exists in `sw.js` (reviewed); did not verify at runtime that the UI distinguishes OFFLINE/QUEUED/SYNCING/CONNECTED/FAILED as the spec requires — this needs a browser-level check | none | not verified | none | needs a manual offline-mode browser test |
| Realtime resync after reconnect | **PARTIALLY IMPLEMENTED / NOT VERIFIED at the browser level** | server-side event replay design reviewed; client reconnect logic (`ws.js`) reviewed; not driven end-to-end with an actual dropped connection in a browser | none | not verified | none | needs a manual disconnect/reconnect browser test |
| WhatsApp messaging | **FUTURE INTEGRATION** (correctly, per spec §71) | `send_whatsapp_message` registered with `status: 'REQUIRES_THIRD_PARTY_SERVICE'`, throws a specific, honest, non-generic error when called | `placeholderTools` covered indirectly | throws by design, verified live this session by reading the exact error string | WhatsApp Business/Cloud API account + verified number | zero live WhatsApp path exists; the *connector architecture* for it (generic `http-json`/`mcp-http` connector type) exists and is `ALREADY IMPLEMENTED`, but no WhatsApp-specific connector has been built or tested |
| Phone calls / telephony | **FUTURE INTEGRATION** (correctly, per spec §72) | `make_phone_call`, same honest-failure pattern, `status: 'REQUIRES_THIRD_PARTY_SERVICE'` | indirect | throws by design, verified live | Twilio (or similar) account + number | same as WhatsApp — no live telephony path exists at all, core architecture is ready to receive one |
| Connector framework (generic `http-json`/`mcp-http`) | **ALREADY IMPLEMENTED** | `src/connectors/ConnectorManager.js` and adjacent, `connectors.test.js` | `connectors.test.js` | live for a generically-configured connector; no specific real third-party connector configured this session | a real endpoint + credentials for any specific connector | — |
| Channel-agnostic Core (normalized request format) | **PARTIALLY IMPLEMENTED** | the Core's internal APIs (`/api/chat`, tool execution) don't hard-code "web" as the only source, and the connector framework is source-agnostic in principle | none dedicated | not verified with an actual second live channel (e.g., a real inbound WhatsApp webhook) exercising the same Core path as the web chat | none | there is currently only one real inbound channel (the web/PWA `/api/chat` route) actually wired end-to-end; the "any channel normalizes to the same internal shape" architecture is a sound design intention confirmed at the code level, not something with two live channels to compare side-by-side yet |
| Database / persistence | **NEEDS HARDENING** | `SqliteStore` (WAL mode) covers `tasks`, `execution_records`, `experiences`, `long_term_memory`, `approvals`, device identity/tokens; **11 other stores** (`permissions.json`, `goals.json`, `missions.json`, `autonomy.json`, `background_jobs.json`, `monitors.json`, `rules.json`, `workflows.json`, `knowledge_graph.json`, `personality.json`, `user_style.json`) remain flat-JSON-only regardless of `STORAGE_MODE` | confirmed by reading every constructor for `sqliteStore` support this session | live — confirmed by inspecting `data/` after a real boot | none | this is already honestly documented in `docs/PRODUCTION_READINESS.md` as a known scaling limit, not hidden — but per spec §77 it must not be described as "SQLite migration complete," and it is not so described anywhere in the repo's own docs |
| Backup/restore | **PARTIALLY IMPLEMENTED (documented, not automated)** | `DEPLOYMENT.md` documents backing up the `xoft-data` Docker volume | none | not verified (no automated backup script exists) | none | no scripted backup/restore exists, only manual documented steps |
| Docker build | **NOT VERIFIED this session** | Dockerfile reviewed line-by-line, structurally correct | — | **not run** — no `docker` binary available in this sandbox | Docker | needs an environment with Docker to actually build and run the image |
| CI (GitHub Actions) | **ALREADY IMPLEMENTED** | `.github/workflows/ci.yml`, `release.yml` | CI runs the same `node --test` suite plus a Docker build plus Android `assembleDebug` | not run in this sandbox; reviewed the workflow file | GitHub Actions runner | not independently re-run this session, only read |
| Documentation (status honesty, README completeness) | **ALREADY IMPLEMENTED**, hardened this engagement | `docs/FEATURE_COMPARISON.md` already status-labeled; README gained PWA install/phone-usage/troubleshooting sections and a Node-version fix in pass 1 | — | — | none | one historical audit doc flagged as superseded rather than deleted |

---

## B. Architecture Diagram (as actually implemented, not aspirational)

```
                    PWA / Web Browser (public/, 8 views)
                                |
                         HTTPS + WebSocket
                                |
                                v
                     ===== XOFT CORE (src/index.js, 1151 lines, ~110 routes) =====
   ExecutiveBrain -> ReasoningEngine -> TaskPlanner -> ApprovalSystem -> ToolRegistry
        |                                    |              |               |
   ExecutiveClassifier                 ExecutionRecordStore  |         PermissionSystem
        |                                    |         PromptInjectionGuard    |
   MemoryManager <---------------------------+                          EmergencyStop
        |
   ProviderRouter -> {OpenAI, Gemini, Claude, Grok, Ollama(optional)}
        |
   EventBus -> RealtimeServer (WebSocket, authenticated)
        |
   BackgroundJobManager, MonitorManager, WorkflowEngine, RulesEngine, ProactiveEngine
        |
   ActivityLog (audit trail, every tool call / approval / recovery)
                                |
              +-----------------+------------------+
              |                 |                  |
       DeviceManager      ConnectorManager     (direct routes)
              |                 |
       +------+------+    +-----+-----+
       |             |    |     |     |
   PC Agent      Android  |  Email  Calendar
   (Node,        (Kotlin, |  (Gmail)(Google)
   typed          thin,   |
   executors,     never   WhatsApp / Telephony
   real, tested)  run on  (FUTURE INTEGRATION —
                  device) placeholder tools only)
                                |
                          SqliteStore (5 stores, WAL)
                                +
                          Flat JSON (11 stores — see matrix)
```

## C. Data Flow (a single chat-driven task)

```
POST /api/chat (web/PWA)
  -> auth check (API key / device token)
  -> ExecutiveClassifier: question | command | task | goal | ...
  -> [if task/goal] TaskPlanner.plan()
       -> ProviderRouter.complete(REASONING) -> parsed steps (JSON, validated)
       -> MAX_PLAN_STEPS guard (40) -> accept or block-with-reason
       -> persisted to tasks.json / SQLite `tasks` key
  -> TaskPlanner.execute() (or enqueued via TaskQueue if backgrounded)
       for each step (dependency-ordered):
         -> ApprovalSystem.evaluate() (risk-based)
         -> [if approval needed] persist to approvals.json/SQLite, emit APPROVAL_REQUIRED, stop
         -> [else] ToolRegistry.execute()
              -> PermissionSystem.check() (fresh, every call)
              -> ExecutionRecordStore idempotency check (succeeded/dangling/new)
              -> tool.execute()
              -> tool.verify() or explicit "unverified"
              -> ExperienceStore.record() on failure/recovery
  -> ActivityLog.log() at every step
  -> EventBus emits TASK_* events -> RealtimeServer -> WebSocket clients
  -> response returned to caller
```

## D. Security Flow

```
Request
  -> helmet() security headers
  -> express-rate-limit (120/min general, 5/10min on expensive routes)
  -> API key / device token check (Bearer or X-API-Key)
  -> [WebSocket] same auth check at upgrade time, not a separate weaker path
  -> route handler
  -> PermissionSystem.check(deviceId, permission) — default-deny, TTL-aware
  -> RiskLevel gate (SAFE auto / LOW auto-unless-configured / EXTERNAL+HIGH_IMPACT -> ApprovalSystem)
  -> EmergencyStop check (ToolRegistry.execute() gate)
  -> tool executes inside its typed, allowlisted boundary (PC Agent: resolveWithinRoots())
  -> ActivityLog records the decision + result (never the secret itself)
  -> untrusted external content (web pages, WhatsApp text, email bodies) is
     wrapped by PromptInjectionGuard before ever reaching a reasoning prompt
```

## E. Task Execution Flow

*(see §C above — this is the same pipeline; the distinct piece worth calling
out separately is the idempotency/ambiguity branch:)*

```
_executeStep(taskId, step, tool):
  priorSuccess = ExecutionRecordStore.findLatestSucceeded(idempotencyKey)
  if priorSuccess: reuse result, do NOT re-call the tool
  dangling = ExecutionRecordStore.findDangling(idempotencyKey)
  if dangling: log EXECUTION_AMBIGUOUS, emit event, [currently] proceed to re-attempt
      (NEEDS HARDENING for EXTERNAL/HIGH_IMPACT tools — see matrix)
  else: execute normally, verify, record
```

## F. Device Flow

```
Device (PC Agent / Android) boots
  -> registers with XOFT Core (POST /api/devices) -> starts UNTRUSTED
  -> heartbeats every ~5s (Android) / configurable (PC Agent)
  -> reports capabilities + state
  -> user explicitly trusts the device via the web UI
  -> Core dispatches commands only to trusted devices for anything above SAFE risk
  -> device polls for pending commands, executes only recognized typed
     capability.action pairs, reports result (success or honest failure)
  -> DeviceThreatMonitor watches for anomalies -> can quarantine/revoke
```

## G. Web/PWA Flow

```
Browser -> GET / -> public/index.html + manifest.json + sw.js (all verified 200 live)
  -> service worker caches app shell
  -> app.js boots router -> views/{chat,tasks,approvals,memory,automation,devices,activity,settings}.js
  -> ws.js opens authenticated WebSocket, subscribes to task/approval/device events
  -> REST remains authoritative; WebSocket is a push convenience on top
  -> [NOT VERIFIED this session] actual browser install-to-homescreen and
     offline/reconnect behavior — code reviewed, not driven live
```

## H. WhatsApp Flow (target architecture — NOT currently live)

```
[NOT BUILT] WhatsApp Business/Cloud API webhook
  -> [NOT BUILT] WhatsApp-specific connector (generic connector framework exists and could host this)
  -> XOFT Core (same reasoning/memory/task/tool/permission/approval/audit path as web chat)
  -> [NOT BUILT] WhatsApp outbound send
Currently: send_whatsapp_message immediately throws
"requires a WhatsApp Business API account — not configured."
```

## I. Phone Call Flow (target architecture — NOT currently live)

```
[NOT BUILT] Telephony provider (e.g. Twilio) webhook
  -> [NOT BUILT] STT
  -> XOFT Core (same path as above)
  -> [NOT BUILT] TTS
  -> [NOT BUILT] caller audio
Currently: make_phone_call immediately throws
"requires a Twilio account and phone number — not configured."
```

## J. AI Provider Flow

```
Any Core component needing AI -> ProviderRouter.complete(taskType, params)
  -> preference order for that taskType (configurable via
     AI_PRIMARY_PROVIDER / AI_FALLBACK_PROVIDERS, Ollama always last)
  -> ModelHealthManager consulted — skip a provider marked unhealthy
  -> call provider; on failure, record health, try next in order
  -> if all fail: honest error surfaced, never a fabricated response
  -> [NOT VERIFIED live] no real credentials were exercised this session;
     the mocked test suite covers this path, real provider calls do not
```

## K. Background Automation Flow

```
On boot: monitorManager.loadAndSchedule() + taskQueue.start()
  re-arm every enabled monitor/rule using REMAINING time since last run
  (not a fresh full interval) — this is restart-accurate by design and is
  covered by a dedicated test file, re-verified this session
Monitor fires -> tool call -> condition check -> [optional] task creation
  -> notification
```

## L. Memory Flow

```
New information -> classified by provenance
  (USER_STATED / SYSTEM_OBSERVED / API_RETURNED / AI_INFERRED / USER_CORRECTED)
  -> importance scored -> stored (short-term / long-term / working, per type)
  -> on retrieval: relevance + recency + importance + confidence + task/device
     relationship narrows what's actually sent to a reasoning prompt
     (never the whole memory store)
  -> MemoryConsolidator merges genuine duplicates
  -> MemoryConflictResolver flags contradictions rather than silently
     overwriting
  -> deletion (by ID or filter) is real, device-scoped, and was verified
     live this session via the actual DELETE route
```

## M. Failure Recovery Flow

```
Tool call throws
  -> ExecutionRecordStore.complete(status: 'failed')
  -> attempts <= MAX_RETRIES_PER_STEP (2)?
       yes -> RecoveryEngine.chooseStrategy(goal, step, error, experienceStore)
              -> abort | restart_app | retry_with_adjusted_input | alternative_tool
              -> alternative_tool is REFUSED if it would raise risk level
              -> ExperienceStore.record() either way
       no  -> mark step 'failed', task 'failed', ExperienceStore.record('exhausted')
  -> memory.remember('execution_failure', ...) either way, wrapped so a
     memory-write failure can never itself break execution
```

---

## Test Report

```
Core (xoft-core):    170 tests / 46 suites — 170 pass, 0 fail, 0 skipped
PC Agent:               6 tests /  1 suite  —   6 pass, 0 fail, 0 skipped
```

- **All 176 tests are real assertions against real code paths** — none are
  placeholder/no-op tests. Confirmed by reading the test files directly
  across this and the two prior passes, not just trusting the pass count.
- **Mocked vs. live**: every test that touches an AI provider uses a mock
  `router.complete()` (by design — real provider calls cost money and
  aren't reproducible in CI). Every test that touches OS-level PC Agent
  actions uses mocked executors or a temp filesystem, not a real machine.
  Every device/approval/idempotency/restart test uses real code paths
  against a real temp SQLite/JSON store — only the *external world* (AI
  vendors, real OS, real phone, real WhatsApp/Twilio) is mocked or absent.
- **E2E**: `test/e2eIntegration.test.js` is a genuine multi-component E2E
  (device lifecycle + memory scoping + realtime + restart survival +
  emergency stop) but is still confined to this process — it is not a
  browser-driven, cross-machine, or live-third-party E2E test. Labeled
  honestly: **E2E within the Node process, NOT a full physical E2E.**
- **Live verification performed this session** (outside the test suite):
  clean `npm install`, clean boot, `/healthz` and `/readyz` both `200`,
  `/`, `/manifest.json`, `/sw.js` all `200`, `/api/approvals` round-tripped
  live, `approvals` key confirmed present in the real SQLite `kv` table
  after a real boot, dependency-doctor script run and passed, full suite
  re-run clean from a genuinely fresh unzip of the delivered package.
- **Not run this session, and why**: Docker build (no `docker` binary in
  this sandbox); Android Gradle build beyond source review (no
  Java/Android SDK toolchain exercised this session, though CI does run
  `gradle assembleDebug`); pnpm/universal-client workspace (`pnpm` not
  available); any live AI provider, WhatsApp, Twilio, Google OAuth, or
  ElevenLabs call (no credentials supplied); any real-phone PWA install;
  any real-browser WebSocket disconnect/reconnect cycle; any real Windows
  or Android physical/emulated device.

---

## NOT VERIFIED — Full List, With What's Needed

| Item | Why not verified | What's needed | How to verify |
|---|---|---|---|
| Live AI provider calls (OpenAI/Gemini/Claude/Grok) | No API keys supplied this session | A real key for at least one provider | Set the key in `.env`, send a real `/api/chat` message, confirm a real model response and that `ModelHealthManager` records success |
| Ollama local inference | No local Ollama install in this sandbox | A machine with Ollama installed and a model pulled | Set `OLLAMA_ENABLED=true`, `OLLAMA_BASE_URL`, send a chat request with all cloud providers unset, confirm a real local response |
| Voice TTS/STT (ElevenLabs/Whisper) | No API keys supplied | Real API keys | Call the voice endpoints directly with real audio/text and confirm real audio/text comes back |
| Vision (image/document/screen understanding) | No vision-capable provider key exercised live | A real key + a real image | Submit a real image to the vision tool and confirm a coherent, non-fabricated description |
| Web search (Brave) | No `BRAVE_SEARCH_API_KEY` supplied | A real key | Run a research task and confirm real, current search results with real URLs |
| Email (Gmail) | No Google OAuth credentials supplied | A real Google Cloud OAuth client + a real Gmail account consenting to the scopes | Complete the OAuth flow, send/read a real test email, confirm it actually happened in the real mailbox |
| Calendar (Google) | Same as email | Same as email | Create/read a real calendar event and confirm it in the real Google Calendar |
| WhatsApp messaging | No WhatsApp Business/Cloud API account, no connector built for it yet | A verified WhatsApp Business API account/number, and building the actual connector (the generic connector framework exists; the WhatsApp-specific one does not) | Build the connector, send a real message to a real WhatsApp number, confirm delivery via the provider's own delivery-status webhook |
| Phone calls / telephony | No Twilio (or equivalent) account, no connector built | A real Twilio account/number + building the connector | Place a real call, confirm STT/TTS round-trip with a live caller |
| Android companion — install, registration, command execution, screen control | No physical or emulated Android device available in this sandbox | A physical Android phone or an emulator (AVD) with Google Play Services (for realistic testing) | Install the debug APK (already built successfully by CI), grant accessibility/notification permissions, confirm it registers with a real running XOFT Core, confirm a dispatched command (e.g. `screen.click`) actually executes |
| Windows/Linux PC Agent — real OS execution | Ran only against mocked executors and a temp filesystem in the test suite; no real Windows/Linux machine driven this session | A real machine to run `pc-agent` on, paired to a real XOFT Core | Pair the agent, dispatch a real `files.*`/`applications.*`/`screen.*` command, confirm the real OS-level effect |
| PWA install on a real phone | No physical phone available in this sandbox; also requires HTTPS, which this sandbox's `localhost` boot doesn't provide | HTTPS deployment (reverse proxy/TLS) + a real phone | Deploy behind HTTPS, open in Chrome (Android) or Safari (iOS), use "Add to Home Screen" / "Install app", confirm standalone launch |
| PWA offline behavior (OFFLINE/QUEUED/SYNCING/CONNECTED/FAILED states) | Requires driving a real browser through an actual network-loss scenario | A browser (or headless browser automation) | Load the installed PWA, disable network, confirm the UI shows an honest offline state (not a fake "connected" state), re-enable network, confirm resync |
| WebSocket disconnect/reconnect resync in a real browser | Same as above — reviewed code, did not drive a real browser | A browser | Open the app, kill the WebSocket connection (e.g. via devtools), confirm reconnect + full state resync without a manual page refresh |
| Docker build/run | No `docker` binary in this sandbox | An environment with Docker | `docker build -t xoft-core .` then `docker compose up`, confirm `/healthz` responds from the container |
| Android Gradle build beyond CI | No Android SDK/Gradle toolchain exercised directly this session (CI does run it) | Either trust CI's `gradle assembleDebug` result or run it locally | Run `gradle --no-daemon :app:assembleDebug` in `android-companion/` and confirm the APK is produced |
| Universal client experiment (`apps/mobile`, `apps/desktop`) typecheck/build | `pnpm` not available in this sandbox | pnpm + Node toolchain | `pnpm install`, then the typecheck/build commands documented in the prior report |

---

## Final Acceptance Assessment

Per this prompt's own criteria (§98): completion requires **source +
integration + security + testing + real execution + verification +
documentation**, not any one of those alone.

**What genuinely meets that full bar today:** the Core intelligence/
execution system (reasoning → planning → tool execution → verification →
recovery → learning), the approval/permission/security layer, the
background automation layer, and the web/PWA *server-side* delivery — all
five have real source, real tests, live-verified execution in this
session, and honest documentation.

**What does not yet meet that full bar, and is correctly labeled below
ALREADY IMPLEMENTED in the matrix above:** WhatsApp and telephony (correctly
FUTURE INTEGRATION — no live path exists at all yet, only honest
placeholders); Android (PARTIALLY IMPLEMENTED — real but thin code, never
run on a device); the browser-side PWA experience specifically (installed,
offline, and reconnect behavior — NOT VERIFIED live, code-reviewed only);
every external service that needs credentials no one supplied this session
(AI providers beyond mocks, voice, vision, search, email, calendar); Docker
and the universal-client build (NOT VERIFIED — tooling unavailable in this
sandbox).

None of the above is claimed as working. Each is stated as exactly what it
is, per this prompt's explicit requirement not to claim completion from
source existence alone.
