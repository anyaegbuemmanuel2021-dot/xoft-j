# XOFT Core v0.10.0 Deployment Gate

This gate describes what is implemented in the source package and what still
requires credentials, hardware, or an external runtime to verify.

## Source-level implementation completed

- Core orchestration, planning, reasoning, approvals, permissions, recovery,
  verification, idempotency, task timeout, autonomy, workflows, automation,
  proactive assistance, memory, provider routing, realtime, device security,
  PC-agent integration, web/PWA foundation, and notifications.
- Ambiguous EXTERNAL/HIGH_IMPACT execution requires fresh approval before a
  retry after a dangling/running execution record.
- WhatsApp Cloud API adapter with signed webhook verification and shared-Core
  inbound/outbound channel flow.
- Twilio voice adapter with signed webhook validation, speech-to-Core routing,
  TwiML responses, and call status handling.
- ChannelGateway is the common entry point for web, WhatsApp and telephony.
- SQLite-backed persistence is available for the major state stores,
  including vector memory; JSON remains the explicit fallback when
  STORAGE_MODE=json.
- Docker, Compose, CI and Android companion build configuration are included.

## Verification completed in this build environment

- JavaScript syntax validation: passed for source, tests and scripts.
- Archive extraction and source inspection: passed.

## Verification that must be performed with external infrastructure

- `npm ci` / full test suite requires a working npm registry or populated cache.
- Live AI provider calls require provider credentials.
- Live WhatsApp requires a Meta WhatsApp Business/Cloud API account, verified
  number and public HTTPS webhook.
- Live phone calls require a Twilio account, telephone number and public HTTPS
  webhook endpoints.
- Real Android device/emulator testing requires an Android environment/device.
- Real Windows/Linux PC-agent testing requires the target machine.
- Docker runtime verification requires Docker/Compose.
- Public production deployment additionally requires HTTPS/TLS, backups,
  monitoring and secret management.

These external conditions are not falsely marked as complete merely because
adapter or configuration code exists.
