// All microphone audio is transcribed by XOFT's server.
// Provider order and failover are handled server-side: OpenAI first, then Gemini.
// No browser-local Whisper model is downloaded or required.
import { voiceFetch } from './voice-status.js';

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
    throw new Error(`XOFT server transcription returned ${res.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`);
  }
  const data = await res.json();
  const text = String(data?.text || '').trim();
  if (!text) throw new Error('XOFT server returned an empty transcript. Try speaking closer to the microphone.');
  return { text, provider: data?.provider || 'server' };
}

/** Send a captured audio Blob to XOFT's server-side OpenAI → Gemini transcription pipeline. */
export async function transcribe(blob, onStatus = () => {}, language = 'auto') {
  if (!blob || !blob.size) throw new Error('No audio was recorded. Hold the phone closer and try again.');
  onStatus('Sending audio to XOFT…');
  const result = await transcribeOnServer(blob, language);
  onStatus(`Transcribed by XOFT (${result.provider})`);
  return result.text;
}
