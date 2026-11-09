import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import { buildRuntimeTools } from '../src/tools/builtins/runtimeTools.js';

function setup() {
  const calls = [];
  const registry = new ToolRegistry();
  for (const tool of buildRuntimeTools({
    deviceManager: { execute: async (command) => { calls.push(command); return { accepted: true }; } },
  })) registry.register(tool);
  return { registry, calls };
}

test('browser navigation rejects non-http URLs before reaching the device', async () => {
  const { registry, calls } = setup();
  await assert.rejects(
    registry.execute('browser_navigate', { deviceId: 'device-1', url: 'javascript:alert(1)' }),
    /invalid input/,
  );
  await assert.rejects(
    registry.execute('browser_new_tab', { deviceId: 'device-1', url: 'file:///etc/passwd' }),
    /invalid input/,
  );
  assert.equal(calls.length, 0);
});

test('browser locator requires exactly one non-empty selector or text', async () => {
  const { registry, calls } = setup();
  await assert.rejects(
    registry.execute('browser_query', { deviceId: 'device-1', locator: {} }),
    /invalid input/,
  );
  await assert.rejects(
    registry.execute('browser_query', { deviceId: 'device-1', locator: { selector: '#ok', text: 'also set' } }),
    /invalid input/,
  );
  await assert.rejects(
    registry.execute('browser_query', { deviceId: 'device-1', locator: { selector: '' } }),
    /invalid input/,
  );
  assert.equal(calls.length, 0);
});

test('valid browser locator and HTTPS URL reach the device runtime', async () => {
  const { registry, calls } = setup();
  await registry.execute('browser_navigate', { deviceId: 'device-1', url: 'https://example.com' });
  await registry.execute('browser_query', { deviceId: 'device-1', locator: { selector: 'main', index: 0 } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].parameters.url, 'https://example.com');
  assert.deepEqual(calls[1].parameters.locator, { selector: 'main', index: 0 });
});
