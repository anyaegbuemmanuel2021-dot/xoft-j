'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DeviceRuntime } = require('../src/runtime/DeviceRuntime');
const { dispatchCommand, CAPABILITIES } = require('../src/index');

function mkRuntime(extra = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-rt-')));
  const root = path.join(base, 'proj'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'app.js'), 'const x = 1;\n'); fs.writeFileSync(path.join(root, '.env'), 'TOKEN=abc');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"p","scripts":{"test":"node -e 0"}}');
  const config = { stateDir: path.join(base, 'state'), configPath: path.join(base, 'config.json'), pairingPath: path.join(base, 'pairing.json'), workspaces: [{ name: 'proj', root }], policy: {}, browser: { debugPort: 1 }, allowedRoots: [path.join(base, 'shared')], appAllowlist: {}, ...extra };
  const runtime = new DeviceRuntime({ config, logger: { warn() {}, log() {} } });
  return { base, root, config, runtime, cleanup: () => { runtime.stop(); fs.rmSync(base, { recursive: true, force: true }); } };
}
const cmd = (capability, action, parameters = {}) => ({ id: 'c1', capability, action, parameters });

test('agent reports the new capabilities alongside every legacy one (nothing removed)', () => {
  for (const c of ['system', 'applications', 'browser', 'files', 'media', 'screen', 'terminal', 'workspace', 'operations', 'runtime']) assert.ok(CAPABILITIES.includes(c), c);
});

test('end-to-end dispatch: locate → read → edit → journal → undo, with mission attribution', async (t) => {
  const e = mkRuntime(); t.after(e.cleanup);
  const D = (c) => dispatchCommand(c, e.config, e.runtime);
  const loc = await D(cmd('files', 'locate', { query: 'app' }));
  assert.equal(loc.success, true); assert.ok(loc.data.files.some((f) => f.path.endsWith('app.js')));
  const rd = await D(cmd('files', 'read', { path: 'app.js' }));
  assert.match(rd.data.content, /const x = 1/);
  const ed = await D(cmd('files', 'edit', { path: 'app.js', find: 'x = 1', replace: 'x = 2', _context: {} , reason: 'r' }));
  assert.equal(ed.success, true);
  const ed2 = await D({ ...cmd('files', 'edit', { path: 'app.js', find: 'x = 2', replace: 'x = 3', _context: { missionId: 'MISSION-7', agent: 'coder', reason: 'bump' } }) });
  const ops = await D(cmd('operations', 'list', {}));
  const op = ops.data.operations.find((o) => o.id === ed2.data.operationId);
  assert.equal(op.missionId, 'MISSION-7'); assert.equal(op.agent, 'coder');
  const tests = await D(cmd('files', 'record_tests', { operationId: ed2.data.operationId, tests: { command: 'npm test', passed: true } }));
  assert.equal(tests.success, true);
  const undo = await D(cmd('files', 'undo_last', {}));
  assert.equal(undo.success, true);
  assert.equal(fs.readFileSync(path.join(e.root, 'app.js'), 'utf8'), 'const x = 2;\n');
});

test('legacy files.list_files / applications / screen actions still fall through to the original handlers', async (t) => {
  const e = mkRuntime(); t.after(e.cleanup);
  assert.equal(await e.runtime.dispatch(cmd('files', 'list_files', { path: '.' })), null); // runtime does not claim it
  assert.equal(await e.runtime.dispatch(cmd('applications', 'list')), null);
  assert.equal(await e.runtime.dispatch(cmd('screen', 'capture')), null);
  assert.equal(await e.runtime.dispatch(cmd('browser', 'open_url', { url: 'https://a.test' })), null); // legacy open_url is deliberately NOT claimed by the CDP runtime
});

test('browser.open_url (legacy) is still handled by the original executor, not refused by the runtime', async (t) => {
  const e = mkRuntime(); t.after(e.cleanup);
  const r = await dispatchCommand(cmd('browser', 'open_url', { url: 'javascript:alert(1)' }), e.config, e.runtime);
  assert.equal(r.success, false); assert.match(r.error, /Refusing to open non-http/); // the ORIGINAL executor's message
});

test('unknown runtime actions and capabilities are refused honestly, never faked', async (t) => {
  const e = mkRuntime(); t.after(e.cleanup);
  const D = (c) => dispatchCommand(c, e.config, e.runtime);
  assert.match((await D(cmd('browser', 'execute_js', { code: 'alert(1)' }))).error, /does not implement browser\.execute_js/);
  assert.match((await D(cmd('terminal', 'shell', { command: 'ls' }))).error, /does not implement terminal\.shell/);
  assert.match((await D(cmd('bogus', 'thing'))).error, /does not implement bogus\.thing/);
  assert.match((await D(cmd('files', 'read', {}))).error, /'path' is required/);
});

test('SECURITY: a remote command cannot register a workspace, widen the sandbox, or pass force flags', async (t) => {
  const e = mkRuntime(); t.after(e.cleanup);
  const D = (c) => dispatchCommand(c, e.config, e.runtime);
  const add = await D(cmd('workspace', 'add', { name: 'evil', root: os.homedir() }));
  assert.equal(add.success, false); assert.match(add.error, /only possible locally/);
  assert.equal((await D(cmd('workspace', 'remove', { name: 'proj' }))).success, false);
  assert.equal(e.runtime.workspaces.list().length, 1);
  await D(cmd('files', 'edit', { path: 'app.js', find: 'x = 1', replace: 'x = 5' }));
  fs.writeFileSync(path.join(e.root, 'app.js'), 'human wrote this');
  const r = await D(cmd('files', 'undo_last', { force: true })); // force in parameters must be ignored
  assert.equal(r.success, false); assert.match(r.error, /changed since/);
  assert.equal(fs.readFileSync(path.join(e.root, 'app.js'), 'utf8'), 'human wrote this');
});

test('SECURITY: sensitive files stay unreadable through the full dispatch path; agent config is protected even inside a workspace', async (t) => {
  const e = mkRuntime(); t.after(e.cleanup);
  fs.writeFileSync(e.config.configPath, '{"apiKey":"leak-me"}');
  const D = (c) => dispatchCommand(c, e.config, e.runtime);
  assert.equal((await D(cmd('files', 'read', { path: '.env' }))).sensitive, true);
  const ws = e.runtime.workspaces; // even if a human registers the agent's own dir, config.json/pairing.json remain protected
  ws.add('base', e.base);
  const r = await D(cmd('files', 'read', { path: e.config.configPath }));
  assert.equal(r.success, false); assert.equal(r.sensitive, true);
});

test('KILL SWITCH: halt blocks every legacy AND new action except read-only status; resume restores', async (t) => {
  const e = mkRuntime(); t.after(e.cleanup);
  const D = (c) => dispatchCommand(c, e.config, e.runtime);
  assert.equal((await D(cmd('runtime', 'halt', { reason: 'test' }))).success, true);
  for (const c of [cmd('files', 'read', { path: 'app.js' }), cmd('screen', 'click', { x: 1, y: 1 }), cmd('applications', 'open_application', { application: 'x' }), cmd('browser', 'navigate', { url: 'https://a.test' }), cmd('terminal', 'run', { command: 'node', args: ['--version'] }), cmd('files', 'delete', { path: 'app.js' })]) {
    const r = await D(c); assert.equal(r.success, false, `${c.capability}.${c.action}`); assert.equal(r.blocked, true); assert.match(r.error, /HALTED/);
  }
  assert.ok(fs.existsSync(path.join(e.root, 'app.js')));
  const st = await D(cmd('runtime', 'status')); assert.equal(st.success, true); assert.equal(st.data.halted, true);
  e.runtime.halt.resume();
  assert.equal((await D(cmd('files', 'read', { path: 'app.js' }))).success, true);
});

test('terminal via dispatch obeys local policy: build=confirm refuses, safe runs', async (t) => {
  const e = mkRuntime(); t.after(e.cleanup);
  const D = (c) => dispatchCommand(c, e.config, e.runtime);
  assert.equal((await D(cmd('terminal', 'run', { command: 'node', args: ['--version'], cwd: '.' }))).success, true);
  const b = await D(cmd('terminal', 'run', { command: 'npm', args: ['test'], cwd: '.' }));
  assert.equal(b.blocked, true); assert.match(b.error, /requires human approval/);
});

test('health snapshot reports halted state, browser reachability, and operations interrupted by a crash/restart', async (t) => {
  const e = mkRuntime(); t.after(e.cleanup);
  e.runtime.journal.begin({ action: 'EDIT', target: '/x' }); // in flight in THIS process => pending, not interrupted
  assert.equal((await e.runtime.health()).interruptedOperations, 0);
  e.runtime.stop();
  const restarted = new DeviceRuntime({ config: e.config, logger: { warn() {}, log() {} } }); // process restart: the op never got an `end` record
  t.after(() => restarted.stop());
  const h = await restarted.health();
  assert.equal(h.halted, false); assert.equal(h.interruptedOperations, 1); assert.equal(h.browser.ok, false); assert.ok(h.browser.error);
});

test('browser recovery is bounded: 3 automatic attempts then it stops and asks for a human', async (t) => {
  const e = mkRuntime(); t.after(e.cleanup);
  const r = [];
  for (let i = 0; i < 4; i++) r.push(await e.runtime.recoverBrowser());
  assert.deepEqual(r.map((x) => x.success), [false, false, false, false]);
  assert.match(r[3].error, /recovery limit reached/);
  assert.doesNotMatch(r[2].error, /limit reached/);
});

test('applications.open_file: opens workspace files without a shell, refuses scripts/executables, sensitive files, outside paths, and disallowed apps', async (t) => {
  const calls = [];
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-open-'))); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'proj'); fs.mkdirSync(root);
  for (const f of ['notes.txt', 'run.bat', 'tool.js', 'x.ps1', '.env']) fs.writeFileSync(path.join(root, f), 'x');
  const config = { stateDir: path.join(base, 'state'), workspaces: [{ name: 'p', root }], policy: {}, browser: {}, appAllowlist: { notepad: { path: 'notepad-bin' } } };
  const spawnImpl = (exe, args, opts) => { calls.push({ exe, args, opts }); const ee = new (require('node:events'))(); setImmediate(() => ee.emit('spawn')); ee.unref = () => {}; return ee; };
  const rt = new DeviceRuntime({ config, logger: { warn() {} }, spawnImpl }); t.after(() => rt.stop());
  const open = (params) => rt.dispatch({ capability: 'applications', action: 'open_file', parameters: params });
  const ok = await open({ path: 'notes.txt' });
  assert.equal(ok.success, true); assert.equal(ok.verification.verified, false); // honest: we only know the launcher started
  assert.equal(calls[0].opts.shell, false); assert.equal(calls[0].args[0], path.join(root, 'notes.txt'));
  const withApp = await open({ path: 'notes.txt', application: 'notepad' });
  assert.equal(withApp.success, true); assert.equal(calls[1].exe, 'notepad-bin');
  for (const bad of ['run.bat', 'tool.js', 'x.ps1']) assert.match((await open({ path: bad })).error, /never launched/);
  assert.equal((await open({ path: '.env' })).sensitive, true);
  assert.match((await open({ path: path.join(base, 'outside.txt') })).error, /outside every registered workspace/);
  assert.match((await open({ path: 'notes.txt', application: 'malware' })).error, /not in appAllowlist/);
  assert.equal(calls.length, 2); // nothing refused was ever spawned
  assert.equal(await rt.dispatch({ capability: 'applications', action: 'open_application', parameters: {} }), null); // legacy actions untouched
  rt.halt.halt('t'); assert.equal((await open({ path: 'notes.txt' })).blocked, true);
});
