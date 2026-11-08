import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const overview = fs.readFileSync(new URL('../public/js/views/overview.js', import.meta.url), 'utf8');

test('Overview fetches readiness and warns when persistent storage is not verified', () => {
  assert.match(overview, /api\.get\('\/readyz'\)\.catch\(\(\) => null\)/);
  assert.match(overview, /persistence\?\.durable/);
  assert.match(overview, /Data protection warning/);
  assert.match(overview, /may be lost after a restart or redeploy/);
});

test('Overview does not claim storage is durable when readiness cannot be fetched', () => {
  assert.match(overview, /const persistenceNotice = persistence\?\.durable/);
  assert.match(overview, /role="alert"/);
});
