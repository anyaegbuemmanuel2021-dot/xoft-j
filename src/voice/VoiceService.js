import { config } from '../config/index.js';

/**
 * VoiceService — real TTS/STT. Both are plain API calls, so both work
 * server-side with no microphone/speaker needed here — the caller (a web
 * or mobile client) sends/receives audio bytes over HTTP.
 *
 * What's NOT here, because it genuinely needs a client with mic/speaker
 * access: wake-word detection, voice activity detection, streaming
 * playback, and the "hey XOFT" always-listening loop. Those belong in
 * the client app, calling these two endpoints.
 */
export class VoiceService {
  isTTSConfigured() {
    return Boolean(config.voice.elevenLabsApiKey);
  }

  isSTTConfigured() {
    return Boolean(config.providers.openai.apiKey);
  }

  /**
   * @param {string} text
   * @returns {Promise<Buffer>} MP3 audio bytes
   */
  async textToSpeech(text) {
    if (!this.isTTSConfigured()) {
      throw new Error('VoiceService: ELEVENLABS_API_KEY is not set.');
    }
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${config.voice.elevenLabsVoiceId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': config.voice.elevenLabsApiKey,
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`VoiceService: ElevenLabs API error ${res.status} - ${errText}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  /**
   * @param {Buffer} audioBuffer
   * @param {string} filename e.g. 'audio.webm' — used for the multipart content type hint
   * @returns {Promise<string>} transcribed text
   */
  async speechToText(audioBuffer, filename = 'audio.webm') {
    if (!this.isSTTConfigured()) {
      throw new Error('VoiceService: OPENAI_API_KEY is not set (Whisper rides on the OpenAI key).');
    }
    const form = new FormData();
    form.append('file', new Blob([audioBuffer]), filename);
    form.append('model', 'whisper-1');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.providers.openai.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`VoiceService: Whisper API error ${res.status} - ${errText}`);
    }
    const data = await res.json();
    return data.text;
  }
}
