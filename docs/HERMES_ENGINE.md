# Execution engines & the Hermes Agent integration

Xoft (v0.11) runs work through **pluggable execution engines**. Two are registered:

| Engine | Id | What it is |
|---|---|---|
| **Xoft Core** | `xoft-core` | Xoft's existing machinery behind the engine interface: `Orchestrator` (chat), `TaskPlanner` (plan → execute → verify → retry), the `ToolRegistry`, the approval system and paired devices (pc-agent). No behaviour was changed. |
| **Hermes** | `hermes` | [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research), used as an *optional* autonomous engine for long-running coding / terminal / multi-step work. |

**Xoft stays the controller.** It chooses the engine, enforces permissions, autonomy and limits itself, asks you before anything
destructive, keeps the audit trail, and keeps working when Hermes is missing, misconfigured, offline or crashing. Hermes is never mandatory.

## Contents
1. [What is and isn't verified](#1-what-is-and-isnt-verified) · 2. [Architecture](#2-architecture) · 3. [Requirements](#3-what-hermes-requires)
· 4. [Install & connect](#4-install--connect-hermes) · 5. [Configuration](#5-configuration) · 6. [Engine registration & capabilities](#6-engine-registration-capabilities-routing)
· 7. [Permissions & autonomy](#7-permissions--autonomy) · 8. [Task execution](#8-task-execution) · 9. [Tool Gateway (shared tools)](#9-the-tool-gateway-shared-tools)
· 10. [Fallback](#10-fallback) · 11. [Recovery](#11-failure-recovery) · 12. [Safety net for code](#12-git-safety-net) · 13. [Security](#13-security)
· 14. [CLI / API / UI / events](#14-cli-api-ui-events) · 15. [Troubleshooting](#15-troubleshooting) · 16. [Development guide](#16-development-guide) · 17. [Known limits](#17-known-limits)

---

## 1. What is and isn't verified

Read this first. It says exactly how far each claim has been tested.

**Verified by automated tests in this repository (111 new tests, all passing — the suite went from 486 to 597 tests):**
- The engine interface, registry (health isolation, timeouts, events), task analyzer and router (capability matching, partial availability, fallback chains, explanations).
- The task manager: queueing/concurrency/priority, permission clamping, native-tool policy enforcement, tool-call and time limits (waiting for a human does not count as time), approvals through Xoft's real `ApprovalSystem`, cancel/pause/resume, crash recovery with bounded retries, "paused with reason" when recovery is impossible, restart recovery (re-attach vs. restart), shutdown detach, secret redaction in logs, honest verification.
- The Hermes adapter **against a faithful in-process fake of Hermes' documented HTTP API** (`test/_fakeHermes.js`): `/health`, `/health/detailed`, `/v1/capabilities`, `/v1/toolsets`, `POST /v1/runs` (+ `Idempotency-Key`), `GET /v1/runs/{id}`, SSE `/v1/runs/{id}/events`, `/stop`, `/approval`, including crashes, restarts, hangs and reconnects — over real sockets.
- The managed-process supervisor (a stand-in `hermes` executable is started, supervised, log-redacted, stopped).
- The Tool Gateway (MCP JSON-RPC over HTTP): auth, loopback restriction, per-task permission checks, path scoping, approvals, redaction.
- The git safety net against real git repositories; the CLI against a real HTTP server; the dashboard view by static contract tests.
- `src/index.js` was booted with the new wiring (using throwaway stand-ins for Express/Helmet because the build sandbox had no network) and the endpoints, Tool Gateway, fallback messages and clean shutdown were exercised over HTTP. The unchanged part of the existing suite still passes (see §17 for the one caveat).

**NOT verified — needs a live Hermes on your machine (do this once, it takes a few minutes; see §4 and the "first run checklist"):**
- Field names of Hermes' `approval.request` event and the body of `POST /v1/runs/{id}/approval`. The adapter follows the documentation (`once`/`deny` decisions) and tolerates variants, but if Hermes names things differently, approvals raised *by Hermes* will not round-trip. (Approvals raised by *Xoft's Tool Gateway* do not depend on this.)
- The exact tool names Hermes reports in `/v1/toolsets` and `tool.started` (used to classify native tools). Unknown tool names are **not** guessed at — they are left unclassified (and surfaced), never silently allowed or blocked.
- That your Hermes version loads the `mcp_servers` HTTP entry exactly as written in §9 (documented format, `${VAR}` interpolation of headers).
- Behaviour on native Windows (paths, `.cmd` shims, process-tree stop). The code handles these cases but they were exercised only on Linux.
- Real model behaviour: whether Hermes actually obeys the constraints in its instructions. Xoft does not depend on it — enforcement is in Xoft — but quality of results is Hermes' and your model's.

**First run checklist (with a real Hermes):**
1. `npm run xoft -- engine status hermes` → `Availability: ready`, dependencies `api_key=yes`, `model=yes`.
2. Start a harmless task in a scratch git repo: `npm run xoft -- task run --dir ~/scratch --engine hermes --wait "Create hello.txt containing hi, then run ls"`.
3. Watch the Engines page: tool events should stream, `hello.txt` should appear under *files changed*.
4. Ask it to delete something: a Xoft approval must appear (Approvals page, or the task card). Approve → it continues. If Hermes shows the request but approving does nothing, send me the `approval.request` event from `npm run xoft -- task logs <id> --json` — that is the one field-name risk above.
5. `Stop` the task while it runs → Hermes must stop (check `hermes` logs).

## 2. Architecture

```
                         XOFT  (Express app, dashboard, memory, approvals, audit log)
                           │
        ┌──────────────────┴───────────────────────────────────────────┐
        │                  EngineTaskManager                           │  queue · limits · permissions · approvals
        │  persisted tasks + append-only event log · recovery · verify │  recovery · git safety net · observability
        └──────┬───────────────────────────────────────────┬───────────┘
               │ route()                                   │ execute / stream / cancel / pause / resume / recover
         EngineRouter  ◄── TaskAnalyzer (deterministic, no LLM)      EngineRegistry (health, status, events)
               │
   ┌───────────┴────────────┬───────────────────────────┐
   │ XoftCoreEngine         │ HermesEngine (src/engines/hermes/*)          future engines: implement Engine
   │ Orchestrator+Planner   │   HermesClient  HTTP + SSE  ───►  Hermes API server  (hermes gateway, :8642)
   └────────────────────────┘   HermesProcess (optional, Xoft-started, loopback only)       │
                                                                                            ▼
        Xoft ToolRegistry ◄── ToolGateway (MCP, bearer token, loopback) ◄── Hermes (mcp_servers: xoft)
        (permissions, approvals, journaled file ops, browser, devices, memory, e-mail …)
```

* **Hermes-specific code lives only in `src/engines/hermes/`.** The rest of Xoft sees the `Engine` interface. Nothing imports Hermes internals;
  Hermes runs as a separate process in its own environment, reached only over its documented HTTP API.
* The **Engine interface** (`src/engines/Engine.js`): `id, name, status, capabilities, initialize(), execute(task, ctx), stream(), cancel(), pause(), resume(),
  healthCheck(), shutdown()` plus `resolveApproval()`, `recover()`, `canServe()`, `routingWeight()`, `taskPolicy()`, `ensureAvailable()`.
* **Existing systems were reused, not duplicated:** `ApprovalSystem` (one new pure method `decide()` extracted from `evaluate()`, behaviour unchanged),
  `EventBus`, `ActivityLog`, `JsonStore`/SQLite, `AutonomyManager` (the global level is a *ceiling* for every engine task), `EmergencyStop`
  (cancels engine tasks too), `Watchdog` (new `engines` check), `ToolRegistry` (shared with Hermes through the gateway), the Approvals page.
* What did **not** exist before and was added: an engine abstraction, a router, an engine task manager, the permission-profile model, the MCP gateway, a CLI.

## 3. What Hermes requires

Xoft needs nothing extra to run without Hermes. To use Hermes:

| Requirement | Notes |
|---|---|
| Hermes Agent installed | Official installer (below). It manages its own environment — **Xoft never shares a Python environment with Hermes** and never imports it. Linux, macOS, WSL2, and native Windows (PowerShell installer) are the documented platforms. |
| A model provider configured **in Hermes** | `hermes setup`. Xoft does not pass its own provider keys to Hermes (a Xoft-started Hermes gets a minimal environment). |
| Hermes API server enabled | `API_SERVER_ENABLED=true` and `API_SERVER_KEY=<long random secret>` in Hermes' `.env`, then `hermes gateway` (default `http://127.0.0.1:8642`). A Xoft-started Hermes gets these automatically. |
| The same key given to Xoft | `HERMES_API_KEY` in Xoft's `.env` (not needed when Xoft starts Hermes: it generates and stores one, mode 0600). |
| Git (recommended) | For the code safety net (§12) and ground-truth change summaries. |
| An online paired device (optional) | Only for the *bridged* browser / PC-control / device tools (§9). |

Xoft itself: Node ≥ 22 (unchanged). Nothing new in `package.json` dependencies.

## 4. Install & connect Hermes

Xoft **never installs software by itself.** It detects, explains, and (only on explicit request) runs the official installer.

```bash
npm run xoft -- engine detect                  # OS, Node, Python, Git, package managers, Hermes (path/version/home/providers)
npm run xoft -- engine install hermes          # prints the official command for your OS
npm run xoft -- engine install hermes --run --yes   # only if YOU want Xoft to run it
```

Official commands (from the Hermes docs; shown by `engine install`):
* Linux / macOS / WSL2: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`
* Native Windows: `iex (irm https://hermes-agent.nousresearch.com/install.ps1)`

Then:
```bash
hermes setup && hermes doctor                  # choose a model provider; diagnose
# Option A — you run Hermes:   put API_SERVER_ENABLED=true / API_SERVER_KEY=... in ~/.hermes/.env, run `hermes gateway`,
#                              and set HERMES_API_KEY=<same key> in Xoft's .env
# Option B — Xoft runs Hermes: HERMES_AUTO_START=true  (or: npm run xoft -- engine start hermes)
npm run xoft -- engine status hermes
```
If Hermes is **already running** at `HERMES_API_URL`, Xoft reuses it and does not start a second one. Xoft only ever stops a Hermes **it started**.
A Xoft-started Hermes binds loopback only (a non-loopback URL is refused).

## 5. Configuration

Precedence: built-in defaults < environment (`HERMES_*`, see `.env.example`) < settings saved from the dashboard / `xoft engine settings`
(stored in `data/engines/hermes-settings.json`, owner-only, **never any secret**). A bad value is ignored (the default stays) so a typo cannot stop Xoft booting.

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | true | Off = Hermes is `disabled`; never routed to; no network calls. |
| `autoStart` | false | Start `hermes gateway` at Xoft start-up (only if it is installed and not already running). |
| `baseUrl` | `http://127.0.0.1:8642` | Hermes API server. |
| `runtimePath` / `hermesHome` | auto | Executable and data dir (`HERMES_HOME`; `%LOCALAPPDATA%\hermes` on native Windows). |
| `workingDirectory` | – | Default project folder for coding/file tasks. |
| `allowedRoots` | [] | If set, Hermes tasks may only run inside these directories. |
| `defaultAutonomy` | 2 | 0–5. Xoft's global level is a ceiling. |
| `permissionProfile` | `standard` | Ceiling for every Hermes task (§7). |
| `maxConcurrentTasks` | 2 | Per-engine limit (plus the global `ENGINES_MAX_CONCURRENT_TASKS`). |
| `timeoutMs` | 1 h | Per-task wall clock, **excluding time waiting for you**. |
| `maxToolCalls` | 500 | Per task, 0 = unlimited. |
| `maxRetries` | 2 | Recovery attempts after an engine failure (exponential back-off). |
| `maxMemoryMb` | 0 | Enforced on a **Xoft-started** Hermes where RSS is readable (Linux/macOS): over the limit → process stopped, tasks enter recovery. |
| `lowPriority` | true | Xoft-started Hermes runs at reduced OS scheduling priority (the only CPU control implemented — see §17). |
| `nativeToolPolicy` | `monitor` | How Hermes' **own** tools are checked: `monitor` logs violations; `enforce` stops the task; `off`. |
| `workspaceMode` | `in-place` | `in-place` · `branch` · `worktree` (§12). |
| `bridgeEnabled`, `bridgeDeviceId`, `bridgeApprovalWaitMs` | true, auto, 100 s | Tool Gateway (§9). |
| `model`, `provider` | – | Optional per-run model override passed to Hermes. |
| `environment` | {} | Extra env vars for a Xoft-started Hermes. Allow-listed names only (`HERMES_*`, `TERMINAL_*`, proxy, locale). |
| `logLevel` | info | |

Engine-wide: `ENGINES_MAX_CONCURRENT_TASKS` (3), `ENGINES_RESUME_ON_STARTUP` (true), `ENGINES_HEALTH_INTERVAL_MS` (30000), `ENGINES_GIT_SAFETY_NET` (true), `HERMES_BRIDGE_ALLOW_REMOTE` (false).

## 6. Engine registration, capabilities, routing

Registration (`src/index.js`): `engineRegistry.register(engine, { priority })`. A new engine = a class extending `Engine` (§16).

**Capability discovery.** Every engine reports capabilities from `healthCheck()`; for Hermes they are derived from what Hermes *actually* exposes
(`/v1/capabilities`, `/v1/toolsets`) and from the bridge state — e.g. `browser` is claimed only if Hermes has a browser toolset or the bridge is connected
with an online device; `pc_control` only through the bridge. If toolsets cannot be listed, documented defaults are assumed and a note says so.

**Dependency map** (partial availability): `GET /api/engines` →
```json
{ "engine": "hermes", "available": true, "level": "partial",
  "dependencies": { "runtime": true, "api": true, "api_key": true, "model": true, "terminal": true, "filesystem": true, "browser": false, "bridge": null } }
```
`ready` (everything), `partial` (works for tasks that don't need the missing piece), `offline`, `error`, `disabled`.

**Routing** (`TaskAnalyzer` → `EngineRouter`): deterministic, no LLM, works with no AI provider. The analyzer derives required capabilities and whether the goal is
simple / autonomous / long-running; the router keeps only engines that are *capable and currently serveable*, scores them (priority, readiness, engine-specific fit)
and returns an ordered chain with reasons.
* "What is a closure?" → Xoft Core. * "Open my project, find the auth bug, fix it, run the tests" → Hermes (needs a working directory). * Browser goals → an engine with browser capability.
* Preview any decision without running it: `xoft route "<goal>" --dir <path>` / `POST /api/engines/route`.

## 7. Permissions & autonomy

One permission vocabulary, enforced **in Xoft's code**, never by trusting the model:

```
filesystem: read write delete      terminal: execute unsafe      browser: read navigate interact submit_forms
pc: control      memory: read write      network: search      integrations: use   (e-mail, calendar, messaging, media, connectors, unknown tools)
```
Profiles: `observe` (read-only) · `standard` (default: read/write files, run commands, browse; no delete / form submit / PC control / integrations) · `developer` (+delete, +memory write) · `full`.
A task's effective permissions = **requested ∩ engine's configured profile**, cut to read-only at autonomy 0–1. `terminal.unsafe` covers `sudo`, `curl … | sh`, power control, disk-level commands.

Two enforcement paths, honestly different:
1. **Preventive — Xoft's tools via the Tool Gateway.** Checked *before* the call runs (permission, protected paths, writes confined to the task's directories, then Xoft's own approval rules, device grants, emergency stop).
2. **Detective — Hermes' own native tools.** Xoft only sees them as events. On `tool.started` it checks the profile, destructive-command patterns (`rm -rf`, `git reset --hard`, force-push, `DROP TABLE`, …), protected files, and writes outside the working directory.
   With `nativeToolPolicy=enforce` the run is stopped and the task fails with `policy_violation`; with `monitor` it is logged and shown as a warning. *A very fast command can finish before Xoft can stop the run.* If you need a hard guarantee, restrict Hermes' own toolsets (`hermes tools`) so it must use Xoft's tools through the gateway, and/or run Hermes under an OS-level sandbox (container, WSL2, a low-privilege user).

**Autonomy** uses Xoft's existing 0–5 scale: 0 observe · 1 suggest · 2 every action needs approval · 3 low-risk runs, external needs approval · 4 trusted actions run · 5 mission autonomy. For Hermes-raised approvals: level ≥ 4 auto-approves ordinary actions; level ≤ 1 denies; **destructive actions always go to a human at every level**; an approval can never grant something the profile forbids.

## 8. Task execution

```json
{ "goal": "Improve the authentication system", "engine": "hermes", "workingDirectory": "/home/me/app",
  "permissions": "developer", "autonomy": 3 }          // POST /api/engine-tasks  (admin)  → 202
```
States: `queued → initializing → running ⇄ waiting (approval) / paused → completed | failed | cancelled`. Everything is persisted (`engine-tasks` store + `data/engines/events/<id>.jsonl`).

* **Long-running.** Execution is an *engine session*: events stream in (tool started/completed, commands, files, assistant text, approvals), progress is **real** (tool-call counters, current tool/activity, files, commands — no percentage bar), checkpoints are saved every 10 tool calls and at state changes.
* **Working directory** must exist, must not be a credential/system location or your whole home/drive root, and (if configured) must be inside `allowedRoots`. Coding/terminal/file work without a directory cannot be routed to Hermes (the router falls back and says why).
* **Pause / resume.** Hermes has no native pause, so *pause* interrupts the run at Hermes' next safe point and *resume* starts a new run **in the same Hermes session** (the agent keeps its context) with a "continue, don't redo" instruction.
* **Approvals.** Hermes asks → the task goes `waiting`, a Xoft approval is created (it appears on the Approvals page and on the task card) → approve/reject → the decision is delivered to Hermes (`once` / `deny`) and the task continues. Waiting does not consume the time limit.
* **Honest verification.** Success is never taken from the engine's own words. Xoft records which test/build commands were actually observed and whether the last one passed, plus git's own change summary. Result: `verified` · `unverified` ("completed, but no test/build command was observed") · `failed` (a test ran last and failed → the task is marked **failed** even though Hermes said it was done).
* **Limits.** Timeout, tool-call limit, concurrency (global + per engine), retries — all configurable.

## 9. The Tool Gateway (shared tools)

So Hermes does not need duplicate file/browser/device tools, Xoft serves its `ToolRegistry` to Hermes as an MCP server at `POST /engine-bridge/mcp`
(Streamable HTTP, JSON responses, stateless). Hermes then sees tools like `mcp_xoft_file_read`, `mcp_xoft_browser_navigate`, `mcp_xoft_device_screen_click` …

Hermes config (`~/.hermes/config.yaml`) — Xoft shows it and can write it for you if the file has no `mcp_servers` yet (`xoft engine bridge --apply`, backs up first):
```yaml
mcp_servers:
  xoft:
    url: "http://127.0.0.1:3000/engine-bridge/mcp"
    headers:
      Authorization: "Bearer ${XOFT_TOOL_TOKEN}"
```
and `XOFT_TOOL_TOKEN` in Hermes' environment (`xoft engine bridge --show-token`; a Xoft-started Hermes receives it automatically).

* **Safety:** random token (0600), constant-time compare, **loopback only** (unless `HERMES_BRIDGE_ALLOW_REMOTE=true`), rate-limited; engine-layer tools are never exposed (no recursive delegation); results are secret-redacted.
* **Which task?** The tool schemas include a `task_id` property and Hermes is told its id; the gateway applies *that task's* profile. If it is missing and exactly one task is active, that task is used; if several are active the **intersection** (most restrictive) applies; with none active, calls are refused.
  Residual risk: with several concurrent Hermes tasks a misbehaving agent could quote a sibling's id. Keep `maxConcurrentTasks: 1` if tasks have different trust levels.
* **Approvals** use Xoft's real rules (`ApprovalSystem.decide()`): the call waits up to `bridgeApprovalWaitMs` for a human; if nobody answers it returns "waiting for approval — retry", and the retry executes **exactly once** after approval.
* **Browser / PC control:** Hermes can use Xoft's CDP browser and paired-device tools (screen, keyboard, mouse, apps) through the gateway, under Xoft's device grants. Hermes' *own* computer-use toolset is not integrated.
* `connected` in the UI means "a client has talked to the gateway since Xoft started"; the `bridge` dependency is `?` until then.

## 10. Fallback

* Hermes not installed / not running / wrong key / no model / disabled → its health is `offline`/`error`/`partial`; the router **skips it**, the UI shows *Offline · reason · Fallback: Xoft Core*.
* You asked for Hermes explicitly → the task runs on the next compatible engine, with `fallbackFrom: hermes` and the reason on the task; with `allowFallback:false` you get a clear 503 instead.
* Hermes fails **before doing any work** (cannot connect, start rejected) → the same task moves to the next engine automatically. After work has started Xoft does **not** silently re-run it elsewhere (that could repeat side effects) — it recovers (§11) or pauses.
* Nothing available at all (e.g. no AI provider *and* no Hermes) → `503` listing, per engine, why it cannot run the task.
* One broken engine never affects others: health checks are isolated and time-boxed; a throwing/hanging engine becomes an `error` record. `Watchdog` reports engines as DEGRADED at worst, never CRITICAL.

## 11. Failure recovery

| Situation | What happens |
|---|---|
| Hermes crashes / connection drops mid-run | State saved → task `paused` ("recovery attempt n/m") → wait (exp. back-off) → restart a **Xoft-managed** Hermes if needed → re-attach to the run, or (run gone/interrupted) start a continuation run **in the same session**. Progress made before the crash is kept. |
| Recovery retries exhausted | Task stays `paused` with the reason recorded (audit log + task) — **never silently lost**. Resume from the UI/CLI when Hermes is back. |
| Xoft restarts | Unfinished tasks are paused with a reason, then automatically re-attached (if a run exists) or restarted (if none) — `ENGINES_RESUME_ON_STARTUP`. A run still alive on Hermes is **re-attached, not duplicated**. |
| Xoft shuts down cleanly | Running tasks are detached as `paused`; Hermes runs are *not* stopped (unless Xoft started that Hermes). |
| Duplicate start after a network blip | `POST /v1/runs` carries an `Idempotency-Key` (`xoft:<task>:<generation>`), so a retried start returns the original run. |
| Emergency stop | Cancels active engine tasks; new ones are refused. |

## 12. Git safety net

Before an agent edits a repository (`ENGINES_GIT_SAFETY_NET=true`): `in-place` records HEAD and creates a backup ref `refs/xoft/backup/<task>` (a snapshot of the working tree via `git stash create` — your tree, index and stash list are untouched);
`branch` switches to `xoft/task-<id>` (only on a clean tree, otherwise it says so and works in place); `worktree` gives the agent an isolated checkout. After the run Xoft stores git's own change summary and a patch (`data/engines/patches/<id>.patch`).
**Rollback never destroys work:** in-place rollback (only if the tree was clean at start) *stashes* the changes; if you had uncommitted work it refuses and tells you where the snapshot is; worktree rollback removes the worktree but keeps the branch. Untracked files are not captured by the backup ref.
Not a git repo → no safety net, and the task says so.

## 13. Security

* Hermes is treated as a powerful, **untrusted-by-default** executor: scoped working directory, profile ceiling, central policy, approvals, protected-path rules (`.env`, SSH/cloud keys, browser profiles, `.hermes`, system dirs).
* **Secrets:** Xoft's own provider keys are *not* given to a Xoft-started Hermes (minimal allow-listed environment); the Hermes API key and bridge token are generated with `crypto.randomBytes`, stored `0600`, never returned by any API, never logged; every event, log line, result and activity entry is passed through secret redaction (API keys, tokens, JWTs, private keys, `password=…`) **before** it is written. Redaction is heuristic — a safety net, not a guarantee.
* **Network:** a Xoft-started Hermes binds loopback only; the gateway is loopback + token. Remote setups are opt-in and your responsibility (TLS, firewall).
* **API:** creating/controlling engine tasks, settings, process control and bridge operations require an **admin** key (same guard as other sensitive routes). The AI-facing `engine_run_task` tool is EXTERNAL-risk (needs approval at default autonomy) and can only name a profile, never craft permissions.
* **Residual risks:** native Hermes tools are monitored, not intercepted (§7); an agent with `terminal.execute` can run any ordinary command inside your account — use `observe`/`standard`, `allowedRoots`, git worktrees, and an OS sandbox for untrusted work.

## 14. CLI, API, UI, events

**CLI** (`npm run xoft -- …`, or `xoft` after `npm link`): `engines`, `engine status|start|stop|detect|install|bridge|settings`, `route "<goal>"`, `task run|list|status|stop|pause|resume|logs [--follow]|report|rollback|approve|reject`. Needs `XOFT_URL` and an admin `XOFT_API_KEY`.

**API:** see README §12 / `src/engines/engineApi.js`. **UI:** *Planning → Engines* — engine cards (Online/Offline/Starting/Busy/Error/Disabled, dependencies, capabilities, fallback), new-task form with routing preview, live task cards (current activity, tools, files, commands, approvals, Pause/Stop/Resume/Logs/Report/Roll back), Hermes settings.

**Events** (EventBus, `engine.*`; also on the WebSocket): `engine.started|ready|offline|error|status|fallback`, `engine.task.created|started|progress|waiting|paused|resumed|completed|failed|cancelled|state|checkpoint|recovery`,
`engine.tool.started|completed|failed`, `engine.command.executed`, `engine.file.created|modified|deleted`, `engine.approval.requested|resolved`, `engine.policy.violation`, `engine.message`. Lifecycle events are audited in the Activity log; high-frequency ones go to the task's own event log instead (a whole-file JSON rewrite per tool call would not scale).

## 15. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Hermes `offline`: "not installed … or its API server is not running" | `npm run xoft -- engine detect`. Install (§4), or start `hermes gateway` with `API_SERVER_ENABLED=true`. |
| `error`: "HERMES_API_KEY is not set" / "rejected the API key" | Set `HERMES_API_KEY` to Hermes' `API_SERVER_KEY` (or let Xoft start Hermes). |
| `partial`: "no model provider is configured in Hermes" | `hermes setup` / `hermes doctor`. |
| Task went to Xoft Core though I asked for Hermes | Open the task: `routing.reason` says why (offline, missing capability, or **no working directory** for coding work). |
| "workingDirectory is too broad" / "outside the allowed directories" | Choose a project folder; adjust `allowedRoots`. |
| Task `failed: policy_violation` | Hermes ran something the profile forbids (see the task's events). Use a wider profile *deliberately*, or keep it. |
| Task `failed: verification_failed` | The last test command failed. The engine's summary is kept in the result. |
| Task `paused: Recovery failed…` | Hermes is down. Fix it, then **Resume**. |
| Approval shown in Xoft but Hermes does not continue | Possible field-name mismatch with your Hermes version (§1). Check `task logs --json`. |
| Bridge shows "no client has connected yet" | Add the `mcp_servers` entry, export `XOFT_TOOL_TOKEN`, **restart Hermes** (it loads MCP servers at start-up). |
| `hermes` not found on Windows | Pass the full path in `runtimePath`; `.cmd` shims are supported. |
| Memory-limit stop loops | Raise `maxMemoryMb` or set 0; each stop consumes a recovery retry. |

## 16. Development guide

Add an engine: extend `Engine` (`src/engines/Engine.js`), set `id/name/capabilities`, implement `healthCheck()` (never throw; return `{available, level, dependencies, reason, capabilities}`) and `execute(task, ctx)` → `{status:'completed'|'failed'|'cancelled', output?, summary?, error?}`,
reporting progress with `ctx.onEvent({type: EngineEvent.TOOL_STARTED, tool, preview})` etc., honouring `ctx.signal`. Override `taskPolicy()` (limits, profile ceiling), `canServe()`/`routingWeight()` (routing), and `cancel/pause/resume/recover/resolveApproval` where supported (unsupported operations throw `NOT_SUPPORTED`; the manager reports it).
Register it in `src/index.js`. Throw `EngineError(UNAVAILABLE, …, {retryable:true})` for "cannot reach me" — that is what triggers fallback/recovery.
Tests: use `test/_fakeHermes.js` as a model for faking an engine's API; `test/engineTaskManager.test.js` shows a scripted engine.
Files: `src/engines/{constants,Engine,EngineRegistry,TaskAnalyzer,EngineRouter,EngineTaskStore,EngineTaskManager,EnginePermissions,GitWorkspace,ToolGateway,XoftCoreEngine,engineApi,redact}.js`, `src/engines/hermes/*`, `src/tools/builtins/engineTools.js`, `public/js/views/engines.js`, `scripts/xoft.mjs`.

## 17. Known limits

* Native Hermes tools are **monitored, not intercepted** (§7). Pause is "interrupt + continue in session". CPU limits: only OS priority is applied; there is no cgroup/job-object limit. Memory limit: Linux/macOS, Xoft-started Hermes only.
* The tool-call counter counts what Hermes reports; bridged calls are counted once (from Hermes' stream).
* One Xoft user model: any admin key can control any engine task.
* Hermes' own computer-use is not wired in; PC control goes through Xoft's device layer via the gateway.
* Hermes working-directory confinement is by instruction + monitoring, not a chroot.
* Verification: in this repository's build sandbox `npm ci` could not reach the registry, so 27 older tests that need `express` could not run there (they were failing identically before these changes and are unrelated); run `npm test` locally for the full suite.
