# XOFT Core v0.9.0 — Merge Notes

Combines the two divergent branches into one superset build.

## Base: xoft-core-godlevel-0.8.1 (newer branch)
Kept as-is:
- ComputerUseEngine — bounded observe/plan/act/verify loop for on-device UI
  control (`device_computer_use`, `device_screen_verify` tools)
- Vision-based screen action planning + outcome verification (VisionInterpreter)
- Adaptive recovery — RecoveryEngine.chooseStrategy() uses the LLM to diagnose
  a failed step and pick a bounded strategy (retry / restart app / adjusted
  input / risk-capped alternative tool / abort), replacing the older
  restart-only recovery
- `verify:deps` / scripts/dependency-doctor.mjs — fails fast with a clear
  message if a runtime dependency isn't actually resolvable, instead of
  discovering it at first request
- Extended device capability union (`computer_use`, `social`) in the shared protocol types

## Merged in from xoft-core-with-device-tokens (older branch)
- **DeviceTokenService** — per-device bearer tokens distinct from the shared
  admin API key. Trusting a device now mints it its own token (returned once,
  hashed at rest); revoking a device revokes its tokens. A `requireOwnDevice`
  guard stops one device's token from touching another device's queue/state.
  This closes a real gap in the 0.8.1 branch, where every paired device used
  the same admin-equivalent shared key.
- **Lazy `node:sqlite` loading** in SqliteStore — the 0.8.1 branch statically
  imported `node:sqlite`, which throws at *import time* (crashing the whole
  process) on any Node runtime/edge build that lacks it. Restored the
  try/require-on-construct pattern so only code paths that actually use
  SQLite are affected, with a clear error pointing at `STORAGE_MODE=json`.
- `device_tokens` table + store methods (issue/verify/revoke) wired into the
  restored lazy loader.

## Verified in this environment
- `npm install` — clean, 71 packages, no vulnerabilities reported
- `npm run verify:deps` — 4/4 runtime deps resolvable
- `node --test` — **52/52 tests passing, 0 failures** (47 pre-existing +
  5 device-token tests carried over)
- `node src/index.js` — boots cleanly on Node 22, listens, no crash;
  expected dev-mode warnings only (no `AUTH_API_KEYS`, no AI provider key)

## Not verified here (needs your machine/keys)
- Live AI provider calls (OpenAI/Gemini/Claude) — no API keys in this sandbox
- Real device agent round-trip for `device_computer_use` — needs an actual
  paired device reporting the `computer_use` capability
- `pnpm` mobile/desktop app builds — pnpm workspaces not exercised here
