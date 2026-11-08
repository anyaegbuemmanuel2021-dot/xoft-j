import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribe } from '../public/js/voice/stt.js';

test('client retries a transient 502 using the exact same audio Blob', async () => {
  const originalFetch = globalThis.fetch;
  const audio = new Blob([Buffer.from('captured-audio')], { type: 'audio/webm' });
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(init.body);
    return requests.length === 1
      ? new Response('temporary gateway error', { status: 502, headers: { 'retry-after': '0' } })
      : new Response(JSON.stringify({ text: 'recovered speech', provider: 'gemini', ms: 180 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
  };
  try {
    const statuses = [];
    const transcript = await transcribe(audio, (status) => statuses.push(status), 'auto');
    assert.equal(transcript, 'recovered speech');
    assert.equal(requests.length, 2);
    assert.equal(requests[0], audio);
    assert.equal(requests[1], audio);
    assert.ok(statuses.some((status) => status.includes('same captured audio')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('client does not retry permanent transcription errors', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response('unsupported audio', { status: 415 });
  };
  try {
    await assert.rejects(() => transcribe(new Blob(['bad'], { type: 'text/plain' })), /returned 415/);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
