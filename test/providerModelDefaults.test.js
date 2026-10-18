import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function loadDefaults() {
  const env = { ...process.env };
  for (const key of [
    'OPENAI_CHAT_MODEL', 'OPENAI_FAST_MODEL', 'OPENAI_EMBEDDING_MODEL',
    'OPENAI_MODEL_FLAGSHIP', 'OPENAI_MODEL_BALANCED', 'OPENAI_MODEL_EFFICIENT', 'OPENAI_MODEL_CODING', 'OPENAI_MODEL_BUDGET',
    'GEMINI_MODEL', 'ANTHROPIC_MODEL', 'XAI_MODEL',
    'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY',
  ]) delete env[key];
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "import { config } from './src/config/index.js'; process.stdout.write(JSON.stringify({openai: config.providers.openai.chatModel, openaiFast: config.providers.openai.fastModel, openaiModels: config.providers.openai.models, gemini: config.providers.gemini.model, claude: config.providers.claude.model, grok: config.providers.xai.model}))",
  ], { cwd: process.cwd(), env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

test('default provider model IDs match the repository configuration baseline', () => {
  assert.deepEqual(loadDefaults(), {
    openai: 'gpt-6-astra',
    openaiFast: 'gpt-6-luna',
    openaiModels: { flagship: 'gpt-6-astra', balanced: 'gpt-6.1-sol', efficient: 'gpt-6-luna', coding: 'gpt-5.6-sol', budget: 'gpt-5.6-terra' },
    gemini: 'gemini-3.8-flash',
    claude: 'claude-sonnet-5',
    grok: 'grok-4.7',
  });
});
