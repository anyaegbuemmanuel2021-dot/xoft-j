# XOFT — What's Built, Compared

One table. For every capability in the original spec: what exists, whether
it actually runs right now, and exactly what's missing if it doesn't.

Status key:
- **LIVE** — runs today with zero setup (no API key needed)
- **READY** — real code, starts working the moment you add the listed credential
- **CONTRACT ONLY** — interface + docs exist; needs a separate native app to actually do anything
- **NOT BUILT** — out of scope for a backend server, explained below

| # | Capability | Status | Needs | Where |
|---|---|---|---|---|
| 1 | AI provider routing (OpenAI/Gemini/Claude) | READY | 1+ of `OPENAI_API_KEY` / `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | `src/providers/` |
| 2 | Short-term conversation memory | LIVE | — | `src/memory/ShortTermMemory.js` |
| 3 | Long-term structured memory (remember/recall/forget) | LIVE | — | `src/memory/LongTermMemory.js` |
| 4 | Semantic (vector) memory search | READY | `OPENAI_API_KEY` (embeddings) | `src/memory/VectorMemory.js` |
| 5 | Orchestrator (intent → memory/model routing) | READY | any 1 AI key | `src/orchestrator/` |
| 6 | Tool registry + risk-level tagging | LIVE | — | `src/tools/ToolRegistry.js` |
| 7 | Approval system (4 risk levels, HIGH_IMPACT never auto-approves) | LIVE | — | `src/approval/ApprovalSystem.js` |
| 8 | Task planner (goal → dependency graph → execute → retry → verify) | READY | any 1 AI key + whichever tools the plan uses | `src/planner/TaskPlanner.js` |
| 8a | Executive Brain (understand → context → memory → reason → plan → risk → permission → execute → verify → respond) | READY | any 1 AI key | `src/executive/ExecutiveBrain.js` |
| 8b | World State (live situational snapshot, "what should I be doing") | LIVE | — | `src/executive/WorldState.js` |
| 9 | Activity log / audit trail | LIVE | — | `src/activity/ActivityLog.js` |
| 10 | `remember_fact` / `recall_facts` / `forget_facts` tools | LIVE | — | `src/tools/builtins/memoryTools.js` |
| 11 | `get_current_time` / `calculate` tools | LIVE | — | `src/tools/builtins/utilityTools.js` |
| 12 | Email agent — search/read/send (Gmail) | READY | `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` | `src/agents/email/GmailService.js` |
| 13 | Calendar agent — list/create/find-free-time | READY | same Google credential as #12 | `src/agents/calendar/CalendarService.js` |
| 14 | Web research agent — search + page fetch | READY (fetch_page is LIVE) | `BRAVE_SEARCH_API_KEY` for search | `src/agents/research/SearchService.js` |
| 15 | Voice — text-to-speech | READY | `ELEVENLABS_API_KEY` | `src/voice/VoiceService.js` |
| 16 | Voice — speech-to-text (Whisper) | READY | `OPENAI_API_KEY` | `src/voice/VoiceService.js` |
| 16a | WhatsApp Cloud API inbound/outbound text + AI replies | READY | Meta WhatsApp Business Platform credentials + public HTTPS webhook | `src/integrations/WhatsAppService.js`, `/webhooks/whatsapp` |
| 16b | WhatsApp inbox/history + delivery status storage | READY | Same Cloud API webhook; persistent `/app/data` storage in production | `src/integrations/WhatsAppInboxStore.js`, Plugins & Apps |
| 16c | Mark supported inbound WhatsApp messages as read | READY | Same Cloud API credentials | `POST /api/whatsapp/read` |
| 16d | AI conversation analysis | READY | Saved Cloud API conversation + configured AI provider | `POST /api/whatsapp/analyze` |
| 16e | WhatsApp Status story publishing | NOT SUPPORTED by official Cloud API | XOFT can prepare a draft; publish manually in WhatsApp | `POST /api/whatsapp/status-draft` |
| 16f | Read personal WhatsApp Messenger chats by linking QR code | NOT BUILT | Cloud API is for Business Platform, not personal-account chat mirroring; a separate native companion with explicit OS permissions would be needed | `docs/COMMUNICATION_INTEGRATIONS.md` |
| 17 | Wake word / streaming / hands-free voice | PARTIAL — VAD + wake-phrase matching LIVE server-side; continuous mic listening NOT BUILT (inherently client-side) | a client app with mic access for the listening loop | `src/voice/WakeWordService.js`, `POST /api/voice/vad`, `POST /api/voice/wake-check` |
| 18 | Automation / rules engine (NL → trigger/condition/action) | READY | any 1 AI key | `src/automation/RulesEngine.js` |
| 19 | Notification urgency classifier | READY | any 1 AI key | `src/notifications/NotificationClassifier.js` |
| 20 | Permission system (grant/revoke/audit) | LIVE | — | `src/security/PermissionSystem.js` |
| 21 | Emergency stop (kill switch) | LIVE | — | `src/security/EmergencyStop.js` |
| 21a | Independent kill switch (sentinel file + SIGUSR2, no dashboard/API required) | LIVE | — | `src/security/KillSwitch.js`, `scripts/kill-switch.mjs` |
| 22 | Device registry (server-side identity/trust/capabilities/state model) | LIVE | — | `src/devices/DeviceRegistry.js` |
| 22a | Device Operating Layer — online/offline derivation, command queue, idempotency, verification, device events | LIVE (the routing/queueing/verification pipeline genuinely runs) | a real device agent polling `/api/devices/:id/commands/pending` to answer commands — see `docs/MOBILE_COMPANION_CONTRACT.md` | `src/devices/DeviceManager.js` |
| 22b | Device capability tools (`device_get_state`, `device_launch_app`, `device_open_url`, `device_list_files`, `device_transfer_file`, `device_media_control`, ...) | CONTRACT ONLY end-to-end (each call genuinely queues + waits + times out honestly; completes only once a real agent answers) | same as 22a | `src/tools/builtins/deviceTools.js` |
| 22c | Real-time device threat detection (command floods, failure/probing bursts, elevated-risk bursts → automatic quarantine) | LIVE | — | `src/security/DeviceThreatMonitor.js` |
| 22d | API authentication (shared-secret, all `/api/*` routes) | LIVE, but OFF by default (open on localhost/LAN unless `AUTH_API_KEYS` set — required before any non-local exposure) | `AUTH_API_KEYS` in `.env` | `src/index.js` auth middleware |
| 23 | Dashboard (status, tools, tasks, approvals, activity) | LIVE | — | `public/index.html`, served at `/` |
| 30 | Goal → Project → Task hierarchy | LIVE | — | `src/goals/GoalSystem.js` |
| 31 | Event bus (task/approval/automation/device/goal/monitor events) | LIVE | — | `src/events/EventBus.js` |
| 32 | Background monitors ("watch for X until Y") | READY | any 1 AI key + whichever tool the monitor checks | `src/background/MonitorManager.js` |
| 33 | Personality Engine (traits, mode detection, NL adjustment) | READY | any 1 AI key (for `/adjust`; trait get/set is LIVE) | `src/personality/PersonalityEngine.js` |
| 34 | User Style Model (learned from real message samples) | LIVE | — | `src/personality/UserStyleModel.js` |
| 35 | Confidence Engine (ask vs. guess before risky plans) | READY | any 1 AI key | `src/confidence/ConfidenceEngine.js` |
| 36 | Dry-run plan preview | LIVE | — | `TaskPlanner.previewPlan()` |
| 37 | Rollback / undo (memory ops, calendar events) | LIVE (once the underlying tool is READY) | depends on the tool being undone | `TaskPlanner.undoTask()` |
| 38 | Security Agent (dependency scan, secret scan, config hardening, activity anomalies) | LIVE (dependency scan needs npm registry access, which this environment has) | — | `src/security/SecurityAgent.js` |
| 39 | HTTP security headers + API rate limiting | LIVE | — | `helmet` + `express-rate-limit` in `src/index.js` |
| 40 | Advisor mode (problem-solving reasoning, not task execution) | READY | any 1 AI key | `src/advisor/AdvisorAgent.js` |
| 41 | Hierarchical permission engine with real enforcement + TTL expiry | LIVE | — | `src/security/PermissionSystem.js` + `ToolRegistry.execute()` |
| 42 | Prompt injection defense (untrusted-content wrapping + detection logging) | LIVE | — | `src/security/PromptInjectionGuard.js` |
| 43 | Reasoning Engine (decompose, compare options, contradiction/uncertainty detection) | READY | any 1 AI key | `src/reasoning/ReasoningEngine.js` |
| 44 | Model Health Manager + real provider fallback | LIVE | — | `src/providers/ModelHealthManager.js` + `ProviderRouter.complete()` |
| 45 | Memory 2.0 (importance scoring, conflict detection, consolidation, retention candidates) | READY (scoring/conflict/consolidation need an AI key; retention itself is LIVE) | any 1 AI key for the AI-backed pieces | `src/memory/Memory*.js` |
| 46 | Knowledge Graph (nodes/edges/traversal) | LIVE | — | `src/memory/KnowledgeGraph.js` |
| 47 | Background Job Manager (general scheduler, retry backoff, pause/resume) | LIVE (per-job, depends on the tool it calls) | — | `src/background/BackgroundJobManager.js` |
| 48 | Workflow Engine (fixed event-triggered cross-agent chains) | LIVE (per-workflow, depends on the tools it chains) | — | `src/workflows/WorkflowEngine.js` |
| 49 | Image generation (gpt-image-2) | READY | `OPENAI_API_KEY` (already needed for chat) | `src/agents/media/ImageGenerationService.js` |
| 50 | Video generation (Veo via Gemini API) | READY | `GEMINI_API_KEY` (already needed for chat) | `src/agents/media/VideoGenerationService.js` |
| 51 | Standalone-approval execution (approving a non-task action now actually runs it) | LIVE | — | `POST /api/approvals/:id/approve` in `src/index.js` |
| 24 | WhatsApp messaging | CONTRACT ONLY | WhatsApp Business API account, or a native companion app | `docs/MOBILE_COMPANION_CONTRACT.md` |
| 25 | Phone calls (initiate/answer, voice conversation) | CONTRACT ONLY | Twilio account, or a native companion app | same |
| 26 | Phone screen control / computer-vision automation | CONTRACT ONLY | native Android/iOS app (AccessibilityService / VoiceOver automation) | same |
| 27 | Read device notifications, SMS, contacts | CONTRACT ONLY | native companion app (NotificationListenerService etc.) | same |
| 28 | Camera / microphone capture | CONTRACT ONLY | native companion app + OS permission prompts | same |
| 29 | Coding agent w/ sandboxed execution | NOT BUILT | a hosted sandbox (Docker/gVisor) — a deployment choice, not code | — |
| 52 | AutomationFactory (NL → rule or multi-step workflow, one entry point) | READY | any 1 AI key | `src/automation/AutomationFactory.js` |
| 53 | Tool generation (AI drafts a new tool, goes through the real self-dev approval pipeline) | READY | any 1 AI key + a named human approver at apply time | `src/selfdev/ToolGenerator.js` |
| 54 | Autonomous deployment + canary rollback (watches real Watchdog health post-apply, auto-reverts on CRITICAL) | LIVE | — | `src/selfdev/DeploymentManager.js` |
| 55 | Episodic memory (narrative "what happened, when") | LIVE | — | `src/memory/EpisodicMemory.js` |
| 56 | Procedural memory (learned multi-step "how to do X", honest derived success rate) | LIVE | — | `src/memory/ProceduralMemory.js` |
| 57 | Specialist agents (research/code/data/writing, auto-routed or explicit) | READY | any 1 AI key | `src/agents/specialists/` |
| 58 | Per-domain autonomy (files/browser/devices/communication/social/finance/memory) | LIVE | — | `src/autonomy/DomainAutonomy.js` |
| 59 | Live checks of WhatsApp/Twilio/AI-provider reachability (real API calls, not just isConfigured()) | READY | WhatsApp/Twilio credentials for those two; AI providers already covered by #1 | `WhatsAppService.checkLive()`, `TwilioService.checkLive()`, `GET /api/integrations/live-check` |

## Why some rows say NOT BUILT instead of "coming later"

These aren't unfinished — they're the wrong tool for a Node backend, on any
timeline, unless you add a second codebase:

- **Wake word / streaming voice** needs continuous microphone access, which
  only exists in a browser tab or a native app the user has open. A server
  has no microphone.
- **Coding agent sandbox** — this environment (the one that wrote this code)
  already is a sandboxed execution environment; replicating it inside
  `xoft-core` means standing up your own Docker/gVisor host, which is an
  infrastructure decision for wherever you deploy, not something to
  hard-code into the repo.

## Why the CONTRACT ONLY rows can't become LIVE with more code here

Phone/WhatsApp/screen control require permissions (Accessibility Service,
Notification Listener, Camera, SMS) that only an app *installed on the
phone* can request from the OS. No backend server, however well written,
can reach into a phone it isn't installed on. `docs/MOBILE_COMPANION_CONTRACT.md`
specifies the exact API a companion app would call — that's the real next
step for these five rows, and it's genuinely a separate Android/iOS build.

## Current 2026-08-14 correction

The earlier device-layer notes in this document were written before the current native companions and screen tools were added. The current repository now includes:

- `pc-agent/` with real Windows application, browser-open, file, media, system and screen executors.
- `android-companion/` with a native Android polling companion and explicitly authorized AccessibilityService click/type support.
- `device_screen_capture`, `device_screen_click`, `device_screen_type`, `device_screen_scroll`, and `device_screen_understand` in the core tool registry.

The remaining limitations are capability depth, platform permissions and full end-to-end validation, not an absence of all device-agent code.

## Current 2026-09-29 update

Closed the gap list from `docs/COMMAND_CENTER_REPORT.md` ("Still NOT built"):
AutomationFactory, tool generation, autonomous deployment/canary, episodic +
procedural memory, specialist agents, per-domain autonomy, an independent
kill switch, server-side wake-word/VAD, and live WhatsApp/Twilio/provider
checks are now implemented — see rows 21a and 52–59 above. Full test suite
run in this sandbox (no network, so `npm install` could not run): 268 passing,
19 failing — all 19 pre-existing and solely due to `express`/`dotenv` not
being installed here (same root cause as before this change; verified no
new failures were introduced). `npm install && npm test` in an environment
with registry access is expected to resolve those 19.
