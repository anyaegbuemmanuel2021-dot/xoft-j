# XOFT & Jarvis

A responsive, permission-first personal AI assistant for the XOFT ecosystem. This repository contains a runnable Node.js web application starter with an AI provider router, persistent conversations, user-managed memory, tasks, an approval log, browser voice controls, and a responsive dashboard.

> **Status: first implementation / integration in progress.** The code now includes a working server and UI foundation. It is not yet the complete merge of every feature from the original `xoft` and `xoft-Ai-core` repositories. Those repositories are source references and must remain untouched.

## Current implemented features

- Responsive dashboard for mobile, tablet, and desktop.
- Server-side OpenAI Chat Completions and Anthropic Messages API adapters.
- Conversation history stored in a JSON data file.
- User-controlled memory notes, included as context in future chats.
- Basic task list with open/done status.
- Approval request/decision log. Decisions are recorded; no external action is executed.
- Recent activity log.
- Browser speech input where supported; browser text-to-speech is available in browsers that implement it.
- API health/readiness endpoints.
- API rate limiting, security headers, server-side secrets, and constant-time access-token comparison.
- Production startup refuses to run without `AUTH_TOKEN`.
- Docker and Railway deployment configuration.

## Not implemented yet

These are explicit next-stage items, not currently working capabilities:

- WhatsApp account linking, chat reading, replies, and status updates.
- Email, calendar, browser automation, and operating-system/device control.
- Real agent execution, plugin execution, scheduled automations, and an emergency-stop control for running tools.
- Gemini adapter, streaming chat, multi-user accounts, database-backed persistence, and end-to-end tests.
- Full source-code reconciliation with the existing `xoft` and `xoft-Ai-core` projects.

The UI marks unavailable integrations honestly. Do not treat an approval decision as permission for a tool that has not been implemented.

## Requirements

- Node.js 22 or later.
- An API key for at least one supported provider (OpenAI or Anthropic).
- A long random `AUTH_TOKEN` when deployed.

## Run locally

1. Clone this repository.
2. Copy `.env.example` to `.env`.
3. Add `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` and set `DEFAULT_PROVIDER` accordingly.
4. Set a random `AUTH_TOKEN` for a protected instance. In local development, it can be left empty.
5. Install and run:

```bash
npm install
npm run check
npm start
```

6. Open `http://localhost:3000`. If you configured `AUTH_TOKEN`, enter it in Settings. The token is held in the current browser tab session.

Provider keys must stay in server environment variables. Never put API keys in frontend files or commit them to Git.

## Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `3000`) |
| `NODE_ENV` | Use `production` for deployment |
| `AUTH_TOKEN` | Bearer token for API routes; required in production |
| `DATA_DIR` | Directory for the JSON store (default `./data`) |
| `DEFAULT_PROVIDER` | `openai` or `anthropic` |
| `OPENAI_API_KEY` | Server-side OpenAI API key |
| `OPENAI_MODEL` | Optional model override |
| `OPENAI_BASE_URL` | Optional OpenAI-compatible Chat Completions URL |
| `ANTHROPIC_API_KEY` | Server-side Anthropic API key |
| `ANTHROPIC_MODEL` | Optional Anthropic model override |
| `TRUST_PROXY` | Set `true` only behind a trusted reverse proxy |

## Persistence and hosting warning

The built-in JSON store is intended for a small single-user MVP. It writes to `DATA_DIR`; use a persistent disk/volume on hosting or records may be lost when the instance is replaced. Before multi-user or business use, move persistence to a managed database, add migrations, backups, stronger session management, and automated integration tests.

## API overview

All routes except `/api/health` and `/api/ready` require `Authorization: Bearer <AUTH_TOKEN>` when `AUTH_TOKEN` is configured.

- `GET /api/health` — liveness check.
- `GET /api/ready` — basic readiness/configuration check.
- `GET /api/status` — provider configuration, feature flags, and record counts.
- `POST /api/chat` — `{ "message": "...", "provider": "openai", "conversationId": "optional-id" }`.
- `GET /api/conversations`, `GET /api/conversations/:id`, `DELETE /api/conversations/:id`.
- `GET /api/memory`, `POST /api/memory`, `DELETE /api/memory/:id`.
- `GET /api/tasks`, `POST /api/tasks`, `PATCH /api/tasks/:id`, `DELETE /api/tasks/:id`.
- `GET /api/approvals`, `POST /api/approvals`, `POST /api/approvals/:id/decision`.
- `GET /api/activity`.
- `POST /api/settings/provider`.

## Design research and open-source inspiration

The architecture takes high-level inspiration from established open-source assistant projects, rather than copying their code wholesale:

- [Khoj](https://github.com/khoj-ai/khoj) — personal knowledge, multi-provider chat, agents, and integrations. Its repository is AGPL-3.0, so incorporating its code would require a deliberate license and architecture decision.
- [Leon](https://github.com/leon-ai/leon) — modular personal-assistant skills and a Node.js-centered architecture; its repository is MIT-licensed.
- [Open Interpreter](https://github.com/openinterpreter/openinterpreter) — tool execution and computer-use patterns that emphasize sandboxing and permissions.

These are separate upstream projects, not bundled dependencies. This repository must retain the licenses and notices of any upstream code if a future integration copies or vendors it.

## Safety principles

- External actions stay disabled until their adapter, permissions, tests, and revocation path exist.
- Ask before sending messages, deleting data, or controlling devices.
- Keep credentials on the server and out of logs.
- Treat messages and documents as untrusted input; never let them silently authorize tool use.
- Keep a clear activity trail and a reliable way to disable integrations.
- Never claim an action or integration succeeded unless the system received a verified result.

## Next milestones

1. Review and reconcile the existing XOFT server and UI with this app without changing either original repository.
2. Add automated tests and CI checks; run the application in a real environment.
3. Move persistence to a database with migrations and backups.
4. Add a proper plugin contract and tool execution sandbox with approvals.
5. Add integrations one at a time, starting with an officially supported WhatsApp route after confirming the account type and API constraints.
6. Add voice, streaming, provider failover, and deployment monitoring.
