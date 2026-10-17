# XOFT 0.10.2 — Forensic Source-Code Audit

**This is an audit-only deliverable.** No files in the uploaded
`xoft-0_10_2-complete.zip` were modified to produce this report. Every
finding below was reached by opening the actual file, tracing the actual
import/registration/call path, and — where the finding concerns an external
service — checking the actual current documentation of that service. Status
symbols are used exactly as specified, with no inflation.

---

## 1. Executive Verdict

**NO** — not everything is fully implemented and correctly wired.

This build (0.10.2) is a substantial, mostly-honest continuation of prior
work on this same repository, and most of the Core is real and tested. But
tracing the actual code surfaced:

- **Two reintroduced regressions** that make two entire test suites fail on
  a clean run: `WorkflowEngine.define()` throws on every call (a never-
  initialized field), and the ambiguous-execution approval flow added for
  hardening asks for the *wrong* approval on the first attempt (order-of-
  operations bug), so the specific "approve the ambiguous retry" contract
  the test suite itself demands does not hold. Both were previously found
  and fixed in a sibling build of this same codebase (0.10.0) during this
  engagement; this 0.10.2 upload does not contain those fixes.
- **One factually incorrect behavior newly introduced this build**: the
  Experiential Labs integration silently rewrites a selected model slug by
  appending `:free` when free-only mode is on. I checked Experiential
  Labs' real, current API documentation (`platform.experientiallabs.ai/docs`)
  — there is no `:free` suffix convention on that platform; models are
  addressed by plain slugs (e.g. `claude-opus-5`), and free-vs-paid is
  governed by BYOK vs. platform-funded lanes and per-model pricing, not a
  slug suffix. As written, turning on `EXPERIENTIAL_FREE_ONLY=true` (the
  documented, recommended, *safe* setting) would corrupt every model slug
  into an invalid one and break every request — the opposite of the "never
  silently fail in a way that surprises the user, never accidentally spend
  money" goal it exists to serve. This is also asserted as fact in
  `docs/EXPERIENTIAL_LABS.md`, which is therefore currently inaccurate.
- **Dead code re-present**: `src/tools/builtins/placeholderTools.js` exists
  but is not imported or registered anywhere (confirmed by grep across
  `src/index.js`) — harmless, but it is unreachable code, not a real
  fallback path, and shouldn't be read as one.

Everything else traced in this pass — the Core pipeline, task engine,
memory, security layer, PC Agent, WhatsApp/Twilio adapters (unchanged from
the prior audited build), the 10-store SQLite migration — is genuinely
implemented and wired, with test coverage that actually exercises the code
paths it claims to. Full detail and the complete matrix follow.

---

## 2. Complete Feature Matrix

Legend: ✅ FULLY IMPLEMENTED · 🟡 PARTIALLY IMPLEMENTED · 🔴 MISSING ·
🟠 IMPLEMENTED BUT NOT VERIFIED · ⚠️ NEEDS HARDENING · 🔵 EXTERNAL DEPENDENCY

| Feature | Status | Evidence | File(s) | Runtime Wired? | Tested? | Remaining Work |
|---|---|---|---|---|---|---|
| Core orchestration (understand→plan→approve→execute→verify→recover→respond) | ✅ | Traced `ExecutiveBrain.handle()` → `TaskPlanner.plan/execute()` end to end | `src/executive/ExecutiveBrain.js`, `src/planner/TaskPlanner.js` | Yes, `src/index.js` | Yes, `e2eIntegration.test.js` | — |
| Task wall-clock timeout | ✅ | `MAX_DURATION_MS` check against `task.startedAt`, enforced inside the execute loop | `src/planner/TaskPlanner.js` | Yes | Yes — passes | — |
| Idempotency / durable execution records | ✅ | `ExecutionRecordStore.findLatestSucceeded` reused before any re-execution | `src/planner/ExecutionRecordStore.js` | Yes | Yes | — |
| Ambiguous-execution detection | 🟡 | Detection logic is real (`findDangling`) | `src/planner/TaskPlanner.js` | Yes | **Test fails** (see §4) | Fix the ordering bug (§4) |
| Approval-before-retry for EXTERNAL/HIGH_IMPACT ambiguity | 🔴 (as currently written) | Present in intent, but the generic risk-based approval gate fires *before* this check on a fresh step, so the approval the caller actually receives is the wrong one (no `reason` field) | `src/planner/TaskPlanner.js` (`_runStep`) | Yes, but produces the wrong result | **Test fails**, confirming this by direct execution, not just reading | Reorder the check ahead of the generic gate |
| Task priority / dependency graph | ✅ | `dependsOn` resolution, priority field respected in `TaskQueue` | `src/planner/TaskPlanner.js`, `TaskQueue.js` | Yes | Yes | — |
| Retry / recovery / self-verification | ✅ | Bounded retries (2), `RecoveryEngine` strategy selection, `verified: null` when unverifiable | `src/recovery/RecoveryEngine.js`, `TaskPlanner._verifyResult` | Yes | Yes | — |
| Goals → Projects → Tasks | ✅ | Real `createGoal`/`createProject`, progress computed from live task statuses, not stored redundantly | `src/goals/GoalSystem.js` | Yes | not independently unit-tested this pass | — |
| Missions | ✅ | Parallel to Goals (not literally nested under Project as one spec's diagram implies) | `src/missions/MissionManager.js` | Yes | indirect | documentation could clarify the Goal/Mission relationship |
| Agent coordination (research/media/email/calendar) | ✅ | All route through the same `ToolRegistry`; no independent execution path found | `src/agents/`, `src/tools/builtins/*Tools.js` | Yes | indirect | — |
| Provider abstraction (OpenAI/Gemini/Claude/Grok/Ollama) | ✅ | `AIProvider` base class, 5 concrete classes, all registered in `ProviderRouter` | `src/providers/*.js` | Yes | Yes (mocked) | — |
| Provider health / fallback | ✅ | `ModelHealthManager`, task-type-aware preference ordering | `src/providers/ProviderRouter.js` | Yes | Yes | — |
| **Experiential Labs provider** | 🟡 | Real class, real official base URL (verified against Experiential's actual docs), correctly registered in `ProviderRouter` and placed in every task-type preference list when configured | `src/providers/ExperientialProvider.js` | Yes | 🟠 test exists but does not exercise the behavior it's named after (see §4) | Fix `:free` suffix logic (factually wrong — see §1); validate model IDs against the catalog before accepting a switch; make gateway-first-in-preference-order configurable rather than hardcoded |
| Experiential model discovery (`listModels`) | ✅ | Uses the real, documented `/api/models` catalog endpoint (verified against live docs) | `src/providers/ExperientialProvider.js` | Yes | 🟠 not exercised by a test (no mocked-fetch test for `listModels`) | add a test |
| Experiential runtime model switching (`/api/ai/model`) | 🟡 | Real routes exist and call through `ProviderRouter`, same auth as the rest of `/api/*` | `src/index.js` | Yes | 🟠 not independently tested | switch endpoint does not validate the submitted model ID against `listModels()` before accepting it — spec explicitly requires "invalid model rejected" |
| Free-only zero-budget protection | 🔴 (broken as implemented) | The mechanism (`:free` suffix) does not correspond to how the real API works — see §1 | `src/providers/ExperientialProvider.js` | Yes (runs, just incorrectly) | Test does not catch this because it never calls `_resolveModel`/`complete()` | Needs a real design based on actual pricing/lane fields, with a fail-closed default when free/paid status can't be determined |
| Memory (short/long-term, provenance, consolidation, knowledge graph) | ✅ | Unchanged from the prior audited build | `src/memory/*` | Yes | Yes | — |
| VectorMemory SQLite persistence | ✅ (new this build) | Real `sqliteStore` support added, confirmed via a passing test that writes and re-reads a vector through a fresh instance | `src/memory/VectorMemory.js`, `MemoryManager.js` | Yes | Yes — `vectorMemorySqlite.test.js` passes | — |
| Database: 10 remaining flat-JSON stores | ✅ (migrated) | `PermissionSystem`, `GoalSystem`, `MissionManager`, `AutonomyManager`, `BackgroundJobManager`, `MonitorManager`, `RulesEngine`, `WorkflowEngine`, `KnowledgeGraph`, `PersonalityEngine`, `UserStyleModel` all confirmed to accept and use `sqliteStore` | each file, `src/index.js` wiring confirmed for all 10 | Yes | Yes (existing suites) | — |
| Security: auth, rate limiting, helmet, permissions, approvals, prompt-injection guard, emergency stop | ✅ | Unchanged from prior audited build, re-confirmed present in this zip | `src/index.js`, `src/security/*`, `src/approval/ApprovalSystem.js` | Yes | Yes | — |
| WhatsApp Cloud API adapter | ✅ (source), 🔵 (live) | Byte-identical to the previously fully-audited and tested build: signed webhook verification, real Graph API send, `ChannelGateway` routes through the same `ExecutiveBrain` | `src/integrations/WhatsAppService.js`, `src/channels/ChannelGateway.js` | Yes | **Missing in this zip** — the dedicated `whatsappService.test.js`/`channelGateway.test.js` files from the prior audited build are absent here | Live delivery requires a real WhatsApp Business account (external dependency) |
| Twilio telephony adapter | ✅ (source), 🔵 (live) | Byte-identical to the previously audited build: signed webhooks, correct TwiML escaping, real Calls REST API | `src/integrations/TwilioService.js` | Yes | **Missing in this zip** — `twilioService.test.js` absent here | Live calling requires a real Twilio account |
| Channel-agnostic Core (Web/WhatsApp/phone → same brain) | ✅ | `ChannelGateway.handle()` calls the identical `ExecutiveBrain.handle(sessionId, message)` regardless of source | `src/channels/ChannelGateway.js` | Yes | **Not tested in this zip** (test file absent) | re-add the channel gateway test |
| PC Agent (typed executors, path safety, device auth) | ✅ | Unchanged from prior audit | `pc-agent/src/*` | Yes | Yes (6 tests) | Never run against a real physical Windows/Linux machine (external dependency to verify) |
| Android companion | 🟡 | Real but thin (139 lines across 7 files); CI only compiles it | `android-companion/` | Compiles | 🔴 no unit/instrumented tests exist | Never installed/run on a device or emulator |
| Web app / PWA (server-side) | ✅ | manifest, service worker, 8 real views, all routes/assets return 200 | `public/` | Yes | 🟠 no browser-level test harness exists in this repo | Browser install/offline/reconnect behavior not independently driven this pass |
| Realtime (WebSocket) | ✅ | Authenticated at upgrade time via the same key/token check as REST, not a separate weaker path | `src/realtime/RealtimeServer.js` | Yes | Yes | Client-side reconnect/resync not verified in a real browser |
| Dead code: `placeholderTools.js` | 🔴 (unreachable) | Confirmed by grep: no import, no registration anywhere in `src/index.js` | `src/tools/builtins/placeholderTools.js` | **No** | n/a | Safe to delete |

---

## 3. Core Architecture Verification

Traced `POST /api/chat` → `ExecutiveBrain.handle()` → `ExecutiveClassifier`
→ (if task/goal) `TaskPlanner.plan()` → `ProviderRouter.complete()` →
parsed steps → `TaskPlanner.execute()` → per-step `ApprovalSystem.evaluate()`
→ `ToolRegistry.execute()` → `PermissionSystem.check()` →
`ExecutionRecordStore` idempotency check → tool run → verify → `ActivityLog`
→ `EventBus` → `RealtimeServer`. Every link in this chain is a real function
call in real source, not a stub. This matches the architecture required by
both the original XOFT spec and this audit's own requirements.

## 4. Task Engine Verification — includes the two confirmed regressions

I ran the actual test suite rather than reading it. From a clean install:

```
# tests 175
# pass 172
# fail 3
```

**Failure 1 — `WorkflowEngine — restart-safe event listeners` (2 subtests).**
`WorkflowEngine`'s constructor never initializes `this._listeners`, but
`define()`, `reattachListeners()`, and `disable()` all call
`this._listeners.set/.get/.has/.delete`. Every call to `define()` throws
`TypeError: Cannot read properties of undefined (reading 'set')`.
File: `src/workflows/WorkflowEngine.js`, constructor.

**Failure 2 — `TaskPlanner hardening`, "an ambiguous EXTERNAL step requires a
fresh approval tagged with the reason, not a silent retry" (1 subtest).**
In `TaskPlanner._runStep()`, for a fresh (not-yet-approved) step, the
generic risk-based gate (`this.approvalSystem.evaluate(...)`) runs and
returns before the ambiguity-specific check (further down, inside
`_executeStep`, which calls `this.approvalSystem.requestApproval(...,
reason: 'ambiguous_prior_execution')`) is ever reached. For an
EXTERNAL-risk tool with a dangling execution record, the caller receives an
approval ID from the generic gate — which was never told this is an
ambiguous retry and so never sets a `reason` — not the ambiguity-specific
approval the test (and the safety design) expects. Traced by running the
test, reading the stack, then reading both call sites in
`src/planner/TaskPlanner.js` to confirm the order.

Both were previously found and fixed in this same codebase's 0.10.0 build
during this engagement (not carried into this 0.10.2 upload). Per this
audit's "do not modify" instruction, they are reported, not fixed, here.

**Everything else in the task engine** — dependency resolution, bounded
retries, wall-clock timeout, rollback/undo, dry-run preview — passed on
direct execution.

## 5. Autonomy Verification

`AutonomyManager` (0–5 ladder), `ProactiveEngine`, `BackgroundJobManager`,
`MonitorManager`, `RulesEngine`, `WorkflowEngine` (bug aside) are all real
and SQLite-capable per the store migration confirmed in §2. Emergency stop
is enforced inside `ToolRegistry.execute()`'s gate order, confirmed by
reading the method directly.

## 6. Memory Verification

Unchanged core memory architecture, plus a genuinely new capability this
build: `VectorMemory` now supports `sqliteStore`, confirmed by a real test
that writes a vector with one instance and reads it back with a second,
fresh instance pointed at the same store (the actual restart-survival
pattern this whole engagement has been checking for elsewhere).

## 7. Security Verification

Re-confirmed present and unchanged: helmet, rate limiting (general +
strict on expensive routes), API-key/device-token auth (REST and
WebSocket, same check), default-deny permissions with TTL, prompt-injection
boundary wrapping, webhook signature verification for both WhatsApp
(HMAC-SHA256) and Twilio (HMAC-SHA1, Twilio's documented algorithm) —
verified in the prior pass by computing a real signature myself and
confirming it validates; not re-derived from scratch this pass since the
files are byte-identical to what was already tested.

## 8. Tool Verification

Every tool file (`system`, `files`, `browser`, `screen`, `applications`,
`communication`, `research`, `memory`, `automation`, `calendar`, `email`,
`media`) registers through the same `ToolRegistry.register()` /
`ToolRegistry.execute()` chokepoint — confirmed by grep, no tool file
calls anything outside that path. `send_whatsapp_message` and
`make_phone_call` (in `communicationTools.js`, not the dead
`placeholderTools.js`) correctly report `REQUIRES_API` status and refuse to
run without real credentials — confirmed by reading `Tool.js`'s status gate.

## 9. PC Agent Verification

Unchanged from the prior audited build: typed executors only, no generic
`exec()`, path-traversal guard (`resolveWithinRoots()`) confirmed by direct
read, 6/6 tests pass. Never run against a real physical machine in this or
any prior sandbox session — that remains an external-dependency gap, not a
source-code gap.

## 10. Web/PWA Verification

`public/index.html`, `manifest.json` (`display: standalone`), `sw.js` all
present; not re-served/curled fresh in this specific audit pass (no server
was booted for this specific zip during the audit phase, per the "inspect
only" instruction), but the files are byte-identical to the prior build
where this was live-verified with curl (200 on all three, correct
content-types).

## 11. Realtime Verification

`RealtimeServer._authenticate()` reuses the same key/device-token check as
REST — confirmed by direct read. Not re-driven with a live WebSocket client
in this specific audit pass.

## 12. WhatsApp Verification

Traced the full path in source: signed webhook (`X-Hub-Signature-256`,
HMAC-SHA256, timing-safe compare) → `verifyWebhookToken` for the GET
challenge → `parseWebhook` extracts text messages and delivery statuses →
`ChannelGateway.handle({channel:'whatsapp', ...})` → same `ExecutiveBrain`
as web chat → `whatsappService.sendText()` posts to the real Graph API
endpoint. **SOURCE IMPLEMENTED.** **LIVE PROVIDER: NOT VERIFIED** — no
WhatsApp Business account/credentials exist in this environment, and no
dedicated test file for this path exists in *this specific* 0.10.2 upload
(it existed in the sibling 0.10.0 build from this engagement; it is absent
here).

## 13. Telephony Verification

Same tracing method: `TwilioService.validateSignature()` implements
Twilio's actual documented algorithm (verified by independently computing a
matching signature in the prior pass's tests) → TwiML generation escapes
untrusted text (prevents a spoken-text injection from producing a real
`<Redirect>` tag) → `createCall()` posts to the real Calls REST API with
Basic auth. **SOURCE IMPLEMENTED. LIVE PROVIDER: NOT VERIFIED** — no Twilio
account exists in this environment; the dedicated test file is likewise
absent from this specific upload.

## 14. Channel Gateway Verification

`ChannelGateway.normalize()` produces one shape regardless of channel;
`handle()` calls the identical `ExecutiveBrain.handle(sessionId, message)`
method for web, WhatsApp, and telephony alike — confirmed by reading the
class, which is 25 lines and does nothing else. No per-channel brain exists
anywhere in the repository (grep confirms no `WhatsAppBrain`/`PhoneBrain`/
similar class exists). **Not exercised by a test in this specific upload.**

## 15. Database/Persistence Verification

| Store | File | Backend | Durable? | Verified this pass? |
|---|---|---|---|---|
| tasks | tasks.json / SQLite `tasks` | JsonStore+sqliteStore | Yes | code-confirmed |
| execution_records | execution_records.json / SQLite | JsonStore+sqliteStore | Yes | code-confirmed |
| experiences | experiences.json / SQLite | JsonStore+sqliteStore | Yes | code-confirmed |
| long_term_memory | long_term_memory.json / SQLite | JsonStore+sqliteStore | Yes | code-confirmed |
| approvals | approvals.json / SQLite | JsonStore+sqliteStore | Yes | code-confirmed |
| **vector memory** | (new) SQLite-capable | JsonStore+sqliteStore | Yes | **test-confirmed this build** |
| permissions | permissions.json / SQLite | JsonStore+sqliteStore | Yes | code-confirmed |
| goals | goals.json / SQLite | JsonStore+sqliteStore | Yes | code-confirmed |
| missions | missions.json / SQLite | JsonStore+sqliteStore | Yes | code-confirmed |
| autonomy | autonomy.json / SQLite | JsonStore+sqliteStore | Yes | code-confirmed |
| background_jobs | background_jobs.json / SQLite | JsonStore+sqliteStore | Yes | code-confirmed |
| monitors | monitors.json / SQLite | JsonStore+sqliteStore | Yes | code-confirmed |
| rules | rules.json / SQLite | JsonStore+sqliteStore | Yes | code-confirmed |
| workflows | workflows.json / SQLite | JsonStore+sqliteStore | Yes | code-confirmed (though `WorkflowEngine` itself is currently broken — see §4) |
| knowledge_graph | knowledge_graph.json / SQLite | JsonStore+sqliteStore | Yes | code-confirmed |
| personality | personality.json / SQLite | JsonStore+sqliteStore | Yes | code-confirmed |
| user_style | user_style.json / SQLite | JsonStore+sqliteStore | Yes | code-confirmed |
| devices, tokens | SQLite only | SqliteStore | Yes | code-confirmed |
| sessions, notifications, events, provider health | in-memory / event-emitted, not separately persisted | n/a | No | this matches the architecture (these are runtime/transient by design, not omissions) |

`STORAGE_MODE=sqlite` genuinely changes behavior: confirmed in the prior
pass by booting the real server and finding the `approvals`/`tasks` keys in
the actual SQLite `kv` table, not just present in config. Not re-booted for
this specific zip (audit-only), but the code is unchanged in this respect
from the previously-booted build.

## 16. API/Route Verification

~110 routes registered in `src/index.js`, including the new
`/api/ai/model` (GET/POST) and `/api/ai/models` (GET). No dead routes,
placeholder routes, or routes calling nonexistent functions were found in
this pass. One gap: `POST /api/ai/model` accepts any non-empty string as a
model ID without validating it against `listModels()` first — the
documented spec explicitly requires "invalid model rejected," which this
does not yet do (it will fail later, at actual request time, instead).

## 17. Placeholder/Dead-Code Audit

- `src/tools/builtins/placeholderTools.js` — present, not imported or
  registered anywhere. **Dead code.**
- `EXPERIENTIAL_FREE_ONLY`'s `:free`-suffix mechanism — not dead code, but
  **factually incorrect** relative to the real service it targets (§1).
- No other `TODO`/`FIXME`/hardcoded-success patterns found that weren't
  already accounted for in the prior audit of this codebase.

## 18. Test Results

```
# tests 175
# suites 47
# pass 172
# fail 3
# duration_ms ~18800 (single run; a full-suite run in this sandbox has
  previously shown one unrelated, non-reproducible flake in memoryApi.test.js
  under load — not observed in this specific run)
```

pc-agent: 6/6 pass, unchanged.

**Test matrix (abridged to what changed or is newly relevant this build):**

| Feature | Test exists | Passes | Integration-tested | Notes |
|---|---|---|---|---|
| WorkflowEngine restart-safety | Yes | **No** | Yes (that's how the bug was caught) | regression |
| Ambiguous-execution approval reason | Yes | **No** | Yes | ordering bug |
| Experiential provider config/state | Yes | Yes | **No** — never calls `complete()` or `_resolveModel()` | test name overstates what it covers |
| Experiential model discovery | No | — | — | gap |
| Experiential free-only enforcement | No | — | — | gap — and the thing it would test is currently wrong anyway |
| VectorMemory SQLite persistence | Yes | Yes | Yes | genuinely solid |
| WhatsApp adapter | **No** (absent from this upload) | — | — | existed in a sibling build; not in this zip |
| Twilio adapter | **No** (absent from this upload) | — | — | same |
| ChannelGateway | **No** (absent from this upload) | — | — | same |

I ran the suite directly; nothing here is asserted without execution.

## 19. Build/Deployment Results

`npm install` (root + `pc-agent/`): clean. Node version consistency
(`package.json` `engines.node`, Dockerfile `node:22`) not re-diffed this
pass since neither file changed from the already-consistent prior build
except `package.json`'s version bump and `package-lock.json` (dependency
tree unchanged in substance). Docker build itself: **NOT VERIFIED** — no
`docker` binary available in this sandbox, same limitation as every prior
pass in this engagement.

## 20. Documentation vs. Source

| | |
|---|---|
| **Documented but not implemented (or implemented incorrectly)** | `docs/EXPERIENTIAL_LABS.md` states XOFT "converts a selected plain model slug to the gateway's `:free` lane when necessary" — this mechanism exists in code but does not correspond to how Experiential Labs' real API works (no such convention in their docs) |
| **Implemented but not documented** | The two regressions in §4 are, naturally, not documented anywhere (no one knew) |
| **Documented and implemented correctly** | Everything else checked: `.env.example`'s new Experiential vars match `config/index.js` exactly; `README.md`'s WhatsApp/Twilio section (unchanged from prior build) still matches the real adapter files |

## 21. Remaining Gaps

1. `WorkflowEngine._listeners` never initialized — breaks every `define()` call.
2. `TaskPlanner._runStep` checks the generic approval gate before the
   ambiguity-specific one, so an ambiguous EXTERNAL/HIGH_IMPACT retry never
   gets the reason-tagged approval the design (and its own test) expects.
3. Experiential `:free` suffix logic is factually wrong for the real API
   and would break every request when the documented "safe" setting
   (`EXPERIENTIAL_FREE_ONLY=true`) is enabled.
4. `POST /api/ai/model` does not validate the submitted model ID against
   the real catalog before accepting it.
5. No test coverage for `ExperientialProvider.complete()`,
   `_resolveModel()`, or `listModels()` — the one test file that exists
   doesn't exercise the behavior its own test name describes.
6. WhatsApp/Twilio/ChannelGateway test files present in a sibling build of
   this same codebase are absent from this specific upload.
7. `placeholderTools.js` is dead code.
8. Android companion remains compile-verified only (unchanged limitation).
9. Everything requiring external credentials (live AI providers beyond
   mocks, live WhatsApp/Twilio, live Experiential Labs key, a real phone,
   a real PC, Docker) remains 🔵 EXTERNAL DEPENDENCY / NOT VERIFIED, as in
   every prior pass of this engagement — nothing new here, restated for
   completeness of this audit's own required structure.

## 22. Final Yes/No Answer

**"Is everything from the XOFT specification actually implemented in the
attached source code?"**

**NO.**

Two regressions cause two test suites to fail outright on a clean run
(§4), and the Experiential Labs free-only safety mechanism — the specific
feature whose entire purpose is to prevent unexpected spending — does not
work as implemented against the real service it targets (§1). These are
not external-dependency gaps; they are source-code defects, reachable and
demonstrable without any credentials, in the exact areas this audit was
asked to verify most carefully (task-execution safety and zero-budget
protection).
