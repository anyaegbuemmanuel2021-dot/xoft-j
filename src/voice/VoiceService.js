import { config } from '../config/index.js';

/**
 * VoiceService - server-side STT and TTS. Both are plain API calls, so the caller
 * (web or mobile client) only sends/receives audio bytes over HTTP.
 *
 * STT: Whisper through the OpenAI API is the default; Gemini is the fallback. The order
 *      is configurable with STT_PROVIDER_ORDER (default "openai,gemini"). The first provider starts
 *      immediately; if it fails/returns nothing the next starts at once, and if it is merely SLOW
 *      (STT_HEDGE_MS, default 1000) the next starts in parallel. The first non-empty transcript wins
 *      and the slower request is aborted, so a hung provider never costs the full timeout.
 * TTS: ElevenLabs (flash model, small MP3). The browser client falls back to the device voice if this fails.
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

function timeoutSignal(ms) {
  return AbortSignal.timeout(ms);
}

/** Timeout that can also be cancelled by the caller (used to drop the losing STT request). */
function withTimeout(ms, signal) {
  return signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms);
}

export class VoiceService {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetch = fetchImpl;
  }

  isTTSConfigured() {
    return Boolean(config.voice.elevenLabsApiKey);
  }

  /** Providers that are both in the configured order and have credentials. */
  sttProviders() {
    const available = {
      openai: Boolean(config.providers.openai.apiKey),
      gemini: Boolean(config.providers.gemini.apiKey),
    };
    const order = config.voice.sttProviderOrder.filter((name) => name in available);
    // Anything configured but missing from the order list is appended, so a typo cannot disable STT.
    for (const name of Object.keys(available)) if (!order.includes(name)) order.push(name);
    return order.filter((name) => available[name]);
  }

  isSTTConfigured() {
    return this.sttProviders().length > 0;
  }

  status() {
    return {
      stt: { default: 'openai-whisper', providers: this.sttProviders(), configured: this.isSTTConfigured(), hedgeMs: config.voice.sttHedgeMs },
      tts: { provider: 'elevenlabs', configured: this.isTTSConfigured(), fallback: 'browser', streaming: true },
    };
  }

  async _ttsRequest(text) {
    if (!this.isTTSConfigured()) {
      throw new Error('VoiceService: ELEVENLABS_API_KEY is not set.');
    }
    const spoken = String(text ?? '').trim().slice(0, MAX_TTS_CHARS);
    if (!spoken) throw new Error('VoiceService: text is empty.');
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
          text: spoken,
          model_id: config.voice.elevenLabsModel,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
        signal: timeoutSignal(config.voice.ttsTimeoutMs),
      }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`VoiceService: ElevenLabs API error ${res.status} - ${errText.slice(0, 300)}`);
    }
    return res;
  }

  /**
   * Streaming TTS: resolves as soon as ElevenLabs starts answering, so the caller can pipe the first audio
   * bytes to the client instead of waiting for the whole clip.
   * @param {string} text
   * @returns {Promise<{ body: ReadableStream<Uint8Array>|null, contentType: string }>}
   */
  async textToSpeechStream(text) {
    const res = await this._ttsRequest(text);
    return { body: res.body ?? null, contentType: 'audio/mpeg', response: res };
  }

  /**
   * @param {string} text
   * @returns {Promise<Buffer>} MP3 audio bytes
   */
  async textToSpeech(text) {
    const res = await this._ttsRequest(text);
    return Buffer.from(await res.arrayBuffer());
  }

  async _openaiWhisper(audioBuffer, filename, signal) {
    const form = new FormData();
    form.append('file', new Blob([audioBuffer]), filename);
    form.append('model', config.voice.sttOpenAiModel);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (config.voice.sttLanguage) form.append('language', config.voice.sttLanguage);
    const res = await this.fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.providers.openai.apiKey}` },
      body: form,
      signal: withTimeout(config.voice.sttTimeoutMs, signal),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenAI Whisper error ${res.status} - ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    return String(data?.text ?? '').trim();
  }

  async _geminiTranscribe(audioBuffer, mime, signal) {
    const model = config.voice.sttGeminiModel || config.providers.gemini.model;
    const res = await this.fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.providers.gemini.apiKey },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: 'Transcribe this audio verbatim. Reply with only the spoken words and nothing else. If there is no speech, reply with an empty string.' },
              { inline_data: { mime_type: GEMINI_AUDIO_MIME[mime] ?? 'audio/webm', data: Buffer.from(audioBuffer).toString('base64') } },
            ],
          }],
          generationConfig: { temperature: 0 },
        }),
        signal: withTimeout(config.voice.sttTimeoutMs, signal),
      }
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
   * Transcribe with provider fallback and latency hedging.
   * @param {Buffer} audioBuffer
   * @param {{filename?: string, mime?: string}} [opts]
   * @returns {Promise<{text: string, provider: string, ms: number, attempts: Array<{provider: string, ok: boolean, error?: string, ms?: number}>}>}
   */
  async transcribe(audioBuffer, { filename = 'audio.webm', mime = 'audio/webm' } = {}) {
    const providers = this.sttProviders();
    if (!providers.length) {
      throw new Error('VoiceService: no speech-to-text provider configured. Set OPENAI_API_KEY (Whisper) and/or GEMINI_API_KEY.');
    }
    const startedAt = Date.now();
    const hedgeMs = config.voice.sttHedgeMs;
    const attempts = [];
    const controllers = new Map();

    return new Promise((resolve, reject) => {
      let nextIndex = 0;
      let pending = 0;
      let settled = false;
      let hedgeTimer = null;

      const sortedAttempts = () => [...attempts].sort((a, b) => providers.indexOf(a.provider) - providers.indexOf(b.provider));
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
        const run = provider === 'openai'
          ? this._openaiWhisper(audioBuffer, filename, controller.signal)
          : this._geminiTranscribe(audioBuffer, mime, controller.signal);
        run.then((text) => ({ text, error: null }), (error) => ({ text: '', error })).then(({ text, error }) => {
          pending -= 1;
          if (settled) return; // lost the race; its request was aborted
          const ms = Date.now() - t0;
          if (text) {
            settled = true;
            clearHedge();
            attempts.push({ provider, ok: true, ms });
            for (const [name, c] of controllers) if (name !== provider) c.abort();
            resolve({ text, provider, ms: Date.now() - startedAt, attempts: sortedAttempts() });
            return;
          }
          attempts.push({ provider, ok: false, error: error ? error.message : 'empty transcript', ms });
          if (nextIndex < providers.length) startNext(); // failed or empty: do not wait for the hedge timer
          armHedge();
          if (pending === 0 && nextIndex >= providers.length) {
            settled = true;
            clearHedge();
            const list = sortedAttempts();
            const summary = list.map((a) => `${a.provider}: ${a.error}`).join('; ');
            const err = new Error(`VoiceService: speech-to-text failed (${summary}).`);
            err.attempts = list;
            reject(err);
          }
        });
      };

      startNext();
      armHedge();
    });
  }

  /** Back-compat: returns only the transcript string. */
  async speechToText(audioBuffer, filename = 'audio.webm', mime = 'audio/webm') {
    return (await this.transcribe(audioBuffer, { filename, mime })).text;
  }
}
