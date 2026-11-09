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

function abortError() { return new DOMException('Transcription cancelled.', 'AbortError'); }
function throwIfAborted(signal) { if (signal?.aborted) throw abortError(); }
function wait(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', cancelled); resolve(); };
    const timer = setTimeout(done, ms);
    const cancelled = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancelled); reject(abortError()); };
    signal?.addEventListener('abort', cancelled, { once: true });
  });
}
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

async function transcribeOnServer(blob, language = 'auto', externalSignal) {
  throwIfAborted(externalSignal);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener('abort', forwardAbort, { once: true });
  // Keep the timeout active until the response body has been consumed, not merely until headers arrive.
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await voiceFetch('/api/voice/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm', 'X-Xoft-STT-Language': language },
      body: blob,
      cache: 'no-store',
      signal: controller.signal,
    });
    throwIfAborted(externalSignal);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throwIfAborted(externalSignal);
      let payload = null;
      try { payload = detail ? JSON.parse(detail) : null; } catch { /* plain-text server error */ }
      const reason = payload?.message || payload?.error || detail.slice(0, 240);
      const error = new Error(`XOFT server transcription returned ${res.status}${reason ? `: ${reason}` : ''}`);
      error.status = res.status;
      error.code = payload?.error || null;
      error.retryable = payload?.retryable === false ? false : RETRYABLE_HTTP.has(res.status);
      const retryAfter = res.headers?.get?.('retry-after');
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(parsed) && parsed >= 0) error.retryAfterMs = parsed;
      }
      throw error;
    }
    const data = await res.json();
    throwIfAborted(externalSignal);
    const text = String(data?.text || '').trim();
    if (!text) throw new Error('XOFT server returned an empty transcript. Try speaking closer to the microphone.');
    return {
      text,
      provider: data?.provider || 'server',
      ms: Number.isFinite(Number(data?.ms)) ? Number(data.ms) : null,
    };
  } catch (error) {
    if (externalSignal?.aborted) throw abortError();
    if (error?.name === 'AbortError') throw new Error('XOFT server transcription timed out after 60 seconds. Check the server and try again.');
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
}

/** Send a captured audio Blob to XOFT's server-side Gemini → OpenAI transcription pipeline. */
export async function transcribe(blob, onStatus = () => {}, language = 'auto', { signal } = {}) {
  if (!blob || !blob.size) throw new Error('No audio was recorded. Hold the phone closer and try again.');
  throwIfAborted(signal);
  onStatus('Sending audio to XOFT…');
  let result;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    onStatus(attempt === 0 ? 'Transcribing on XOFT server…' : 'Retrying transcription with the same captured audio…');
    try {
      // Reuse the exact Blob on retry: a temporary server/network error must not discard the recording.
      result = await transcribeOnServer(blob, language, signal);
      break;
    } catch (error) {
      const retryable = error?.retryable || (!error?.status && error?.name !== 'AbortError');
      if (!retryable || attempt === 1) throw error;
      await wait(retryDelayMs(error, attempt), signal);
    }
  }
  throwIfAborted(signal);
  onStatus(result.ms === null
    ? `Transcribed by XOFT (${result.provider})`
    : `Transcribed by XOFT (${result.provider}) in ${Math.round(result.ms)} ms`);
  return result.text;
}

/** Decode Android AudioRecord's base64 WAV payload and use the same server-side Gemini → OpenAI pipeline. */
export async function transcribeNativeAudio(base64, language = 'auto', onStatus = () => {}, options = {}) {
  if (typeof base64 !== 'string' || !base64.length) throw new Error('Native audio payload is empty.');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'audio/wav' });
  return transcribe(blob, onStatus, language, options);
}
