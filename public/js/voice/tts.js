// Server-generated XOFT TTS client. Audio is synthesized by Gemini/OpenAI on the server;
// this module only downloads the finished/streamed audio for local playback.
export async function fetchSpeechAudio(text, {
  fetchImpl = globalThis.fetch,
  requestHeaders = {},
  signal,
} = {}) {
  const spoken = String(text ?? '').trim().slice(0, 4000);
  if (!spoken) throw new Error('There is no reply text to speak.');
  const response = await fetchImpl('/api/voice/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...requestHeaders },
    body: JSON.stringify({ text: spoken }),
    cache: 'no-store',
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`XOFT server TTS returned ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ''}`);
  }
  const audio = await response.blob();
  if (!audio?.size) throw new Error('XOFT server TTS returned empty audio.');
  return {
    audio,
    provider: response.headers?.get?.('X-Xoft-TTS-Provider') || 'server',
    contentType: audio.type || response.headers?.get?.('Content-Type') || 'audio/mpeg',
  };
}
