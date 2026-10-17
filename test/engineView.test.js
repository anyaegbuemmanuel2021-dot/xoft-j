import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Static contract test (the dashboard cannot run in a browser here): the Engines view must only call endpoints that exist,
// must never use the offline replay queue for mutating actions, must escape everything it renders, and must be wired in.
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const view = read('../public/js/views/engines.js');
const routes = read('../src/engines/engineApi.js');
const index = read('../src/index.js');
const app = read('../public/js/app.js');
const sw = read('../public/sw.js');

test('every endpoint the view calls is registered by registerEngineRoutes', () => {
  const normalize = (p) => p.replace(/\$\{[^}]+\}/g, ':x').replace(/\?.*$/, '').replace(/:(id|approvalId|x)\b/g, ':x');
  const registered = [...routes.matchAll(/app\.(get|post|put)\('([^']+)'/g)].map(([, m, p]) => `${m.toUpperCase()} ${normalize(p)}`);
  const called = [...view.matchAll(/direct\('(GET|POST|PUT)', [`']([^`']+)[`']/g)].map(([, m, p]) => `${m} ${normalize(p)}`);
  const softs = [...view.matchAll(/soft\('([^']+)'/g)].map(([, p]) => `GET ${normalize(p)}`);
  assert.ok(called.length >= 12 && softs.length >= 3);
  for (const c of new Set([...called, ...softs])) assert.ok(registered.includes(c), `view calls ${c}, which is not registered (have: ${registered.join(' | ')})`);
});

test('mutating actions use direct fetch, never the offline replay queue', () => {
  assert.doesNotMatch(view, /api\.(post|put|patch|del)\(/);
  assert.doesNotMatch(view, /from '\.\.\/api\.js'/);
  assert.match(view, /fetch\(/);
});

test('rendering is escaped: every interpolated dynamic value goes through esc()/badge()/pre(); no raw innerHTML of API text', () => {
  // pre(...) escapes its whole argument, so interpolations on a line that builds a pre(`…`) block are already safe.
  const risky = [];
  for (const line of view.split('\n')) {
    if (/\bpre\(/.test(line)) continue;
    for (const m of line.matchAll(/\$\{([^}]+)\}/g)) {
      const x = m[1].trim();
      if (/\b(t|e|s|r|a|g|v|p)\.(goal|description|stateReason|error|reason|summary|statement|currentActivity|name|url|baseUrl|text)\b/.test(x) && !/esc\(|badge\(|fmtTime\(/.test(x)) risky.push(x);
    }
  }
  assert.deepEqual(risky, [], `unescaped dynamic values: ${risky.join(' ; ')}`);
  assert.doesNotMatch(view, /eval\(|new Function\(|document\.write/);
});

test('destructive controls confirm first, and approvals/stop/rollback are explicit buttons', () => {
  assert.match(view, /confirm\('Stop this task\?/);
  assert.match(view, /confirm\('Undo this task/);
  assert.match(view, /data-approve/); assert.match(view, /data-reject/);
});

test('the view is registered in the app, in the service-worker shell, and the engine routes are mounted by the server', () => {
  assert.match(app, /import \* as engines from '\.\/views\/engines\.js'/);
  assert.match(app, /\['engines', 'Engines', engines\]/);
  assert.match(sw, /\/js\/views\/engines\.js/);
  assert.match(sw, /xoft-shell-v6/);
  assert.match(index, /registerEngineRoutes\(app,/);
  assert.match(index, /registerToolGatewayRoute\(app,/);
});

test('UI shows what the spec asks for: engine status, fallback, tools, activity, pause/stop/logs', () => {
  for (const needle of ['Fallback:', 'Current activity:', 'data-task-act="pause"', 'data-task-act="cancel"', 'View logs', 'Filesystem', 'Terminal', 'Browser', 'Online', 'Offline', 'Starting', 'Busy', 'Error', 'Disabled']) assert.ok(view.includes(needle), needle);
});

test('settings form only exposes settings the server accepts', async () => {
  const { HERMES_DEFAULTS } = await import('../src/engines/hermes/hermesConfig.js');
  const sent = [...view.matchAll(/^\s{4}(?:enabled|autoStart|baseUrl|runtimePath|hermesHome|workingDirectory|allowedRoots|defaultAutonomy|permissionProfile|maxConcurrentTasks|timeoutMs|maxToolCalls|maxRetries|maxMemoryMb|nativeToolPolicy|workspaceMode|bridgeEnabled|bridgeDeviceId|logLevel):/gm)];
  assert.ok(sent.length > 0);
  const block = view.slice(view.indexOf('function readSettings'), view.indexOf('function eventLine'));
  const keys = [...block.matchAll(/\b([a-zA-Z]+): (?:b|n|v)\(/g)].map((m) => m[1]).concat([...block.matchAll(/\b(permissionProfile|allowedRoots|timeoutMs|baseUrl): /g)].map((m) => m[1]));
  for (const k of new Set(keys)) assert.ok(k in HERMES_DEFAULTS, `UI sends unsupported setting '${k}'`);
});
