import test from 'node:test';
import assert from 'node:assert/strict';
import { VisionInterpreter } from '../src/vision/VisionInterpreter.js';

function fakeClaudeRouter(responseText) {
  return {
    selectVision: () => ({
      name: 'claude',
      complete: async ({ messages }) => {
        // sanity-check the message shape actually contains an image block
        const content = messages[0].content;
        assert.ok(Array.isArray(content));
        assert.ok(content.some((b) => b.type === 'image'));
        return { text: responseText };
      },
    }),
  };
}

test('VisionInterpreter parses a well-formed JSON response from the model', async () => {
  const json = JSON.stringify({
    application: 'Chrome',
    window: 'YouTube',
    elements: [{ type: 'textbox', label: 'Search', state: 'enabled', approxRegion: 'top-center' }],
    summary: 'Chrome is open on YouTube with the search box focused.',
  });
  const interpreter = new VisionInterpreter({ providerRouter: fakeClaudeRouter(json) });
  const result = await interpreter.interpretScreenshot({ base64: 'ZmFrZQ==', mimeType: 'image/png' });

  assert.equal(result.provider, 'claude');
  assert.equal(result.parseError, null);
  assert.equal(result.parsed.application, 'Chrome');
  assert.equal(result.confidence, 'model_reported');
});

test('VisionInterpreter handles a response wrapped in markdown fences', async () => {
  const json = '```json\n' + JSON.stringify({ application: 'VS Code', window: null, elements: [], summary: 'ok' }) + '\n```';
  const interpreter = new VisionInterpreter({ providerRouter: fakeClaudeRouter(json) });
  const result = await interpreter.interpretScreenshot({ base64: 'ZmFrZQ==' });
  assert.equal(result.parsed.application, 'VS Code');
});

test('VisionInterpreter reports a parse error honestly instead of fabricating structured data', async () => {
  const interpreter = new VisionInterpreter({ providerRouter: fakeClaudeRouter('not json at all') });
  const result = await interpreter.interpretScreenshot({ base64: 'ZmFrZQ==' });
  assert.equal(result.parsed, null);
  assert.ok(result.parseError);
  assert.equal(result.confidence, 'unparsed_response');
});

test('VisionInterpreter throws a clear error when no vision-capable provider is configured', async () => {
  const interpreter = new VisionInterpreter({
    providerRouter: {
      selectVision: () => {
        throw new Error('ProviderRouter: no vision-capable provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
      },
    },
  });
  await assert.rejects(() => interpreter.interpretScreenshot({ base64: 'ZmFrZQ==' }), /no vision-capable provider configured/);
});

test('VisionInterpreter requires image data', async () => {
  const interpreter = new VisionInterpreter({ providerRouter: fakeClaudeRouter('{}') });
  await assert.rejects(() => interpreter.interpretScreenshot({}), /base64 screenshot data is required/);
});
