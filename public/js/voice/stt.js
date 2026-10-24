// Single speech-to-text path used by every view.
// Order: XOFT server (OpenAI Whisper, then Gemini - chosen by the server) -> on-device Whisper (free, private).
import { voiceFetch, getVoiceStatus, invalidateVoiceStatus } from './voice-status.js';
import { transcribeAudioBlob as transcribeLocally } from './whisper-fallback.js';

async function transcribeOnServer(blob) {
  const res = await voiceFetch('/api/voice/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'audio/webm' },
    body: blob,
    cache: 'no-store',
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 503) invalidateVoiceStatus();
    throw new Error(`Server speech recognition returned ${res.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`);
  }
  const data = await res.json();
  const text = String(data?.text || '').trim();
  if (!text) throw new Error('Server speech recognition returned an empty transcript.');
  return { text, provider: data?.provider || 'server' };
}

/**
 * @param {Blob} blob recorded audio
 * @param {(message: string) => void} [onStatus]
 * @returns {Promise<string>} transcript
 */
export async function transcribe(blob, onStatus = () => {}) {
  if (!blob || !blob.size) throw new Error('No audio was recorded. Hold the phone closer and try again.');

  let serverError = null;
  const status = await getVoiceStatus();
  if (status?.stt?.configured !== false) {
    try {
      onStatus('Transcribing with Whisper…');
      return (await transcribeOnServer(blob)).text;
    } catch (error) {
      serverError = error;
      console.warn('[XOFT] Server STT failed; falling back to on-device Whisper:', error);
    }
  } else {
    serverError = new Error('No server speech-to-text provider is configured (set OPENAI_API_KEY and/or GEMINI_API_KEY).');
  }

  try {
    onStatus('Server transcription unavailable · using on-device Whisper (first use downloads the model)…');
    return await transcribeLocally(blob);
  } catch (localError) {
    throw new Error(`${serverError?.message || 'Server speech recognition unavailable'}. On-device Whisper also failed: ${localError?.message || 'unknown error'}`);
  }
}