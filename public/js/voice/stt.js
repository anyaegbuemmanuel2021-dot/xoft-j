// All microphone audio is transcribed by XOFT's server.
// Provider order and failover are handled server-side: Gemini first, then OpenAI.
// No browser-local Whisper model is downloaded or required.
import { voiceFetch } from './voice-status.js';

let warmRequest = null;
const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

function retryDelayMs(error, attempt) {
  if (Number.isFinite(error?.retryAfterMs)) return Math.min(1500, Math.max(0, error.retryAfterMs));
  return 300 * (2 ** attempt);
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
/** Start Render's wake-up request as soon as the user starts speaking; never block recording on it. */
export function warmVoiceServer() {
  if (warmRequest) return warmRequest;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  warmRequest = fetch('/healthz', { method: 'GET', cache: 'no-store', signal: controller.signal })
    .catch(() => null)
    .finally(() => { clearTimeout(timer); warmRequest = null; });
  return warmRequest;
}

async function transcribeOnServer(blob, language = 'auto') {
  const controller = new AbortController();
  // A sleeping Render free instance can take time to wake. Allow the request to reach it.
  const timer = setTimeout(() => controller.abort(), 60000);
  let res;
  try {
    res = await voiceFetch('/api/voice/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm', 'X-Xoft-STT-Language': language },
      body: blob,
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('XOFT server transcription timed out after 60 seconds. Check the server and try again.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const error = new Error(`XOFT server transcription returned ${res.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`);
    error.status = res.status;
    error.retryable = RETRYABLE_HTTP.has(res.status);
    const retryAfter = res.headers?.get?.('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
      if (Number.isFinite(parsed) && parsed >= 0) error.retryAfterMs = parsed;
    }
    throw error;
  }
  const data = await res.json();
  const text = String(data?.text || '').trim();
  if (!text) throw new Error('XOFT server returned an empty transcript. Try speaking closer to the microphone.');
  return {
    text,
    provider: data?.provider || 'server',
    ms: Number.isFinite(Number(data?.ms)) ? Number(data.ms) : null,
  };
}

/** Send a captured audio Blob to XOFT's server-side Gemini → OpenAI transcription pipeline. */
export async function transcribe(blob, onStatus = () => {}, language = 'auto') {
  if (!blob || !blob.size) throw new Error('No audio was recorded. Hold the phone closer and try again.');
  onStatus('Sending audio to XOFT…');
  let result;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    onStatus(attempt === 0 ? 'Transcribing on XOFT server…' : 'Retrying transcription with the same captured audio…');
    try {
      // Reuse the exact Blob on retry: a temporary server/network error must not discard the recording.
      result = await transcribeOnServer(blob, language);
      break;
    } catch (error) {
      const retryable = error?.retryable || (!error?.status && error?.name !== 'AbortError');
      if (!retryable || attempt === 1) throw error;
      await wait(retryDelayMs(error, attempt));
    }
  }
  onStatus(result.ms === null
    ? `Transcribed by XOFT (${result.provider})`
    : `Transcribed by XOFT (${result.provider}) in ${Math.round(result.ms)} ms`);
  return result.text;
}
