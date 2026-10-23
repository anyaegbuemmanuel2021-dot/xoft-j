// Cached view of GET /api/voice/status so the client picks a path without a failed paid call first.
let cached = null;
let cachedAt = 0;
const TTL_MS = 60_000;

export function apiHeaders(extra = {}) {
  let key = '';
  try { key = localStorage.getItem('xoft_api_key') || ''; } catch { /* storage may be unavailable */ }
  return { ...(key ? { 'X-API-Key': key } : {}), ...extra };
}

export async function getVoiceStatus({ force = false } = {}) {
  if (!force && cached && Date.now() - cachedAt < TTL_MS) return cached;
  try {
    const res = await fetch('/api/voice/status', { headers: apiHeaders(), cache: 'no-store' });
    if (res.ok) {
      cached = await res.json();
      cachedAt = Date.now();
      return cached;
    }
  } catch { /* offline or unreachable: assume nothing is configured */ }
  // Unknown: let callers try the server once; they still have a local/browser fallback.
  return cached ?? { stt: { configured: true, providers: [] }, tts: { configured: true }, unknown: true };
}

export function invalidateVoiceStatus() { cached = null; cachedAt = 0; }