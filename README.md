# XOFT AI Core 2

A modular, cross-device personal AI assistant inspired by futuristic assistants, built around the existing XOFT AI Core rather than a blind rewrite.

> Status: integration foundation / work in progress. This repository does not yet claim that every integration below is implemented. See the roadmap and environment setup.

## Product goals

- Responsive web UI for phone, tablet, and desktop.
- Chat with configurable AI providers (OpenAI and Anthropic/Claude first; Gemini optional).
- Persistent conversations and user-controlled memory.
- Voice input/output, with browser/device capability detection.
- Tool/agent orchestration for research, writing, and approved tasks.
- Plugin/integration architecture.
- WhatsApp, email, calendar, and browser automation adapters, enabled only after credentials and permissions are configured.
- Approval queue, activity log, emergency stop, and least-privilege device access.

## Architecture direction

Keep the existing XOFT Core server as the source of truth and integrate features behind stable interfaces:

```
Responsive Web UI
   | HTTPS / authenticated API
XOFT Core API
   |-- Provider Router (OpenAI / Anthropic / optional Gemini)
   |-- Conversation + Memory service
   |-- Agent / Tool registry
   |-- Approval gate + audit log + emergency stop
   |-- Integration adapters (WhatsApp / email / calendar / browser)
   |-- Persistence adapter
```

Do not expose provider keys in frontend code. Put secrets in deployment environment variables. Keep dangerous actions disabled until explicit user approval.

## Repository integration plan

1. Bring the latest working XOFT AI Core server and UI into this repository without overwriting known-good functionality.
2. Normalize runtime configuration and health/readiness endpoints.
3. Integrate provider routing and streaming chat.
4. Add durable conversations and memory with opt-in controls.
5. Add voice UI and graceful fallbacks on unsupported browsers.
6. Implement plugin contracts and approval-gated actions.
7. Add WhatsApp through a supported, authenticated integration; do not scrape sessions or bypass platform rules.
8. Add CI checks, deployment instructions, and smoke tests.

## Configuration

Create a local `.env` from `.env.example` and supply your own API keys. Never commit real secrets.

## Security baseline

- Require authentication for personal data and integrations.
- Store secrets only in server-side environment variables.
- Ask for confirmation before sending messages, deleting data, or controlling devices.
- Record task approvals and actions in an audit log.
- Provide disconnect/revoke controls for integrations.
- Do not claim an integration works until credentials and end-to-end tests pass.

## Current status

This initial commit establishes the project direction and integration checklist. The source code from the existing `xoft` and `xoft-Ai-core` repositories still needs to be transferred and reconciled; documentation alone is not a completed code merge.
