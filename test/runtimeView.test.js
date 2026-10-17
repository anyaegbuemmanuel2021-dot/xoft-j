import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The dashboard cannot run in a browser here, so this is a STATIC contract test: it verifies the view only calls tools and
// endpoints that really exist, and never bypasses the safety properties the design depends on.
const view = fs.readFileSync(new URL('../public/js/views/runtime.js', import.meta.url), 'utf8');
const tools = fs.readFileSync(new URL('../src/tools/builtins/runtimeTools.js', import.meta.url), 'utf8');
const deviceTools = fs.readFileSync(new URL('../src/tools/builtins/deviceTools.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

test('every tool the view invokes is a registered tool', () => {
  const used = [...view.matchAll(/tool\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(used.length >= 12);
  for (const n of new Set(used)) assert.ok(tools.includes(`'${n}'`) || deviceTools.includes(`name: '${n}'`), `view calls unknown tool ${n}`);
});

test('every endpoint the view calls exists on the server', () => {
  for (const [method, route] of [['get', '/api/runtime/devices'], ['post', '/api/runtime/halt'], ['post', '/api/tools/:name/execute'], ['post', '/api/devices/:id/permissions'], ['delete', '/api/devices/:id/permissions/:permission'], ['post', '/api/autonomy/domains/:domain'], ['delete', '/api/autonomy/domains/:domain'], ['get', '/api/autonomy/domains']]) {
    assert.ok(index.includes(`app.${method}('${route}'`), `${method.toUpperCase()} ${route} missing`);
  }
});

test('mutating UI actions use direct fetch, never the offline replay queue (no delayed delete/undo/terminal)', () => {
  assert.doesNotMatch(view, /api\.(post|put|patch|del)\(/);
  assert.match(view, /fetch\(/);
});

test('the view has no remote-resume and no workspace-add control (both are human-local by design)', () => {
  assert.doesNotMatch(view, /\/api\/runtime\/resume/);
  assert.doesNotMatch(view, /workspace_add|add-workspace'\s*\)|\/api\/runtime\/workspace/);
  assert.match(view, /--resume/); assert.match(view, /--add-workspace/); // documented as local commands instead
});

test('destructive buttons ask for confirmation first', () => {
  for (const marker of ["#rt-halt'", "[data-undo]'", "#o-undo'"]) {
    const i = view.indexOf(marker); assert.ok(i > 0, marker);
    assert.match(view.slice(i, i + 260), /window\.confirm\(/, `${marker} must confirm`);
  }
});

test('pre() helper escapes its input', () => assert.match(view, /const pre = \(t\) => `<pre[^`]*\$\{esc\(t\)\}/));

test('every server-provided field is passed through esc() before it is placed in HTML', () => {
  // Remove every esc(...) call and every "cond ? … : …" test expression, then nothing untrusted may remain interpolated.
  let stripped = view.replace(/pre\((?:[^()]|\([^()]*\))*\)/g, 'ESC') /* pre() escapes internally (asserted below) */.replace(/esc\((?:[^()]|\([^()]*\))*\)/g, 'ESC').replace(/\b[a-z]+(?:\?)?\.[A-Za-z]+ \?/g, 'COND ?');
  const leaks = [...stripped.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]).filter((x) => /\b[a-z]{1,2}\??\.(name|title|url|path|target|reason|text|content|error|message|snippet|root|tag|id|agent|missionId|base64)\b/.test(x));
  assert.deepEqual(leaks, []);
});
