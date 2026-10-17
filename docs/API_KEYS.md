# API keys and accounts — what you need and where to get it

**You need none of these for XOFT AI CORE to start.** Add at least one *AI provider* when you want the AI to answer; everything else is optional.
The only secret you must create yourself is `AUTH_API_KEYS` (your own dashboard password — see the setup guide).

Put values in `.env` (or, for the two gateways, in Settings → AI providers). Never commit `.env`.
Availability, free tiers, pricing and supported countries change and differ by country — check each provider's own site before relying on it.

## AI providers (pick any one or more)

| Provider | `.env` variables | Get it here | Notes |
|---|---|---|---|
| **Google Gemini** | `GEMINI_API_KEY` | https://aistudio.google.com (Google AI Studio → *Get API key*) | Has a free tier; region availability varies. |
| **OpenAI** | `OPENAI_API_KEY` | https://platform.openai.com (dashboard → API keys) | Paid API account required; also enables semantic-memory embeddings and vision. |
| **Anthropic Claude** | `ANTHROPIC_API_KEY` | https://console.anthropic.com (Console → API keys) | Paid API account; good for vision and coding. |
| **xAI Grok** | `XAI_API_KEY` | https://console.x.ai | |
| **Experiential Labs** | `EXPERIENTIAL_API_KEY` | See `docs/EXPERIENTIAL_LABS.md` (gateway: `https://api.experientiallabs.ai/v1`) | Existing integration in this project. |
| **Ollama** (local, free, offline) | `OLLAMA_ENABLED=true`, `OLLAMA_MODEL` | https://ollama.com (install, then `ollama pull llama3.1`) | No key. Runs on the machine that hosts Xoft — a small VPS is usually too weak; best on your own PC/GPU server. |
| **FreeLLMAPI** (self-hosted gateway) | `FREELLMAPI_ENABLED`, `FREELLMAPI_API_KEY`, `FREELLMAPI_BASE_URL` | https://github.com/tashfeenahmed/freellmapi | You install it yourself; key comes from its dashboard. See `AI_GATEWAYS.md`. |
| **LiteLLM** (self-hosted gateway) | `LITELLM_ENABLED`, `LITELLM_MODEL`, `LITELLM_API_KEY` | https://docs.litellm.ai/docs/simple_proxy | Key = your proxy master key (optional). See `AI_GATEWAYS.md`. |

## Optional capabilities

| Capability | `.env` variables | Get it here |
|---|---|---|
| Web search | `BRAVE_SEARCH_API_KEY` | https://brave.com/search/api |
| Voice replies (text-to-speech) | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | https://elevenlabs.io |
| Google Workspace (Gmail/Calendar/Drive) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | https://console.cloud.google.com (APIs & Services → Credentials → OAuth client; you must complete the OAuth consent flow to obtain the refresh token) |
| WhatsApp (Meta Cloud API) | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN` (you invent it), `WHATSAPP_APP_SECRET` | https://developers.facebook.com (create an app → add WhatsApp). Docs: https://developers.facebook.com/docs/whatsapp |
| Phone calls / SMS (Twilio) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_PUBLIC_BASE_URL` (= your https domain) | https://www.twilio.com/console |
| External tool connectors (MCP) | `XOFT_CONNECTORS_JSON` | The connector's own site; see `docs/CONNECTORS.md` |

WhatsApp and Twilio call back into your server, so they need your **public HTTPS domain** (see `SETUP_AND_HOSTING.md`). Webhook URLs to register are listed in `docs/COMMUNICATION_INTEGRATIONS.md`.

## Keys you create yourself

| Variable | How |
|---|---|
| `AUTH_API_KEYS` | `openssl rand -hex 32` — the password for your dashboard/API. Required in production mode. Comma-separate to allow several. |
| `WHATSAPP_VERIFY_TOKEN` | Any random string; you type the same one into Meta's webhook setup. |

## Checking a key works

* AI gateways: `node scripts/gateway-check.mjs freellmapi` / `litellm`, or Settings → AI providers → *Test connection*.
* Any provider: Dashboard → Settings/Providers shows its status; a real chat message is the final test.
