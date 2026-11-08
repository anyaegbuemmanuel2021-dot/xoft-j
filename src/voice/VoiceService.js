import { config } from '../config/index.js';

/**
 * VoiceService - server-side STT and TTS. Both are plain API calls, so the caller
 * (web or mobile client) only sends/receives audio bytes over HTTP.
 *
 * STT: Gemini is primary and OpenAI is the fallback. A failed/empty primary hands over immediately; a slow
 *      primary is hedged: after STT_HEDGE_MS the fallback starts in parallel and the first usable transcript wins.
 * TTS: Gemini speech first, OpenAI speech as fallback, optional ElevenLabs last. Same hedging rule
 *      (TTS_HEDGE_MS). Native clients prefer the installed OS voice; web-only clients can use the server TTS endpoint.
 *
 * Not here (needs a client with mic/speaker access): wake-word detection, VAD capture,
 * streaming playback, and the always-listening loop.
 */

const MAX_TTS_CHARS = 4000;
const GEMINI_AUDIO_MIME = {
  'audio/webm': 'audio/webm',
  'audio/ogg': 'audio/ogg',
  'audio/mp4': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'audio/mpeg': 'audio/mp3',
  'audio/mp3': 'audio/mp3',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
};

/** Timeout that can also be cancelled by the caller (used to drop the losing STT request). */
function withTimeout(ms, signal) {
  return signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms);
}

const RETRYABLE_STT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function retryDelayMs(response, attempt) {
  const value = response?.headers?.get?.('retry-after');
  if (value) {
    const seconds = Number(value);
    const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    if (Number.isFinite(requested) && requested >= 0) return Math.min(1500, requested);
  }
  return 250 * (2 ** attempt);
}

function waitForRetry(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Retry transient provider failures without rebuilding or discarding the captured audio.
 * Permanent client/auth/payload errors are returned immediately; a caller's timeout/abort is never retried.
 */
async function isQuotaExhausted(response) {
  if (Number(response?.status) !== 429) return false;
  const raw = await response.clone().text().catch(() => '');
  let payload = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch { /* provider may return plain text */ }
  const detail = payload?.error ?? payload;
  const code = String(detail?.code ?? detail?.type ?? '').toLowerCase();
  return code === 'insufficient_quota'
    || code === 'billing_hard_limit_reached'
    || /insufficient_quota|billing_hard_limit|exceeded your current quota/i.test(raw);
}

async function fetchWithSttRetry(fetchImpl, url, init, { maxAttempts = 2 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (init.signal?.aborted || attempt + 1 >= maxAttempts) throw error;
      await waitForRetry(250 * (2 ** attempt), init.signal);
      continue;
    }
    if (!RETRYABLE_STT_STATUSES.has(response.status) || attempt + 1 >= maxAttempts) return response;
    // A quota/billing 429 is permanent until account limits change; retrying only wastes time and calls.
    if (await isQuotaExhausted(response)) return response;
    const delay = retryDelayMs(response, attempt);
    try { await response.body?.cancel(); } catch { /* response may already be consumed */ }
    await waitForRetry(delay, init.signal);
  }
  throw new Error('Speech transcription retry attempts exhausted.');
}

/** Wrap raw 16-bit little-endian mono PCM in a WAV container so any <audio> element can play it. */
export function pcm16ToWav(pcm, sampleRate = 24000, channels = 1) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Run providers in order with latency hedging.
 *  - A definite failure (error / unusable result) starts the next provider immediately.
 *  - A slow provider is NOT killed: after hedgeMs the next provider starts in parallel and the first usable
 *    result wins. Every losing request is aborted so nothing keeps running (or billing) in the background.
 * @returns {Promise<{value: any, provider: string, ms: number, attempts: Array}>}
 */
function runHedged(providers, run, { hedgeMs = 0, isUsable = Boolean, label = 'request' } = {}) {
  const startedAt = Date.now();
  const attempts = [];
  const controllers = new Map();
  return new Promise((resolve, reject) => {
    let nextIndex = 0;
    let pending = 0;
    let settled = false;
    let hedgeTimer = null;
    const ordered = () => [...attempts].sort((a, b) => providers.indexOf(a.provider) - providers.indexOf(b.provider));
    const clearHedge = () => { if (hedgeTimer) { clearTimeout(hedgeTimer); hedgeTimer = null; } };
    const armHedge = () => {
      clearHedge();
      if (settled || nextIndex >= providers.length || !(hedgeMs > 0)) return;
      hedgeTimer = setTimeout(() => { hedgeTimer = null; startNext(); }, hedgeMs);
    };
    const startNext = () => {
      if (settled || nextIndex >= providers.length) return;
      const provider = providers[nextIndex++];
      const controller = new AbortController();
      controllers.set(provider, controller);
      const t0 = Date.now();
      pending += 1;
      armHedge();
      let promise;
      try { promise = Promise.resolve(run(provider, controller.signal)); } catch (error) { promise = Promise.reject(error); }
      promise.then((value) => ({ value, error: null }), (error) => ({ value: null, error })).then(({ value, error }) => {
        pending -= 1;
        if (settled) return;
        const ms = Date.now() - t0;
        if (!error && isUsable(value)) {
          settled = true;
          clearHedge();
          attempts.push({ provider, ok: true, ms });
          for (const [name, c] of controllers) if (name !== provider) c.abort();
          resolve({ value, provider, ms: Date.now() - startedAt, attempts: ordered() });
          return;
        }
        attempts.push({ provider, ok: false, error: error ? error.message : 'empty result', ms });
        if (nextIndex < providers.length) { startNext(); return; }
        if (pending === 0) {
          settled = true;
          clearHedge();
          const list = ordered();
          const err = new Error(`VoiceService: ${label} failed (${list.map((a) => `${a.provider}: ${a.error}`).join('; ')}).`);
          err.attempts = list;
          reject(err);
        }
      });
    };
    startNext();
  });
}

export class VoiceService {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetch = fetchImpl;
  }

  /** TTS providers that are both in the configured order and have credentials. */
  ttsProviders() {
    const available = {
      gemini: Boolean(config.providers.gemini.apiKey),
      openai: Boolean(config.providers.openai.apiKey),
      elevenlabs: Boolean(config.voice.elevenLabsApiKey),
    };
    const order = Array.isArray(config.voice.ttsProviderOrder) && config.voice.ttsProviderOrder.length
      ? config.voice.ttsProviderOrder : ['gemini', 'openai', 'elevenlabs'];
    return [...new Set(order)].filter((name) => available[name]);
  }

  isTTSConfigured() {
    return this.ttsProviders().length > 0;
  }

  /** Providers that are both in the configured order and have credentials. */
  sttProviders() {
    const available = {
      gemini: Boolean(config.providers.gemini.apiKey),
      openai: Boolean(config.providers.openai.apiKey),
    };
    // Keep the product contract deterministic: Gemini first, OpenAI second.
    // Do not let a stale environment/settings override reverse the required fallback order.
    return ['gemini', 'openai'].filter((name) => available[name]);
  }

  isSTTConfigured() {
    return this.sttProviders().length > 0;
  }

  status() {
    return {
      stt: { default: 'gemini', fallback: 'openai', model: config.voice.sttGeminiModel || config.providers.gemini.model, fallbackModel: config.voice.sttOpenAiModel, providers: this.sttProviders(), configured: this.isSTTConfigured(), hedgeMs: config.voice.sttHedgeMs },
      tts: { provider: this.ttsProviders()[0] ?? null, providers: this.ttsProviders(), configured: this.isTTSConfigured(), fallback: 'client-native', streaming: true, hedgeMs: config.voice.ttsHedgeMs },
    };
  }

  _cleanSpeech(text) {
    const spoken = String(text ?? '').trim().slice(0, MAX_TTS_CHARS);
    if (!spoken) throw new Error('VoiceService: text is empty.');
    return spoken;
  }

  async _geminiSpeak(text, signal) {
    const model = config.voice.geminiTtsModel || 'gemini-2.5-flash-preview-tts';
    const res = await this.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.providers.gemini.apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice.geminiTtsVoice || 'Kore' } } },
          },
        }),
        signal: withTimeout(config.voice.ttsTimeoutMs, signal),
      }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Gemini speech error ${res.status} - ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const inline = parts.map((p) => p?.inlineData ?? p?.inline_data).find((d) => d?.data);
    if (!inline) throw new Error('Gemini speech returned no audio');
    const mime = String(inline.mimeType ?? inline.mime_type ?? '');
    const pcm = Buffer.from(inline.data, 'base64');
    if (!pcm.length) throw new Error('Gemini speech returned empty audio');
    // Gemini returns raw 16-bit PCM ("audio/L16;codec=pcm;rate=24000"); already-containerised audio passes through.
    if (/^audio\/(wav|x-wav|mpeg|mp3|ogg|webm)/i.test(mime)) return { buffer: pcm, contentType: mime.split(';')[0] };
    const rate = Number(/rate=(\d+)/i.exec(mime)?.[1]) || 24000;
    return { buffer: pcm16ToWav(pcm, rate), contentType: 'audio/wav' };
  }

  async _openaiSpeak(text, signal) {
    const res = await this.fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.providers.openai.apiKey}` },
      body: JSON.stringify({
        model: config.voice.openaiTtsModel || 'gpt-4o-mini-tts',
        voice: config.voice.openaiTtsVoice || 'alloy',
        input: text,
        response_format: 'mp3',
      }),
      signal: withTimeout(config.voice.ttsTimeoutMs, signal),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenAI speech error ${res.status} - ${errText.slice(0, 300)}`);
    }
    return { body: res.body ?? null, response: res, contentType: 'audio/mpeg' };
  }

  async _elevenLabsSpeak(text, signal) {
    const format = config.voice.elevenLabsOutputFormat || 'mp3_22050_32';
    const res = await this.fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voice.elevenLabsVoiceId)}/stream?output_format=${encodeURIComponent(format)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
          'xi-api-key': config.voice.elevenLabsApiKey,
        },
        body: JSON.stringify({
          text,
          model_id: config.voice.elevenLabsModel,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
        signal: withTimeout(config.voice.ttsTimeoutMs, signal),
      }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`ElevenLabs API error ${res.status} - ${errText.slice(0, 300)}`);
    }
    return { body: res.body ?? null, response: res, contentType: 'audio/mpeg' };
  }

  /**
   * Synthesise speech: Gemini first, OpenAI fallback, optional ElevenLabs last (hedged, see runHedged).
   * @returns {Promise<{buffer?: Buffer, body?: ReadableStream|null, contentType: string, provider: string, ms: number, attempts: Array}>}
   */
  async synthesize(text) {
    const spoken = this._cleanSpeech(text);
    const providers = this.ttsProviders();
    if (!providers.length) {
      throw new Error('VoiceService: no text-to-speech provider configured. Set GEMINI_API_KEY and/or OPENAI_API_KEY.');
    }
    const out = await runHedged(
      providers,
      (provider, signal) => (provider === 'gemini' ? this._geminiSpeak(spoken, signal)
        : provider === 'openai' ? this._openaiSpeak(spoken, signal)
          : this._elevenLabsSpeak(spoken, signal)),
      { hedgeMs: config.voice.ttsHedgeMs, isUsable: (v) => Boolean(v?.buffer?.length || v?.body), label: 'text-to-speech' }
    );
    return { ...out.value, provider: out.provider, ms: out.ms, attempts: out.attempts };
  }

  /**
   * Streaming TTS: resolves as soon as a provider starts answering, so the caller can pipe the first audio
   * bytes to the client instead of waiting for the whole clip (Gemini answers with one finished clip in `buffer`).
   * @param {string} text
   */
  async textToSpeechStream(text) {
    return this.synthesize(text);
  }

  /**
   * @param {string} text
   * @returns {Promise<Buffer>} audio bytes (WAV from Gemini, MP3 from OpenAI/ElevenLabs)
   */
  async textToSpeech(text) {
    const out = await this.synthesize(text);
    if (out.buffer) return out.buffer;
    return Buffer.from(await out.response.arrayBuffer());
  }

  async _openaiTranscribe(audioBuffer, filename, signal, language = '', mime = 'audio/webm') {
    const form = new FormData();
    // Preserve the recorder's actual media type; OpenAI uses both the MIME and filename to decode uploads.
    const contentType = String(mime || 'audio/webm').split(';', 1)[0].trim().toLowerCase();
    form.append('file', new Blob([audioBuffer], { type: contentType }), filename);
    const model = config.voice.sttOpenAiModel;
    form.append('model', model);
    form.append('response_format', 'json');
    if (config.voice.sttContextPrompt) form.append('prompt', config.voice.sttContextPrompt);
    // Whisper accepts temperature; newer transcription models may reject it.
    if (model === 'whisper-1') form.append('temperature', '0');
    // Leave language detection open for mixed Nigerian English/Pidgin/Igbo unless explicitly selected.
    const chosenLanguage = language === 'auto' ? '' : (language || config.voice.sttLanguage);
    if (chosenLanguage) form.append('language', chosenLanguage);
    const res = await fetchWithSttRetry(this.fetch, 'https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.providers.openai.apiKey}` },
      body: form,
      signal: withTimeout(config.voice.sttTimeoutMs, signal),
    }, { maxAttempts: 2 });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenAI transcription error ${res.status} - ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    return String(data?.text ?? '').trim();
  }

  async _geminiTranscribe(audioBuffer, mime, signal, language = 'auto') {
    const model = config.voice.sttGeminiModel || config.providers.gemini.model;
    const res = await fetchWithSttRetry(this.fetch,
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.providers.gemini.apiKey },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: `${config.voice.sttContextPrompt} ${language === 'ig' ? 'The user selected Igbo; prioritize faithful Igbo transcription and preserve any English/Pidgin words that are spoken.' : language === 'en' ? 'The user selected English/Nigerian Pidgin; transcribe the spoken English or Pidgin verbatim and preserve any Igbo words that are spoken.' : 'Automatically detect the language. The audio may mix Nigerian English, Nigerian Pidgin and Igbo within the same sentence; preserve code-switching and do not translate.'} Reply with only the spoken words and nothing else. If there is no speech, reply with an empty string.` },
              { inline_data: { mime_type: GEMINI_AUDIO_MIME[String(mime).split(';', 1)[0].trim().toLowerCase()] ?? 'audio/webm', data: Buffer.from(audioBuffer).toString('base64') } },
            ],
          }],
          generationConfig: { temperature: 0 },
        }),
        signal: withTimeout(config.voice.sttTimeoutMs, signal),
      },
      { maxAttempts: 2 }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Gemini transcription error ${res.status} - ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    return parts.map((p) => p?.text ?? '').join('').trim();
  }

  /**
   * Transcribe with provider fallback and latency hedging (Gemini first, OpenAI fallback).
   * @param {Buffer} audioBuffer
   * @param {{filename?: string, mime?: string}} [opts]
   * @returns {Promise<{text: string, provider: string, ms: number, attempts: Array<{provider: string, ok: boolean, error?: string, ms?: number}>}>}
   */
  async transcribe(audioBuffer, { filename = 'audio.webm', mime = 'audio/webm', language = null } = {}) {
    // Reject missing audio before making any billable provider request; never fabricate a transcript.
    if (!audioBuffer || !audioBuffer.length) {
      throw new Error('VoiceService: no audio was recorded; refusing to invent a transcript.');
    }
    const providers = this.sttProviders();
    if (!providers.length) {
      throw new Error('VoiceService: no speech-to-text provider configured. Set GEMINI_API_KEY and/or OPENAI_API_KEY.');
    }
    const requestedLanguage = ['auto', 'en', 'ig'].includes(language) ? language : null;
    const out = await runHedged(
      providers,
      (provider, signal) => (provider === 'openai'
        ? this._openaiTranscribe(audioBuffer, filename, signal, requestedLanguage ?? '', mime)
        : this._geminiTranscribe(audioBuffer, mime, signal, requestedLanguage ?? 'auto')),
      { hedgeMs: config.voice.sttHedgeMs, isUsable: (text) => typeof text === 'string' && text.length > 0, label: 'speech-to-text' }
    );
    return { text: out.value, provider: out.provider, ms: out.ms, attempts: out.attempts };
  }

  /** Back-compat: returns only the transcript string. */
  async speechToText(audioBuffer, filename = 'audio.webm', mime = 'audio/webm') {
    return (await this.transcribe(audioBuffer, { filename, mime })).text;
  }
}
