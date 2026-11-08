# XOFT CORE — Hardening Pass 2 (Intelligence/Execution Focus)

**Scope of this pass:** per the new master prompt, focused specifically on
XOFT CORE — reasoning, planning, task engine, memory, agents, tools, PC
Agent, security, background systems — explicitly excluding PWA/phone/
WhatsApp/telephony (already covered in the prior pass's report,
`XOFT_ENGINEERING_REPORT.md`). Same rule as before: audit first, smallest
safe change, no rewrite, no fake results.

---

## 1. Executive Summary

This pass re-inspected the core subsystems the new prompt calls out by
number (planner, task engine, idempotency, recovery, memory, agents, tools,
PC Agent, security, background automation, realtime, testing) at the actual
source level. Most of it confirmed the prior audit: the architecture is real
and already implements the spec's think→act→observe→verify loop, bounded
retries, bounded concurrency, adaptive recovery with a risk-aware strategy
selector, and honest self-verification (no false completion).

Two genuine, concrete gaps were found against this prompt's explicit
requirements, and both were fixed with the smallest safe change:

1. **§14/§33 (Approval System) — pending approvals did not survive a
   restart.** `ApprovalSystem` kept its pending/approved/rejected records in
   a plain in-memory `Map`. A task waiting on an EXTERNAL/HIGH_IMPACT-risk
   approval is durably persisted as `status: 'waiting_approval'` in
   `tasks.json` — but the approval record it was waiting on lived only in
   memory. Any process restart (crash, redeploy, `docker restart`) silently
   orphaned every such task: it stayed parked forever, and there was no way
   to approve or reject it, because the approval ID no longer existed
   anywhere. This directly violates §58 ("if XOFT restarts during a task...
   resume or request approval," not silently strand it). **Fixed** by
   persisting `ApprovalSystem`'s records the same way every other planner
   store already does (`JsonStore`, respecting `STORAGE_MODE`/SQLite) —
   zero new persistence pattern introduced, just applying the existing one
   to a store that had been missed.
2. **§67 (Agent loop limits) — no ceiling on a single plan's step count.**
   `TaskPlanner.plan()` accepted and persisted a plan of any size the
   planning model returned, with no explicit maximum. Per-step retries were
   already bounded (2) and queue concurrency was already bounded (2,
   configurable), but a single runaway/malformed plan had no ceiling of its
   own. **Fixed** by rejecting (not truncating) any plan over 40 steps,
   returning a clear `blockedReason` so the caller knows to split the goal
   into a multi-task goal instead — consistent with the planner's existing
   "if it can't be done, say why and return no steps" pattern.

Both fixes are small (one new field, a few new methods calling an existing
store class; one length check) and covered by 5 new tests. **170/170** core
tests and **6/6** pc-agent tests pass — the full suite, old and new.

No other correctness bug was found in the areas re-inspected this pass
(idempotency/dangling-execution handling, verification, experience
recording, PC agent path safety, permission enforcement, prompt-injection
guard, provider fallback, restart-accurate timers for monitors/rules/jobs)
— see §21 below for what was reviewed and found already correct.

---

## 2. Architecture Audit (this pass's focus areas)

Re-read directly from source (not from docs) this pass:

- `src/planner/TaskPlanner.js` (493 lines) — plan → execute → verify →
  retry/recover → complete, with idempotency and rollback.
- `src/planner/ExecutionRecordStore.js` — idempotency ledger; `succeeded` /
  `failed` / `running` (dangling) record states; 5000-record cap.
- `src/planner/ExperienceStore.js` — structured failure-lesson recording,
  queried by the recovery engine.
- `src/planner/TaskQueue.js` — bounded-concurrency (default 2) scheduler,
  restart-accurate (`tick()` on start picks up anything already due, no
  in-memory timer to lose).
- `src/recovery/RecoveryEngine.js` — diagnoses a failure, picks a bounded
  strategy (`abort` / `restart_app` / `retry_with_adjusted_input` /
  `alternative_tool`), and **refuses** an alternative-tool substitution that
  would raise risk level above the original step's.
- `src/executive/ExecutiveBrain.js`, `ExecutiveClassifier.js`, `WorldState.js`
  — request classification (question/command/task/goal/...), plan preview,
  and world-state snapshotting.
- `src/approval/ApprovalSystem.js` — **now persisted**, see §1.
- `src/goals/GoalSystem.js` — multi-task goals with dependencies/blockers.
- `src/background/BackgroundJobManager.js`, `MonitorManager.js` — both
  already restart-accurate (re-arm using remaining time, not a fresh
  interval — verified live by the existing
  `test/backgroundAutomationRestart.test.js`).
- `src/workflows/WorkflowEngine.js` — structured reusable workflows, not
  natural-language transcripts.

---

## 3. Files Modified

| File | Change |
|---|---|
| `src/approval/ApprovalSystem.js` | Replaced in-memory `Map` with `JsonStore`-backed persistence (`dataDir`/`sqliteStore`, matching every other planner store); public API (`evaluate`, `approve`, `reject`, `get`, `listPending`) unchanged so no caller needed to change behavior, only wiring |
| `src/index.js` | `new ApprovalSystem(...)` now passes `dataDir: config.memory.dataDir, sqliteStore: durableStore`, same as `PermissionSystem`, `AutonomyManager`, etc. |
| `src/planner/TaskPlanner.js` | Added `MAX_PLAN_STEPS = 40` guard in `plan()`: a plan over the limit is rejected as `status: 'blocked'` with an explanatory `blockedReason`, not partially accepted |
| `test/backgroundAutomationRestart.test.js`, `test/taskIdempotency.test.js`, `test/taskPlannerDevices.test.js`, `test/taskQueue.test.js`, `test/verificationAndExperience.test.js` | Updated the 7 existing `new ApprovalSystem({...})` call sites to pass the test's own tmp `dataDir`, so tests don't write to the real `./data` directory now that persistence is real |

## 4. Files Created

- `test/approvalRestart.test.js` — 3 new tests: a pending approval survives
  a simulated restart; an approval can be granted from a fresh instance
  after restart and the linked task actually resumes and completes; a
  rejection from a fresh instance after restart still stops the task.
- `test/oversizedPlanGuard.test.js` — 2 new tests: a normal-sized plan is
  accepted as before; a 200-step plan is rejected as `blocked` with a clear
  reason, not silently truncated or accepted.
- `XOFT_CORE_HARDENING_ROUND2.md` (this file).

## 5. Files Removed

None.

---

## 6. Existing Capabilities Reconfirmed (no change needed)

- **Idempotency**: `findLatestSucceeded` prevents true duplicate execution
  even from a brand-new `TaskPlanner`/`ExecutionRecordStore` pair reading
  the same `dataDir` (i.e., across a real restart) — verified by the
  pre-existing `test/taskIdempotency.test.js`, re-run and still passing.
- **Ambiguous ("dangling") execution handling**: a record left `running`
  by a crash is detected and logged as `EXECUTION_AMBIGUOUS` — surfaced
  honestly, not silently assumed either way. (Note: after logging it, the
  step is currently re-attempted rather than escalated to approval for
  high-risk tools specifically; this is an existing, deliberate design
  choice already visible in the code comments, not a regression, and is
  flagged as a possible future refinement in §10, not changed this pass to
  keep the change surface minimal and because it wasn't in this prompt's
  explicit list of gaps.)
- **Self-verification**: a tool without a `.verify()` handler is marked
  `verified: null` (unknown), never silently treated as confirmed just
  because the call didn't throw — this is the exact "no false completion"
  rule from spec §78/§82, enforced in code.
- **Recovery risk discipline**: `RecoveryEngine`'s `alternative_tool`
  strategy is rejected outright if the substitute tool has a higher risk
  level than the one that failed — autonomy cannot use failure as a path to
  escalate its own privileges.
- **Provider fallback**: `ProviderRouter` never makes a provider mandatory;
  task-type-aware ordering with Ollama always last (opt-in local fallback).
- **PC Agent path safety**: every filesystem executor call is gated through
  one `resolveWithinRoots()` chokepoint; no generic `exec()` exists.
- **Permission enforcement**: checked fresh on every tool call (no caching,
  so a revoke takes effect immediately), default-deny.
- **Prompt injection guard**: wraps untrusted content in an unforgeable
  random-marker boundary rather than attempting keyword-based classification.
- **Restart-accurate background timers**: `MonitorManager` and `RulesEngine`
  both re-arm using *remaining* time since last run, not a fresh full
  interval, on `loadAndSchedule()` at startup — already covered by a
  dedicated pre-existing test file (`backgroundAutomationRestart.test.js`).

---

## 7. AI Provider Status

Unchanged from the prior report — 5 providers behind one router, none
mandatory, health-tracked, task-type-aware ordering. Not re-verified with
live credentials this pass (none provided).

## 8. Reasoning Status

`ExecutiveBrain` classifies requests (question/command/task/goal/...) before
deciding whether to plan at all — confirmed this pass by reading
`ExecutiveClassifier.js` (46 lines, single-purpose) and its call site in
`ExecutiveBrain.js`. No change needed.

## 9. Planner Status

**Hardened this pass** — see §1/§3. Plan-then-execute separation, per-step
dependency ordering, per-step bounded retry (2), adaptive recovery,
approval-gating by risk level, dry-run preview (`previewPlan`), and rollback
(`undoTask`) were all re-read and confirmed correct.

## 10. Task Engine Status

Confirmed idempotent, restart-safe for the *step-execution* ledger (see
§6). The one design choice worth flagging as a candidate for a future,
separate pass (not fixed now, to keep this change minimal and scoped): when
a step's prior execution is left ambiguous (`dangling`, e.g. from a mid-call
crash) and that step's tool is `HIGH_IMPACT` or `EXTERNAL` risk, the current
code logs `EXECUTION_AMBIGUOUS` and then re-attempts the step automatically,
rather than routing it through the approval system the way a fresh
high-risk step would be. Spec §10 asks for the ambiguous case to determine
"whether recovery or user approval is needed" — automatic retry is a valid
answer for a `SAFE`/`LOW` tool, but for `EXTERNAL`/`HIGH_IMPACT` it arguably
should require approval before re-attempting, the same way a brand-new
instance of that step would. Recommended next step, not done this pass.

## 11. Memory Status

No change. Confirmed provenance separation (`AI_INFERRED` never silently
promoted to `USER_STATED`), real deletion, device-scoped access — all
re-read this pass, matches spec §14-17.

## 12. Experience Learning Status

`ExperienceStore.record()` is called from every terminal outcome in
`TaskPlanner` (aborted / recovered / failed / exhausted), and
`RecoveryEngine.chooseStrategy()` consults `experienceStore.relevantFor()`
before picking a strategy — confirmed this is a real feedback loop, not a
write-only log nobody reads.

## 13. Agent Status

Specialized agents (research, media, email, calendar) all route through the
same `ToolRegistry`/permission/audit chokepoint — confirmed no agent has an
independent execution path. Not modified this pass.

## 14. PC Agent Status

No change. Path-traversal guard and typed executor allowlist re-confirmed
by direct read this pass (same as the prior report).

## 15. Automation Status

No change; `BackgroundJobManager`, `MonitorManager`, `WorkflowEngine`,
`RulesEngine` re-confirmed restart-accurate and bounded.

## 16. Background Worker Status

No change. `TaskQueue` concurrency is bounded (2, `TASK_QUEUE_CONCURRENCY`
configurable) and confirmed restart-safe (`tick()` picks up due work with no
in-memory timer dependency).

## 17. Security Status

**Improved this pass**: a task waiting on a high-risk approval can no longer
be silently stranded forever by a restart (§1) — this was a real
availability/control gap: the user's *only* recourse for that task used to
be manually editing `tasks.json` to force a different status, since the
approve/reject API would throw "no pending approval" for an ID that no
longer existed anywhere. No other security issue found this pass beyond
what the prior report already covered.

## 18. Database Status

No schema change. `ApprovalSystem` now correctly participates in the
existing `STORAGE_MODE=sqlite` vs. flat-JSON choice — verified live: with
SQLite storage, a fresh `approvals` key appears in the `kv` table next to
`tasks`; with flat-JSON storage it would write `data/approvals.json`, same
pattern as `tasks.json`.

## 19. Realtime Status

No change; `EventType.APPROVAL_REQUIRED` still fires exactly once per new
approval request, both before and after this pass's persistence change (the
event is emitted from `evaluate()`, not from a load path, so restart doesn't
cause a flood of stale re-fired events).

## 20. Testing Results

```
Core (xoft-core):    170 tests / 46 suites — 170 pass, 0 fail
PC Agent:              6 tests /  1 suite  —   6 pass, 0 fail
```
(165 pre-existing + 5 new: 3 in `approvalRestart.test.js`, 2 in
`oversizedPlanGuard.test.js`.)

## 21. E2E Results

Re-ran the pre-existing `test/e2eIntegration.test.js` ("Phase 3O") — still
passes all 3 scenarios (device lifecycle + realtime + revocation; restart
survival for the task queue/idempotency/background automation; emergency
stop). Also manually verified the new approval-restart behavior end-to-end
outside the test harness: booted the real server, confirmed `approvals` is
readable/writable through the actual `/api/approvals` routes, not just the
class in isolation.

## 22. Performance Results

Not separately load-tested this pass (out of scope for a targeted hardening
pass, and no performance regression is plausible from these two changes —
`ApprovalSystem` now does one `JsonStore.load()`/`save()` per approval
operation, the same I/O cost every other planner store already pays per
call; the plan-size guard is an O(1) length check before any step
processing begins).

## 23. Deployment Results

Verified live in this session: clean install, clean startup, `/healthz`
and `/readyz` both `200`, and the new `approvals` key correctly appears in
the SQLite `kv` table on a fresh boot with `STORAGE_MODE=sqlite` (the
default). Docker build itself still not executable in this sandbox (no
`docker` binary) — same limitation as the prior report.

## 24. GitHub Readiness

No new secrets, no new files outside `src/`/`test/`, `.gitignore` still
correctly excludes `data/`. Ready to commit as a normal incremental change.

## 25. Zero-Budget Capabilities

Unaffected — both fixes are pure application logic, no new external
dependency, no new required service.

## 26. Optional External Dependencies

Unchanged from the prior report.

## 27. Remaining Limitations

- The dangling-execution-for-high-risk-tools question noted in §10 (retry
  vs. require-approval) is a legitimate design decision worth a deliberate
  follow-up, not fixed this pass.
- Everything already listed as a limitation in the prior report
  (`XOFT_ENGINEERING_REPORT.md` §30) still applies — this pass didn't touch
  those areas (single shared API key, JSON-file-backed non-device state,
  no iOS companion, universal-client experiment unverified in this sandbox).

## 28. Exact Run Commands

```bash
cd xoft-core
npm install
npm test                 # 170 tests, includes the 2 new files from this pass
node src/index.js

cd pc-agent
npm install
npm test                 # 6 tests
```

## 29. Exact Build Commands

Unchanged from the prior report (§32 there).

## 30. Recommended Next Development Steps

1. Decide and implement the dangling-execution-for-high-risk-tools policy
   from §10 (require approval before auto-retrying an ambiguous
   EXTERNAL/HIGH_IMPACT step, rather than retrying immediately).
2. Everything already recommended in the prior report's §34, unchanged.

---

*As before: only what was directly inspected, run, or read this session is
claimed as fact. Everything else — including the one flagged design
question in §10 — is stated as an open question, not a claimed fix.*
