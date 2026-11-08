import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ExperientialProvider } from '../src/providers/ExperientialProvider.js';

// No EXPERIENTIAL_* env vars are set in this file/process — the default
// state for the whole test suite, matching a fresh checkout with no .env.

describe('ExperientialProvider — unconfigured (no API key)', () => {
  test('isConfigured() is false with no EXPERIENTIAL_API_KEY', () => {
    assert.equal(new ExperientialProvider().isConfigured(), false);
  });

  test('complete() refuses to run rather than silently no-op or fabricate a response', async () => {
    const provider = new ExperientialProvider({ fetchImpl: async () => { throw new Error('must not be called'); } });
    await assert.rejects(
      () => provider.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      /EXPERIENTIAL_API_KEY is not set/,
    );
  });

  test('listModels() falls back to the public, unauthenticated catalog when no key is configured', async () => {
    let capturedUrl, capturedInit;
    const fetchImpl = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, json: async () => ({ data: [{ id: 'public-model' }] }) };
    };
    const provider = new ExperientialProvider({ fetchImpl });
    const models = await provider.listModels();
    assert.equal(capturedUrl, 'https://api.experientiallabs.ai/api/models?limit=200');
    assert.deepEqual(capturedInit.headers, {}, 'no Authorization header should be sent without a key');
    assert.deepEqual(models, [{ id: 'public-model' }]);
  });
});
