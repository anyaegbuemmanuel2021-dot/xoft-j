import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const RETIRED = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash-lite-001',
];

function loadModel(model) {
  const env = { ...process.env, GEMINI_MODEL: model };
  // Avoid inheriting secrets/config from the test runner. The config module
  // should still load with no API keys and should select the safe model.
  delete env.GEMINI_API_KEY;
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "import { config } from './src/config/index.js'; process.stdout.write(config.providers.gemini.model)",
  ], { cwd: process.cwd(), env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return { model: result.stdout, warning: result.stderr };
}

test('defaults to the current XOFT Gemini model when GEMINI_MODEL is unset', () => {
  const env = { ...process.env };
  delete env.GEMINI_MODEL;
  delete env.GEMINI_API_KEY;
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "import { config } from './src/config/index.js'; process.stdout.write(config.providers.gemini.model)",
  ], { cwd: process.cwd(), env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stdout, 'gemini-3.8-flash');
});

test('migrates every shut-down Gemini 2.0 Flash model ID to the current default', () => {
  for (const retired of RETIRED) {
    const result = loadModel(retired);
    assert.equal(result.model, 'gemini-3.8-flash', retired);
    assert.match(result.warning, /has been retired/);
  }
});

test('preserves an explicitly configured non-retired Gemini model', () => {
  assert.equal(loadModel('gemini-2.5-flash').model, 'gemini-2.5-flash');
});
