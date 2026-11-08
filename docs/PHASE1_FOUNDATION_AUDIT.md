# XOFT-J Phase 1 — Source-Based Foundation Audit

Audit date: 2026-11-08  
Repository: `anyaegbuemmanuel2021-dot/xoft-j`  
Audited branch baseline: `abb20a5a652a0a4659fd72e0c724db74258be778`  
Scope: Phase 1 foundation, hosting, persistence, task execution, Hermes integration and safety.

This audit is based on source files fetched from the repository, not commit titles or feature-status claims. Runtime behavior and the full test suite have not yet been independently executed in a local checkout.

## SWOT

### Strengths
- The server composes distinct subsystems for planning, task queues, execution engines, approvals, permissions, memory, recovery and monitoring. The project is not starting from a blank chatbot.
- `TaskQueue` persists queue state through `TaskPlanner` task records and has bounded concurrency, bounded pending capacity, scheduled execution and startup recovery.
- `TaskPlanner` validates model-generated step graphs (known tools, unique IDs, object inputs, valid dependencies and cycle rejection), orders dependencies, bounds plan length and retries.
- `EngineTaskManager` centralizes engine routing, permission/autonomy checks, cancellation, progress persistence, recovery and verification rather than delegating those responsibilities to Hermes.
- `HermesEngine` is an optional adapter behind the engine interface. XOFT Core remains registered as a fallback; Hermes-specific code is isolated under `src/engines/hermes/`.
- `PermissionSystem` checks current grants at execution time, supports namespace grants and expiry, and logs grants/revocations.
- `/readyz` already distinguishes a configured, mounted persistent data root from ephemeral container storage. `storageReadiness.js` checks actual Linux mount information rather than trusting an environment variable alone.

### Weaknesses
- `src/index.js` is a very large composition root. It constructs most services, routes, monitors, background workers and shutdown behavior in one file, increasing change risk and making lifecycle tests harder.
- Persistence is split across SQLite-backed and JSON/file-backed stores. A persistent SQLite path alone does not prove that every file-backed store (activity log, settings, secrets, task JSON where used) is on the same durable volume.
- The Docker image defaults to SQLite at `/app/data/xoft.sqlite`. On Render Free, the filesystem is ephemeral and there is no persistent disk; the service can run while durable memory/settings are not guaranteed.
- The readiness endpoint reports persistence durability as data, but currently responds HTTP 200 even when persistence is not durable. Monitoring must therefore inspect `persistence.durable`, not only the HTTP status.
- The default Hermes URL is loopback (`127.0.0.1:8642`). A separately hosted Hermes process cannot be reached until the Hermes URL and matching secret are configured. The repository adapter does not itself provide an always-on remote Hermes host.
- Documentation describes substantial capabilities, but documentation and mocks do not establish that real Hermes execution, remote networking, provider credentials, or production recovery have been exercised.

### Opportunities
- Keep the current architecture and close operational gaps incrementally: durable storage, backups, runtime health evidence, engine integration checks and end-to-end recovery tests.
- Make the storage contract explicit: all persistent stores must resolve beneath one configured data root, and deployment checks should clearly distinguish service liveness from data durability.
- Add a repeatable harmless Hermes acceptance test and a destructive-action approval/cancellation test against a real configured Hermes endpoint.
- Split the server composition root into lifecycle modules only where it materially improves testability; avoid a wholesale rewrite.
- Add a release gate that runs the complete Node test suite, dependency audit, container smoke test and relevant mobile/desktop checks before production deployment.

### Threats
- Render Free restarts, sleeps and redeploys can discard local data. This is a data-loss risk, not merely a performance limitation.
- A remote Hermes endpoint introduces a network boundary and secret-management requirement. Exposing it publicly without TLS, strong authentication and XOFT-side permission enforcement would be unsafe.
- Running two task execution systems (the core planner queue and the pluggable engine manager) creates a risk of inconsistent user expectations unless UI/API status clearly identifies which engine owns a task.
- Provider outages, rate limits and missing credentials can make an otherwise healthy XOFT process unable to complete AI-dependent work.
- Broad autonomous permissions or a failed cancellation/approval boundary could turn a coding task into unintended filesystem or terminal side effects.

## Phase 1 implementation priorities

### P0 — Deployment truth and data safety
1. Keep `/healthz` as process liveness; treat `/readyz` persistence fields as the authoritative durability signal.
2. On the current Render Free service, do not promise durable memory or settings. A persistent disk requires a paid Render plan; no paid resource should be provisioned without the owner's explicit approval.
3. Before any storage-path change, enumerate every JSON/file store and confirm it resolves under the persistent data root. Do not assume that moving SQLite alone moves all state.
4. Define and document a backup/restore procedure before enabling long-term user data.

### P1 — Execution and recovery proof
1. Exercise core planner task creation, queued execution, timeout, retry and restart recovery.
2. Exercise engine task creation, cancellation, interrupted-task recovery and result verification.
3. Confirm ambiguous side effects are held for approval rather than blindly replayed.
4. Test that activity-log/event-bus failures cannot stop task execution (recent queue hardening should be retained).

### P2 — Hermes connection
1. Determine whether Hermes is installed and runnable in the existing hosting environment; do not assume it is.
2. If it is a separate service, configure an HTTPS remote endpoint and secret out of band; never commit credentials.
3. Verify authenticated health/capabilities, one harmless file task, an approval-gated destructive action and cancellation.
4. Preserve XOFT Core fallback when Hermes is unavailable.

### P3 — Maintainability and release confidence
1. Add integration tests at public API seams for readiness, task recovery and engine safety.
2. Extract lifecycle concerns from `src/index.js` in small, test-backed changes.
3. Run the repository's declared test and build commands from a clean checkout and record exact results.

## Evidence inspected

- `src/index.js`: service composition, SQLite initialization, task queue startup, engine registration, `/healthz`, `/readyz`, Hermes initialization and shutdown.
- `src/planner/TaskQueue.js`: bounded queue, scheduling and startup recovery.
- `src/planner/TaskPlanner.js`: plan graph validation, dependency ordering, retry and task persistence.
- `src/engines/EngineTaskManager.js`: centralized engine task execution and safety boundary.
- `src/engines/hermes/HermesEngine.js` and `HermesRuntime.js`: optional HTTP adapter, managed process/runtime and environment detection.
- `src/persistence/SqliteStore.js` and `storageReadiness.js`: SQLite setup and mounted-filesystem checks.
- `src/config/index.js`: storage roots, engine concurrency and Hermes-related runtime configuration.
- `src/security/PermissionSystem.js`: live permission checks, expiry and audit logging.
- `docs/SETUP_AND_HOSTING.md`: Render Free ephemeral-storage warning and paid-disk configuration.

## Verification status

- Source inspection: performed for the files listed above.
- Full test suite: not run in this audit session.
- Production behavior: not claimed as verified.
- Render persistent disk / remote Hermes service: not provisioned.
