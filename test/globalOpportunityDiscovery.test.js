import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/index.js';
import { buildResearchTools } from '../src/tools/builtins/researchTools.js';

const originalFetch = globalThis.fetch;
const originalKey = config.search.braveApiKey;
afterEach(() => {
  globalThis.fetch = originalFetch;
  config.search.braveApiKey = originalKey;
});

test('worldwide opportunity search annotates eligibility as unverified', async () => {
  config.search.braveApiKey = 'test-brave-key';
  const requested = [];
  globalThis.fetch = mock.fn(async (url) => {
    requested.push(String(url));
    return { ok: true, json: async () => ({ web: { results: [
      { title: 'Remote software role', url: 'https://example.com/jobs/1', description: 'International applicants welcome' },
      { title: 'Freelance contract', url: 'https://example.com/jobs/2', description: 'Contract opportunity' },
    ] } }) };
  });
  const tool = buildResearchTools().find((candidate) => candidate.name === 'search_global_opportunities');
  assert.ok(tool);
  const result = await tool.run({ skills: 'frontend developer', categories: ['jobs', 'freelance'], applicantCountry: 'Nigeria' });
  assert.equal(result.scope, 'worldwide');
  assert.equal(result.applicantCountry, 'Nigeria');
  assert.equal(result.count, 2);
  assert.equal(requested.length, 2);
  assert.ok(result.results.every((item) => item.eligibilityStatus === 'UNVERIFIED'));
  assert.ok(result.results.every((item) => item.verificationChecklist.some((entry) => /work-authorisation/i.test(entry))));
  assert.match(result.warning, /not verified offers/i);
});

test('worldwide opportunity search rejects unsupported categories', async () => {
  config.search.braveApiKey = 'test-brave-key';
  const tool = buildResearchTools().find((candidate) => candidate.name === 'search_global_opportunities');
  await assert.rejects(() => tool.run({ skills: 'designer', categories: ['made-up-category'] }), /Choose at least one supported opportunity category/);
});
