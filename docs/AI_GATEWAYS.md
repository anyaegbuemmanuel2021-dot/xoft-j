# Optional AI gateways: FreeLLMAPI and LiteLLM

> **Xoft does not require FreeLLMAPI. Xoft does not require LiteLLM. Xoft does not require any single AI provider or any API key.**
> Both gateways are OFF by default and are just two more independent providers inside the existing `ProviderRouter`.

```
                         XOFT  (orchestrator: tools, files, browser, PC, terminal, missions, self-editing — all stay in Xoft)
                           │
                     ProviderRouter  ── ModelHealthManager (health, cooldowns)
   ┌────────┬────────┬─────┴──┬────────┬──────────┬──────────┬───────────┐
 OpenAI  Gemini   Claude    Grok   Experiential  LiteLLM   FreeLLMAPI   Ollama
   (independent peers — there is no chain and no provider needs another)        (local, optional)
```

A gateway supplies *intelligence only*. When a model asks to use a tool, the gateway adapter returns the request (`{name, input}`) and
**Xoft's own executor** decides whether and how to run it, under Xoft's permissions, approvals, autonomy levels and kill switch.
The adapter code has no access to files, the browser, the PC or the terminal (a test asserts this).

## What happens when providers are missing or failing

| Situation | Result |
|---|---|
| No key / gateway disabled / gateway not installed | Provider state `disabled` or `unconfigured`. Xoft starts normally. |
| Malformed URL or settings | State `invalid_configuration`. Never a startup error. |
| One provider down / rate-limited / rejects its key | That provider is parked briefly and the router falls back to the next candidate. Nothing else changes. |
| **Every** provider unavailable | Xoft keeps running. Files, devices, automations, settings, logs, terminal, browser and the UI all work. Only an AI request returns `503 {"success":false,"error":"NO_AI_PROVIDER_AVAILABLE","message":"No AI provider is currently configured or available."}`. The chat UI shows a friendly explanation. |
| Providers configured but all errored | `502 {"error":"AI_PROVIDERS_FAILED", …}` with per-provider error *types* (no secrets, no upstream bodies). |
| Semantic-memory embeddings with no embedding provider | Semantic memory is simply off; keyword memory still works. |

Startup only logs a one-line informational note when no provider is configured. It never exits.

## Configuration

Set values in `.env`, in **Settings → AI providers**, or both (Settings values override `.env`; "Reset to .env" removes them).

```
FREELLMAPI_ENABLED=false
FREELLMAPI_BASE_URL=http://localhost:3001/v1
FREELLMAPI_API_KEY=            # the unified key (freellmapi-…) from FreeLLMAPI's dashboard "Keys" page. Required.
# FREELLMAPI_MODEL=auto        # auto | auto:fast | auto:smart | a concrete model id

LITELLM_ENABLED=false
LITELLM_BASE_URL=http://localhost:4000/v1
LITELLM_API_KEY=               # the proxy master/virtual key. Optional if your proxy has no master key.
# LITELLM_MODEL=               # a model_name from your LiteLLM config.yaml; blank = first model the proxy lists
```

Optional per gateway (replace `LITELLM_` with `FREELLMAPI_`): `…_EMBEDDING_MODEL`, `…_VISION=true` (only if the model accepts images),
`…_TOOLS=false` (if the model cannot call tools), `…_TIMEOUT_MS`.

**Keys:** never hard-coded, never committed. Keys saved from the UI are written to `data/provider-settings.json` (git-ignored, owner-only
permissions) and are **write-only**: no API response, log line, diagnostic or error message contains a key (only "is set" and a masked hint
like `fre************3456`). Settings routes require the admin API key, not a device token.

## Provider health states

`disabled · unconfigured · invalid_configuration · starting · available · unavailable · unhealthy · rate_limited · authentication_error · timeout · server_error · cooldown`

They are derived from the same `ModelHealthManager` data the router uses, plus the last connection test. `GET /api/ai/status` returns them.
Gateways use **hard cooldowns** so a dead server or rejected key is not retried on every request:

| Failure | Parked for |
|---|---|
| bad key (401/403) | 5 min |
| rate limit | `Retry-After` (max 5 min) or 60 s |
| server down / timeout / 5xx | 30 s |

A successful **Test connection** or saving new settings clears the cooldown immediately. Direct providers keep their original behaviour.

## Routing and fallback

Order is configurable and nothing is permanently "best". By default gateways rank **after** the direct providers and **before** local Ollama,
so enabling one never changes which direct provider answers. To prefer a gateway:

```
AI_PRIMARY_PROVIDER=freellmapi
AI_FALLBACK_PROVIDERS=litellm,openai,claude
```

The router also honours: availability, health/cooldown, tool support, vision support, privacy routing (SECRET content is never sent to a
gateway — a localhost gateway forwards to cloud models, so only Ollama counts as local), and streaming (`router.stream()` falls back
only *before* the first token; a half-delivered answer is never silently re-homed).

## Model selection

Gateway model names are never hard-coded. Order: explicit `…_MODEL` → model picked in the UI (*Load models* → *Save*, validated against
discovery when available) → first model the gateway lists. If discovery fails, an explicitly typed model name still works.

## Testing each gateway on its own

```
node scripts/gateway-check.mjs freellmapi                  # connection test + models + one tiny chat
node scripts/gateway-check.mjs litellm --no-chat           # no tokens spent
node scripts/gateway-check.mjs litellm --model my-alias --stream
```
It uses Xoft's real provider code, prints a masked key, and exits 0 only when everything requested worked.

In the app: **Settings → AI providers → Test connection** returns one of `CONNECTED · NOT_CONFIGURED · UNAVAILABLE · AUTHENTICATION_ERROR · TIMEOUT · SERVER_ERROR · INVALID_CONFIGURATION`.

## Installing the gateways (separate phase — Xoft never needs them)

### FreeLLMAPI (Node 20+; personal experimentation — see its terms/limits)
Docker (recommended by the project):
```
curl -fsSL https://freellmapi.co/install.sh | bash
```
or manually:
```
git clone https://github.com/tashfeenahmed/freellmapi.git
cd freellmapi
cp .env.example .env
echo "ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" >> .env
npm install
npm run dev              # dev: dashboard at http://localhost:5173
# production: npm run build && node server/dist/index.js   (API + dashboard on :3001)
```
Open the dashboard, add provider keys on the **Keys** page, copy the unified `freellmapi-…` key, then in Xoft set
`FREELLMAPI_ENABLED=true`, `FREELLMAPI_API_KEY=<that key>` (base URL default `http://localhost:3001/v1`).

### LiteLLM proxy (Python 3.10+)
```
pip install 'litellm[proxy]'          # or: uv tool install 'litellm[proxy]'
```
Create `litellm_config.yaml`:
```yaml
model_list:
  - model_name: my-model            # the name Xoft will use (LITELLM_MODEL)
    litellm_params:
      model: openai/gpt-4o-mini     # any litellm-supported provider/model
      api_key: os.environ/OPENAI_API_KEY
general_settings:
  master_key: sk-change-me          # optional; must start with sk-
```
```
litellm --config litellm_config.yaml      # listens on http://localhost:4000
```
Then in Xoft: `LITELLM_ENABLED=true`, `LITELLM_MODEL=my-model`, and `LITELLM_API_KEY=sk-change-me` if you set a master key.

Commands above follow each project's published quick-start; check their docs for current options.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `unconfigured` | Enabled but key missing (FreeLLMAPI needs one). |
| `invalid_configuration` | Base URL malformed, or `/models` returned 404/HTML — URL must point at the OpenAI-compatible root, ending in `/v1`. |
| `unavailable` | Gateway not running / wrong port. Retried after 30 s. |
| `authentication_error` | Wrong key. Fix it and press **Test connection** (clears the cooldown at once). |
| `rate_limited` | Gateway/upstream limit; other providers answer meanwhile. |
| "no model configured and none discovered" | Set `…_MODEL`; your gateway does not list models. |
| Tool calls never happen | Model/gateway may not support tools → untick "supports tool calling" so the router skips it for agent work. |
| Images ignored | Tick "accepts images" only for a vision-capable model; otherwise Xoft uses Claude/OpenAI for vision. |

## Verification status (be precise)

* **Verified with automated tests:** configuration states, key masking/redaction, all 10 matrix cases, fallback, cooldowns, structured
  errors, streaming, tool-call normalisation, embeddings ordering, capability gating, privacy routing, Watchdog/overview integration,
  Settings store and REST handlers — against a real local HTTP server that speaks the OpenAI-compatible wire protocol.
* **Not verified here:** behaviour against the *actual* FreeLLMAPI and LiteLLM programs (they were not installed — no network in the build
  sandbox), the running Express server, and the new Settings page rendered in a browser. Run `scripts/gateway-check.mjs` against your real installs.
