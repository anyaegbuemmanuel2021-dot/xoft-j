import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSpeechAudio } from '../public/js/voice/tts.js';

test('server TTS posts bounded text and returns provider audio', async () => {
  let request;
  const audio = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });
  const result = await fetchSpeechAudio('  Hello XOFT  ', {
    requestHeaders: { 'X-API-Key': 'test-key' },
    fetchImpl: async (url, init) => {
      request = { url, init };
      return {
        ok: true,
        headers: { get: (name) => name.toLowerCase() === 'x-xoft-tts-provider' ? 'gemini' : 'audio/mpeg' },
        blob: async () => audio,
      };
    },
  });
  assert.equal(request.url, '/api/voice/speak');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers['X-API-Key'], 'test-key');
  assert.deepEqual(JSON.parse(request.init.body), { text: 'Hello XOFT' });
  assert.equal(result.provider, 'gemini');
  assert.equal(result.contentType, 'audio/mpeg');
  assert.equal(result.audio.size, 3);
});

test('server TTS rejects empty text without making a request', async () => {
  let called = false;
  await assert.rejects(
    fetchSpeechAudio('   ', { fetchImpl: async () => { called = true; } }),
    /There is no reply text to speak/
  );
  assert.equal(called, false);
});

test('server TTS reports provider HTTP errors', async () => {
  await assert.rejects(
    fetchSpeechAudio('Hello', {
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        text: async () => 'TTS_NOT_CONFIGURED',
      }),
    }),
    /returned 503: TTS_NOT_CONFIGURED/
  );
});

test('server TTS rejects an empty audio response', async () => {
  await assert.rejects(
    fetchSpeechAudio('Hello', {
      fetchImpl: async () => ({
        ok: true,
        headers: { get: () => 'gemini' },
        blob: async () => new Blob([]),
      }),
    }),
    /returned empty audio/
  );
});
