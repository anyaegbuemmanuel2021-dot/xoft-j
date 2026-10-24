// Cached view of GET /api/voice/status so the client picks a path without a failed paid call first.
let cached = null;
let cachedAt = 0;
const TTL_MS = 60_000;
let keyPrompt = null;

export function apiHeaders(extra = {}) {
  let key = '';
  try { key = localStorage.getItem('xoft_api_key') || ''; } catch { /* storage may be unavailable */ }
  return { ...(key ? { 'X-API-Key': key } : {}), ...extra };
}

// Voice calls bypass api.js, so mirror its API-key challenge flow here. Without this,
// an authenticated deployment silently falls back to local Whisper instead of asking for the key.
export async function voiceFetch(url, options = {}) {
  let headers = apiHeaders(options.headers || {});
  let response = await fetch(url, { ...options, headers, cache: options.cache || 'no-store' });
  if (response.status !== 401) return response;

  if (!keyPrompt) {
    keyPrompt = Promise.resolve().then(() => {
      const entered = window.prompt('XOFT requires an API key. Enter your API key:');
      if (!entered || !entered.trim()) throw new Error('XOFT API key is required for server voice features.');
      const key = entered.trim();
      localStorage.setItem('xoft_api_key', key);
      return key;
    }).finally(() => { keyPrompt = null; });
  }
  const key = await keyPrompt;
  headers = { ...headers, 'X-API-Key': key };
  response = await fetch(url, { ...options, headers, cache: options.cache || 'no-store' });
  if (response.status === 401) {
    try { localStorage.removeItem('xoft_api_key'); } catch { /* storage unavailable */ }
    throw new Error('XOFT API key was rejected. Check the key in your deployment settings.');
  }
  return response;
}

export async function getVoiceStatus({ force = false } = {}) {
  if (!force && cached && Date.now() - cachedAt < TTL_MS) return cached;
  try {
    const res = await voiceFetch('/api/voice/status', { method: 'GET' });
    if (res.ok) {
      cached = await res.json();
      cachedAt = Date.now();
      return cached;
    }
  } catch (error) {
    // Keep status unknown on auth/network errors; callers still attempt server STT once.
    console.warn('[XOFT] Voice status unavailable:', error?.message || error);
  }
  return cached ?? { stt: { configured: true, providers: [] }, tts: { configured: true }, unknown: true };
}

export function invalidateVoiceStatus() { cached = null; cachedAt = 0; }
