# Device Operating Layer — Implementation Map

Written per the master prompt's Phase 1 requirement: what exists, what was
added, what's still a genuine gap, and why. Status vocabulary matches
`docs/FEATURE_COMPARISON.md` (LIVE / READY / CONTRACT ONLY / NOT BUILT).

## What already existed before this pass

- `DeviceRegistry` — file-backed CRUD for device identity (id, name,
  platform, trust, status, heartbeat). LIVE.
- `PermissionSystem` — hierarchical, TTL-aware grant/revoke/check, already
  enforced by `ToolRegistry.execute()`. Already had every device-relevant
  permission string (`apps.launch`, `files.read`, `media.control`, etc.)
  from an earlier pass. LIVE.
- `ToolRegistry` / `Tool` — the single execution chokepoint: emergency-stop
  check, permission check, then the tool's own implementation-status guard.
  Nothing bypasses this. LIVE.
- `ApprovalSystem` / risk levels (SAFE/LOW/EXTERNAL/HIGH_IMPACT) — already
  wired into `TaskPlanner` and the standalone-approval execution path. LIVE.
- `EventBus`, `ActivityLog`, `EmergencyStop` — general-purpose, already used
  by every other subsystem. LIVE.
- `docs/MOBILE_COMPANION_CONTRACT.md` — already correctly identified that a
  native agent is a separate codebase, and defined most of the interface —
  but the actual command-channel API routes did not exist yet.

## What this pass added

| Piece | File | Status |
|---|---|---|
| Device capabilities + state + explicit trust step | `src/devices/DeviceRegistry.js` (extended) | LIVE |
| Online/offline derivation, command queue, idempotency, verified results, device events | `src/devices/DeviceManager.js` (new) | LIVE |
| Allowlisted device capability tools (no shell-exec tool) | `src/tools/builtins/deviceTools.js` (new) | Routing is LIVE; full completion is CONTRACT ONLY until a real agent polls |
| Command channel API (poll for work, report result) | `src/index.js` (new routes) | LIVE |
| Trust/capabilities/state API routes | `src/index.js` (new routes) | LIVE |
| WorldState device awareness | `src/executive/WorldState.js` (extended) | LIVE |
| TaskPlanner device-aware planning (real ids only, never invented) | `src/planner/TaskPlanner.js` (extended) | READY (needs an AI key, same as the rest of TaskPlanner) |
| 17 unit/integration tests covering registration, trust, capability/permission/emergency-stop gating, command lifecycle, timeouts, idempotency, and planner prompt content | `test/*.test.js` (new) | LIVE — `npm test` |

## Design decisions (and why)

- **No second brain, no second command pipeline.** Device actions are
  ordinary `Tool`s that go through the exact same `ToolRegistry` ->
  `ApprovalSystem` -> `TaskPlanner`/`ExecutiveBrain` path as email, calendar,
  or memory tools. `DeviceManager.execute()` is the only new primitive, and
  it's called from inside a tool's `execute()`, not from a parallel router.
  This directly satisfies the "integrate into ExecutiveBrain, don't create a
  second brain" instruction.
- **Discovery != trust, always a separate step.** `registerDevice()` never
  sets `trust: 'trusted'`; only an explicit `POST /api/devices/:id/trust`
  call does. `DeviceManager.execute()` independently re-checks trust,
  online status, and capability on every single command — nothing is
  cached from an earlier check.
- **No general shell-execute tool exists anywhere in this codebase.**
  Every device action is a specific allowlisted `(capability, action)` pair.
  CRITICAL-risk actions (`factory_reset`, `disable_security`, ...) are
  blocked in `DeviceManager.execute()` itself, not just left to convention.
- **Nothing resolves early.** `DeviceManager.execute()` returns a promise
  that only resolves when a real agent calls
  `POST /api/devices/:id/commands/:commandId/result`, or rejects on a real
  timeout. There is no code path that returns `{ success: true }` without
  that POST having happened — verified by the "never resolves early" and
  "times out honestly" tests in `test/deviceManager.test.js`.
- **Idempotent by construction.** A caller can pass `idempotencyKey`; a
  retry against the same key fans out to the *same* queued command instead
  of double-launching an app or double-sending a file transfer.

## What is still a genuine, unresolved gap

This is the honest boundary — nothing below is faked or stubbed to look
more complete than it is:

1. **No native Android or desktop agent exists.** Nothing in this
   repository runs on a phone or a laptop's OS. `docs/MOBILE_COMPANION_CONTRACT.md`
   defines exactly what such an app needs to implement against the now-real
   API; building that app is a separate Kotlin/Swift/Electron/native
   codebase, same conclusion the project had already reached before this
   pass.
2. **Autonomy levels (spec section 14)** — 0 through 4 — are not
   implemented. Every device command today requires the same
   permission+approval gate every other tool uses; there's no separate dial
   for "XOFT can act on my behalf up to risk level N without asking."
3. **Named workflow presets** (Coding Mode, Presentation Mode, Travel Mode,
   Device Health Check) are not built. `WorkflowEngine`/`BackgroundJobManager`
   already exist and device tools can be chained into them exactly like any
   other tool, but no presets have been authored yet.
4. **Keyboard/mouse/screen-interaction capabilities** are referenced in the
   permission catalog (`screen.interact`, `screen.capture`) but no tool
   exposes them yet — this is real-input automation and deserves its own
   careful design pass (coordinate-based automation is fragile and
   ToS-sensitive per the existing companion-app doc's own caution).
5. **Device groups** (spec section 20 — "all my trusted devices") are not
   implemented; `DeviceManager.listDevices()` returns everything and a
   caller/tool would need to filter client-side today.
6. **Voice-to-device** — `VoiceService` and the device layer are not yet
   connected; a voice command today goes through the same `ExecutiveBrain.handle()`
   entry point as text, so device commands would work identically once
   voice input is transcribed into `message` — but this hasn't been
   exercised end-to-end.

## Suggested next slice

If you want to keep going, the highest-leverage next step is almost
certainly **#2 (autonomy levels)** — it's a relatively small, self-contained
addition (a stored per-user setting + a check in `ApprovalSystem.evaluate()`
for device-risk actions) that unlocks a lot of the "JARVIS" feel without
needing a native agent to exist yet, since you can develop and test it
entirely against a mock agent hitting the command-channel API directly
(see `test/deviceManager.test.js` for the pattern).

## Real-time threat detection (added after the initial pass)

`SecurityAgent` (`src/security/SecurityAgent.js`) covers static analysis —
`npm audit`, secret scanning, config hardening — it doesn't watch anything
happen live. `DeviceThreatMonitor` (`src/security/DeviceThreatMonitor.js`)
is the runtime counterpart, specifically for the device layer:

- Watches every `DEVICE_COMMAND_QUEUED` / `DEVICE_COMMAND_FAILED` event as
  it happens (a pure `EventBus` observer — no new instrumentation added to
  `DeviceManager` itself).
- Tracks a per-device sliding window (default 60s) of: total commands,
  failures, and medium/high-risk commands specifically.
- On a threshold breach — a command flood, a run of failures (probing or a
  broken agent), or a burst of elevated-risk actions — it calls
  `deviceManager.quarantineDevice()` **automatically**, dropping the
  device's trust back to `unverified`. `DeviceManager.execute()` re-checks
  trust on every call, so this takes effect immediately, mid-session — not
  after someone happens to notice a log line.
- Every quarantine is still written to `ActivityLog` and emitted as
  `DEVICE_SECURITY_ALERT` — this adds an automatic reaction on top of the
  audit trail, it doesn't replace it. A human reviews and re-trusts the
  device (same `POST /api/devices/:id/trust` endpoint as initial pairing)
  to lift the quarantine.
- `GET /api/devices/:id` now includes `recentActivity` — live counts for
  the current window — so a UI could surface "38 commands in the last
  minute" before a device ever actually trips the threshold.

Default thresholds (40 commands/60s, 8 failures/60s, 12 elevated-risk
actions/60s) are conservative on purpose so normal use doesn't trip them —
tune via the `thresholds` option passed to `DeviceThreatMonitor` in
`src/index.js` if your usage is legitimately bursty. Covered by
`test/deviceThreatMonitor.test.js`.
