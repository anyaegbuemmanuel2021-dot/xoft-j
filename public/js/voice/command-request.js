// Small, testable HTTP boundary for voice commands. The caller owns the AbortController.
export async function postVoiceCommand({
  fetchImpl = globalThis.fetch,
  headers = {},
  sessionId,
  message,
  signal,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable; XOFT could not submit the voice command.');
  const response = await fetchImpl('/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ sessionId, message }),
    cache: 'no-store',
    signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(String(body?.error || body?.message || `XOFT chat returned HTTP ${response.status}`));
    error.status = response.status;
    throw error;
  }
  return body;
}
