# XOFT Implementation Status — 2026-09-27

This release implements the highest-value gaps identified in the consolidated
source audit without replacing the existing architecture.

## Implemented in this pass

- Task wall-clock timeout via `TASK_MAX_DURATION_MS` (15 minutes default).
- Ambiguous execution hardening: dangling EXTERNAL/HIGH_IMPACT actions require
  a fresh explicit approval before retry; approved ambiguity can resume once.
- Official WhatsApp Cloud API adapter, signed webhook verification, inbound
  text -> ExecutiveBrain -> outbound response path.
- Twilio REST call adapter, signed voice/status webhooks, speech -> Core ->
  TwiML response loop.
- Communication tools are now real adapters rather than fake success
  placeholders; without credentials they remain unavailable.
- Additional JSON-backed state stores now transparently use the existing
  SQLite `kv` store when `STORAGE_MODE=sqlite`, including permissions, goals,
  missions, autonomy, background jobs, monitors, rules, workflows, knowledge
  graph, personality, user style, long-term memory, experiences, approvals,
  task state, execution records, and vector memory.
- Configuration and `.env.example` entries for the communication providers
  and task timeout.
- Communication integration documentation.

## Still requires external verification

- Real WhatsApp Business/Cloud API account and verified number.
- Real Twilio account and telephone number.
- Real browser/PWA install, offline and reconnect testing.
- Real Android device/emulator testing.
- Real Windows/Linux PC Agent execution.
- Live AI provider credentials.
- Docker runtime.

Those are intentionally not marked as live just because their adapter code
now exists.

## 2026-09-27 — Experiential Labs multi-model gateway

Added optional `ExperientialProvider` using Experiential Labs' OpenAI-compatible API. XOFT can select an Experiential model at runtime through the authenticated Core API, list the organization-visible catalog, and use the gateway as the first provider when configured. `EXPERIENTIAL_FREE_ONLY=true` is the default safety setting; the selected model is resolved to the gateway's `:free` lane when necessary.

Live Experiential credentials, model availability, regional eligibility, free-tier resets and actual inference were not verified in this source-only implementation pass.
