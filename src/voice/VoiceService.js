import { config } from '../config/index.js';

/**
 * VoiceService - server-side STT and TTS. Both are plain API calls, so the caller
 * (web or mobile client) only sends/receives audio bytes over HTTP.
 *
 * STT: Whisper through the OpenAI API is the default; Gemini is the fallback. The order
 *      is configurable with STT_PROVIDER_ORDER (default "openai,gemini"). Each provider is
 *      tried in order and the first non-empty transcript wins.
 * TTS: ElevenLabs. The browser client falls back to the device voice if this fails.
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
      stt: { default: 'openai-whisper', providers: this.sttProviders(), configured: this.isSTTConfigured() },
      tts: { provider: 'elevenlabs', configured: this.isTTSConfigured(), fallback: 'browser' },
    };
  }

  /**
   * @param {string} text
   * @returns {Promise<Buffer>} MP3 audio bytes
   */
  async textToSpeech(text) {
    if (!this.isTTSConfigured()) {
      throw new Error('VoiceService: ELEVENLABS_API_KEY is not set.');
    }
    const spoken = String(text ?? '').trim().slice(0, MAX_TTS_CHARS);
    if (!spoken) throw new Error('VoiceService: text is empty.');
    const res = await this.fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voice.elevenLabsVoiceId)}`,
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
    return Buffer.from(await res.arrayBuffer());
  }

  async _openaiWhisper(audioBuffer, filename) {
    const form = new FormData();
    form.append('file', new Blob([audioBuffer]), filename);
    form.append('model', config.voice.sttOpenAiModel);
    form.append('response_format', 'json');
    const res = await this.fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.providers.openai.apiKey}` },
      body: form,
      signal: timeoutSignal(config.voice.sttTimeoutMs),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenAI Whisper error ${res.status} - ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    return String(data?.text ?? '').trim();
  }

  async _geminiTranscribe(audioBuffer, mime) {
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
        signal: timeoutSignal(config.voice.sttTimeoutMs),
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
   * Transcribe with provider fallback.
   * @param {Buffer} audioBuffer
   * @param {{filename?: string, mime?: string}} [opts]
   * @returns {Promise<{text: string, provider: string, attempts: Array<{provider: string, ok: boolean, error?: string}>}>}
   */
  async transcribe(audioBuffer, { filename = 'audio.webm', mime = 'audio/webm' } = {}) {
    const providers = this.sttProviders();
    if (!providers.length) {
      throw new Error('VoiceService: no speech-to-text provider configured. Set OPENAI_API_KEY (Whisper) and/or GEMINI_API_KEY.');
    }
    const attempts = [];
    for (const provider of providers) {
      try {
        const text = provider === 'openai'
          ? await this._openaiWhisper(audioBuffer, filename)
          : await this._geminiTranscribe(audioBuffer, mime);
        if (text) {
          attempts.push({ provider, ok: true });
          return { text, provider, attempts };
        }
        attempts.push({ provider, ok: false, error: 'empty transcript' });
      } catch (err) {
        attempts.push({ provider, ok: false, error: err.message });
      }
    }
    const summary = attempts.map((a) => `${a.provider}: ${a.error}`).join('; ');
    const error = new Error(`VoiceService: speech-to-text failed (${summary}).`);
    error.attempts = attempts;
    throw error;
  }

  /** Back-compat: returns only the transcript string. */
  async speechToText(audioBuffer, filename = 'audio.webm', mime = 'audio/webm') {
    return (await this.transcribe(audioBuffer, { filename, mime })).text;
  }
}
