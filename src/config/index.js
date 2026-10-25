import dotenv from 'dotenv';
import { gatewayConfigFromEnv, gatewayConfigState } from '../providers/gatewayConfig.js';
dotenv.config();

function required(name, fallback = undefined) {
  return process.env[name] ?? fallback;
}

// Google shut down the Gemini 2.0 Flash family on 1 June 2026.
// Automatically migrate known retired IDs so a stale deployment variable
// cannot silently keep XOFT pinned to a model that no longer exists.
const RETIRED_GEMINI_MODELS = new Set([
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash-lite-001',
]);

function configuredGeminiModel() {
  const model = String(required('GEMINI_MODEL', 'gemini-3.8-flash') ?? '').trim();
  if (!model || RETIRED_GEMINI_MODELS.has(model)) {
    if (model && RETIRED_GEMINI_MODELS.has(model)) {
      console.warn(`[XOFT] GEMINI_MODEL="${model}" has been retired. Switching to gemini-3.8-flash.`);
    }
    return 'gemini-3.8-flash';
  }
  return model;
}

export const config = {
  port: Number(required('PORT', 3000)),
  host: required('HOST', '0.0.0.0'),
  nodeEnv: required('NODE_ENV', 'development'),
  storage: {
    mode: required('STORAGE_MODE', 'sqlite'),
    sqlitePath: required('SQLITE_PATH', './data/xoft.sqlite'),
  },
  production: {
    requireAuth: String(required('REQUIRE_AUTH_IN_PRODUCTION', 'true')).toLowerCase() === 'true',
  },

  privacy: {
    // Opt-in: classify every model request and route SECRET/SENSITIVE data away from cloud providers.
    routing: String(required('PRIVACY_ROUTING', 'false')).toLowerCase() === 'true',
  },

  // Execution engines (Xoft Core + pluggable engines such as Hermes). Hermes-specific settings use HERMES_* (see docs/HERMES_ENGINE.md).
  engines: {
    maxConcurrentTasks: Number(required('ENGINES_MAX_CONCURRENT_TASKS', '3')),
    resumeOnStartup: String(required('ENGINES_RESUME_ON_STARTUP', 'true')).toLowerCase() === 'true',
    healthIntervalMs: Number(required('ENGINES_HEALTH_INTERVAL_MS', '30000')),
    gitSafetyNet: String(required('ENGINES_GIT_SAFETY_NET', 'true')).toLowerCase() === 'true',
    bridgeAllowRemote: String(required('HERMES_BRIDGE_ALLOW_REMOTE', 'false')).toLowerCase() === 'true',
  },

  watchdog: {
    enabled: String(required('WATCHDOG_ENABLED', 'true')).toLowerCase() === 'true',
    intervalMs: Number(required('WATCHDOG_INTERVAL_MS', '30000')),
  },

  memory: {
    dataDir: required('MEMORY_DATA_DIR', './data'),
  },

  devices: {
    // How long without a heartbeat/state update before a device is considered offline.
    onlineThresholdMs: required('DEVICE_ONLINE_THRESHOLD_MS', 90000),
    // How long a device command waits for the agent to report a result before timing out.
    commandTimeoutMs: required('DEVICE_COMMAND_TIMEOUT_MS', 30000),
    // Auto-trust a device that registers from 127.0.0.1/::1 — see isLoopback() in index.js.
    // Off by default; the combined PC launcher (xoft-pc/) turns this on for itself only.
    autoTrustLocal: String(required('AUTO_TRUST_LOCAL', 'false')).toLowerCase() === 'true',
  },

  auth: {
    // Comma-separated shared secrets. Empty = API is open (localhost/LAN dev only — see warning in index.js).
    apiKeys: String(required('AUTH_API_KEYS', ''))
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
  },

  google: {
    clientId: required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
    refreshToken: required('GOOGLE_REFRESH_TOKEN'),
  },

  search: {
    // Set to a trusted SearXNG instance for keyless search (e.g. http://searxng:8080 in Docker Compose).
    searxngBaseUrl: String(required('SEARXNG_BASE_URL', '')).trim().replace(/\/+$/, ''),
    // Optional paid/free-tier fallback; never required when SearXNG is configured.
    braveApiKey: required('BRAVE_SEARCH_API_KEY'),
  },

  voice: {
    elevenLabsApiKey: required('ELEVENLABS_API_KEY'),
    elevenLabsVoiceId: required('ELEVENLABS_VOICE_ID', '21m00Tcm4TlvDq8ikWAM'),
    elevenLabsModel: String(required('ELEVENLABS_MODEL', 'eleven_flash_v2_5')).trim(),
    elevenLabsOutputFormat: String(required('ELEVENLABS_OUTPUT_FORMAT', 'mp3_22050_32')).trim(),
    // STT: Whisper (OpenAI) is the default; Gemini is the server-side fallback. Comma-separated, first = preferred.
    sttProviderOrder: String(required('STT_PROVIDER_ORDER', 'openai,gemini'))
      .split(',').map((p) => p.trim().toLowerCase()).filter(Boolean),
    // Hard failover cutoff: Gemini takes over if the preferred provider is still running after 1s.
    sttHedgeMs: (() => {
      const raw = process.env.STT_HEDGE_MS;
      const parsed = raw == null || raw.trim() === '' ? 1000 : Number(raw);
      return Number.isFinite(parsed) ? Math.max(0, parsed) : 1000;
    })(),
    sttLanguage: String(required('STT_LANGUAGE', '')).trim(),
    // gpt-transcribe is the higher-accuracy default; set STT_OPENAI_MODEL=whisper-1 for legacy behavior.
    sttOpenAiModel: String(required('STT_OPENAI_MODEL', 'gpt-transcribe')).trim(),
    // Context is a spelling hint only. Language detection stays automatic unless STT_LANGUAGE is explicitly set.
    sttContextPrompt: String(required(
      'STT_CONTEXT_PROMPT',
      'Transcribe the audio verbatim, including natural pauses and code-switching. Accurately preserve Nigerian English and Igbo or other Nigerian-language words mixed with English; do not translate them into English, paraphrase, normalize the speaker’s accent, or replace unfamiliar words with more common words. Possible spelling/context hints include XOFT, Softly Digitals, GitHub, Render, biko, kedu, daalu, nnoo, gini, ezigbo, and “gee m aka”. These are examples only: include a term only when it is actually spoken, never inject example words from this prompt. Keep the speaker’s original language and wording, and add punctuation only where it helps readability.'
    )).trim(),
    sttGeminiModel: String(required('STT_GEMINI_MODEL', '')).trim(), // empty = use the configured Gemini chat model
    sttTimeoutMs: Number(process.env.STT_TIMEOUT_MS) || 30000,
    ttsTimeoutMs: Number(process.env.TTS_TIMEOUT_MS) || 20000,
  },

  media: {
    // Image generation rides on the OpenAI key already configured above.
    imageModel: required('IMAGE_MODEL', 'gpt-image-2'),
    // Video generation rides on the Gemini key already configured below.
    // 'preview' in the model id reflects Google's own current model name as of this writing —
    // if it changes, calls fail with a real, specific error rather than silently doing nothing.
    videoModel: required('VIDEO_MODEL', 'veo-3.1-generate-preview'),
  },

  whatsapp: {
    accessToken: required('WHATSAPP_ACCESS_TOKEN'),
    phoneNumberId: required('WHATSAPP_PHONE_NUMBER_ID'),
    verifyToken: required('WHATSAPP_VERIFY_TOKEN'),
    appSecret: required('WHATSAPP_APP_SECRET'),
    apiVersion: required('WHATSAPP_API_VERSION', 'v23.0'),
  },

  twilio: {
    accountSid: required('TWILIO_ACCOUNT_SID'),
    authToken: required('TWILIO_AUTH_TOKEN'),
    fromNumber: required('TWILIO_FROM_NUMBER'),
    voiceWebhookUrl: required('TWILIO_VOICE_WEBHOOK_URL'),
    voiceResponseUrl: required('TWILIO_VOICE_RESPONSE_URL'),
    statusCallbackUrl: required('TWILIO_STATUS_CALLBACK_URL'),
    publicBaseUrl: required('TWILIO_PUBLIC_BASE_URL'),
  },

  task: {
    maxDurationMs: Math.max(1000, Number(required('TASK_MAX_DURATION_MS', 15 * 60 * 1000))),
  },

  connectors: {
    definitions: (() => {
      const raw = process.env.XOFT_CONNECTORS_JSON;
      if (!raw) return [];
      try { return JSON.parse(raw); } catch (err) { throw new Error(`Invalid XOFT_CONNECTORS_JSON: ${err.message}`); }
    })(),
  },

  providers: {
    openai: {
      apiKey: required('OPENAI_API_KEY'),
      chatModel: required('OPENAI_CHAT_MODEL', 'gpt-6-astra'),
      fastModel: required('OPENAI_FAST_MODEL', required('OPENAI_MODEL_EFFICIENT', 'gpt-6-luna')),
      // Explicit model tiers allow task-aware routing and manual tuning without code changes.
      models: {
        flagship: required('OPENAI_MODEL_FLAGSHIP', 'gpt-6-astra'),
        balanced: required('OPENAI_MODEL_BALANCED', 'gpt-6.1-sol'),
        efficient: required('OPENAI_MODEL_EFFICIENT', 'gpt-6-luna'),
        coding: required('OPENAI_MODEL_CODING', 'gpt-5.6-sol'),
        budget: required('OPENAI_MODEL_BUDGET', 'gpt-5.6-terra'),
      },
      embeddingModel: required('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),
    },
    gemini: {
      apiKey: required('GEMINI_API_KEY'),
      model: configuredGeminiModel(),
    },
    claude: {
      apiKey: required('ANTHROPIC_API_KEY'),
      model: required('ANTHROPIC_MODEL', 'claude-sonnet-5'),
    },
    xai: {
      apiKey: required('XAI_API_KEY'),
      model: required('XAI_MODEL', 'grok-4.7'),
    },
    experiential: {
      apiKey: required('EXPERIENTIAL_API_KEY'),
      baseUrl: required('EXPERIENTIAL_BASE_URL', 'https://api.experientiallabs.ai/v1'),
      model: required('EXPERIENTIAL_MODEL', 'gpt-5.6-luna'),
      freeOnly: String(required('EXPERIENTIAL_FREE_ONLY', 'true')).toLowerCase() === 'true',
    },
    // Optional OpenAI-compatible gateways. Both default to DISABLED and neither requires a key to exist for Xoft to boot: a missing or
    // malformed setting is a provider-level *state* (unconfigured / invalid_configuration), never a startup error. See docs/AI_GATEWAYS.md.
    freellmapi: gatewayConfigFromEnv('freellmapi'),
    litellm: gatewayConfigFromEnv('litellm'),
    ollama: {
      // Local model fallback — used when no cloud provider is configured, or when
      // every configured cloud provider fails (e.g. no internet). Off by default:
      // reaching for a network-absent local daemon on every call would otherwise
      // slow down the common case. Requires Ollama actually running locally
      // (https://ollama.com) with `model` already pulled.
      enabled: String(required('OLLAMA_ENABLED', 'false')).toLowerCase() === 'true',
      baseUrl: required('OLLAMA_BASE_URL', 'http://127.0.0.1:11434'),
      model: required('OLLAMA_MODEL', 'llama3.1'),
    },
  },

  // Optional global override of ProviderRouter's per-task-type preference
  // lists (see ProviderRouter._preferenceFor). When aiRouting.primaryProvider
  // is unset (the default), the router keeps its existing task-aware
  // ordering — e.g. Claude first for reasoning, OpenAI-fast first for
  // simple tasks — which is more useful than one global order. Setting it
  // pins a single provider first for EVERY task type instead; fallback
  // beyond it is only used when aiRouting.fallbackEnabled is true (default
  // true, matching the router's existing behavior), so a user who wants a
  // hard "never silently switch providers" guarantee can set
  // AI_FALLBACK_ENABLED=false and know only their chosen primary is ever tried.
  aiRouting: {
    fallbackEnabled: String(required('AI_FALLBACK_ENABLED', 'true')).toLowerCase() === 'true',
    primaryProvider: required('AI_PRIMARY_PROVIDER', null),
    fallbackProviders: String(required('AI_FALLBACK_PROVIDERS', ''))
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  },
};

/**
 * Returns which providers currently have credentials configured.
 * The router uses this to avoid ever pretending a provider works.
 */
export function availableProviders() {
  const avail = [];
  if (config.providers.openai.apiKey) avail.push('openai');
  if (config.providers.gemini.apiKey) avail.push('gemini');
  if (config.providers.claude.apiKey) avail.push('claude');
  if (config.providers.xai.apiKey) avail.push('grok');
  if (config.providers.experiential.apiKey) avail.push('experiential');
  if (gatewayConfigState('freellmapi', config.providers.freellmapi).configured) avail.push('freellmapi');
  if (gatewayConfigState('litellm', config.providers.litellm).configured) avail.push('litellm');
  if (config.providers.ollama.enabled) avail.push('ollama');
  return avail;
}

/** Which optional integrations are actually configured — used by /api/status and tool status. */
export function integrationStatus() {
  return {
    google: Boolean(config.google.clientId && config.google.clientSecret && config.google.refreshToken),
    braveSearch: Boolean(config.search.braveApiKey),
    elevenLabs: Boolean(config.voice.elevenLabsApiKey),
    whisper: Boolean(config.providers.openai.apiKey), // STT rides on the OpenAI key
    imageGeneration: Boolean(config.providers.openai.apiKey), // rides on the OpenAI key
    videoGeneration: Boolean(config.providers.gemini.apiKey), // rides on the Gemini key
    connectors: config.connectors.definitions.filter((c) => c.enabled !== false).map((c) => c.id),
    whatsapp: Boolean(config.whatsapp.accessToken && config.whatsapp.phoneNumberId && config.whatsapp.verifyToken && config.whatsapp.appSecret),
    experiential: Boolean(config.providers.experiential.apiKey),
    freellmapi: gatewayConfigState('freellmapi', config.providers.freellmapi).configured,
    litellm: gatewayConfigState('litellm', config.providers.litellm).configured,
    twilio: Boolean(config.twilio.accountSid && config.twilio.authToken && config.twilio.fromNumber && config.twilio.voiceWebhookUrl && config.twilio.voiceResponseUrl),
  };
}
