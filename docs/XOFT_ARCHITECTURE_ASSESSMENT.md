# Architecture assessment — done before integrating Hermes (v0.10.2 → v0.11.0)

Produced by reading the repository (not guessed). It answers the 14 points requested, then states what was built from it.

**1. Current architecture.** Node ≥ 22, ESM, one Express app wired in `src/index.js` (~1,500 lines, ~200 routes) with domain modules under `src/`.
Dashboard: vanilla-JS PWA in `public/` (hash router, `views/*.js`, service worker, WebSocket bridge). `pc-agent/` is a separate Node process (the *Device Runtime*) that
connects out to the server. `apps/mobile`, `apps/desktop`, `packages/*` are universal clients. Persistence: JSON files or SQLite (`STORAGE_MODE`) through `JsonStore`. Tests: `node --test` (486 at the start).

**2. Existing engine / AI system.** There was **no execution-engine abstraction**. `ProviderRouter` + `ModelHealthManager` route *LLM calls* across OpenAI / Gemini / Claude / Ollama / FreeLLMAPI / LiteLLM with failover — that is provider independence, not engine independence.
`Orchestrator.handle()` is the chat loop; `ExecutiveBrain` is the reasoning pipeline.

**3. Existing task system.** `TaskPlanner` (goal → plan → execute → verify → retry → undo, with idempotency, recovery and rollback) + `TaskQueue` (`TASK_QUEUE_CONCURRENCY`); `MissionManager`, `BackgroundJobManager`, `WorkflowEngine` on top. Task events are `task.*` on the `EventBus`.

**4. Existing tool system.** `Tool` (name, schema, `requiredPermissions`, `RiskLevel` SAFE/LOW/EXTERNAL/HIGH_IMPACT) and `ToolRegistry`, the single choke point that enforces `PermissionSystem` (per-device grants) and `EmergencyStop`. ~50 builtin tools (memory, e-mail, calendar, research, media, connectors, device, runtime).
`ApprovalSystem` + `AutonomyManager` + `DomainAutonomy` decide auto vs. human approval.

**5. Filesystem.** `file_*` / `workspace_*` / `operations_*` tools executed by the pc-agent inside registered workspaces: journaled, undoable, deletes recoverable, sensitive files (`.env`, keys, tokens) unreadable.

**6. Browser.** `browser_*` tools — CDP-based browser control on the paired device.

**7. PC control.** `device_*` tools (launch/close/list apps, screen capture/click/type/scroll, `device_computer_use`, media control) gated by per-device grants; `terminal_run` is *allow-listed*.

**8. Model/API integrations.** Provider SDK-free HTTP clients behind `AIProvider`; gateways (FreeLLMAPI, LiteLLM); optional privacy routing to local models.

**9. Best Hermes integration point.** A new `src/engines/` layer *beside* `TaskPlanner`, registered in `src/index.js`; Hermes reached only through its documented HTTP API server (own process/environment); Xoft's tools offered to Hermes through an MCP gateway so there is one tool registry, one permission system, one approval flow.

**10. Existing files modified (all additive).** `src/index.js` (wiring, approvals hand-off, `/api/status`, shutdown), `src/approval/ApprovalSystem.js` (pure `decide()` extracted from `evaluate()`, behaviour identical), `src/watchdog/Watchdog.js` (`engines` check),
`src/config/index.js` (`engines` block), `public/js/app.js` + `public/sw.js` + `public/css/app.css` (new view), `package.json` (version, `bin`, script), `.env.example`, `README.md`.

**11. New files.** `src/engines/**` (≈20 modules, `hermes/` subfolder for everything Hermes-specific), `src/tools/builtins/engineTools.js`, `public/js/views/engines.js`, `scripts/xoft.mjs`, `docs/HERMES_ENGINE.md`, this file, and tests (`test/engine*.test.js`, `test/hermes*.test.js`, `test/xoftCli.test.js`, `test/_fakeHermes.js`).

**12. Dependencies Hermes requires.** Hermes installed with its own environment; a model provider configured in Hermes; its API server enabled with a key; Git recommended. Xoft gains **no new npm dependency**. Details: `docs/HERMES_ENGINE.md` §3.

**13. Conflicts found and how they were resolved.**
* The approve route executed *standalone* approvals itself → an engine/gateway approval would have run a tool twice. Fixed: approvals carrying `metadata.engineId` are routed to the task manager and never executed by the route.
* `EventBus.emitEvent()` writes every event to the activity log (whole-file JSON rewrite) → per-tool-call events would be O(n²). Fixed: lifecycle events are audited; high-frequency events use the raw bus + a per-task append-only JSONL log.
* `task.*` event names belong to `TaskPlanner` (other modules react to them) → engine events are namespaced `engine.*`.
* `terminal_run` is allow-listed while Hermes' terminal is not → native Hermes tools are policy-checked from events and the profile ceiling defaults to `standard`; the honest limit (monitor vs. intercept) is documented.
* MCP gives the gateway no per-task identity → `task_id` is injected into every schema; ambiguity resolves to the most restrictive policy.

**14. Integration risks.** (a) Hermes' exact event/approval field names could differ from the docs → tolerant parsing + a first-run checklist. (b) Native tools can't be pre-empted → `enforce` mode + docs on restricting Hermes' toolsets / sandboxing. (c) Windows paths/process trees untested here. (d) Autonomous agents touching real files → git safety net, protected paths, destructive actions always human-approved. (e) Regression → every addition is additive and optional; Hermes absent = identical behaviour to v0.10.2.
