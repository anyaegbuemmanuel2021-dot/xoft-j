import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeCommandEngine } from '../src/native/NativeCommandEngine.js';

test('native command engine parses only explicit deterministic commands', () => {
  const engine = new NativeCommandEngine();
  assert.deepEqual(engine.parse('what time is it?'), { tool: 'get_current_time', input: {} });
  assert.deepEqual(engine.parse('calculate 12 * (3 + 2)'), { tool: 'calculate', input: { expression: '12 * (3 + 2)' } });
  assert.equal(engine.parse('please help me plan a project'), null);
  assert.equal(engine.parse('calculate the meaning of life'), null);
  assert.equal(engine.parse('delete all files'), null);
});

test('native command engine executes allow-listed tools without a model', async () => {
  const calls = [];
  const engine = new NativeCommandEngine({
    toolRegistry: {
      has: (name) => ['calculate', 'get_current_time'].includes(name),
      execute: async (name, input) => { calls.push({ name, input }); return name === 'calculate' ? { result: 60 } : { formatted: '3:30 PM', timezone: 'Africa/Lagos' }; },
    },
  });
  const calculation = await engine.handle('what is 12 * 5');
  assert.equal(calculation.reply, '60');
  assert.equal(calculation.meta.success, true);
  const time = await engine.handle('what time is it');
  assert.match(time.reply, /Africa\/Lagos/);
  assert.equal(calls.length, 2);
});
