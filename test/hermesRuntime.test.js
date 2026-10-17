import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineStatus, ErrorCode } from '../src/engines/constants.js';
import { HermesEngine } from '../src/engines/hermes/HermesEngine.js';
import {
  EngineSecretStore, HermesProcess, applyBridgeConfig, bridgeConfigSnippet, buildManagedEnv, detectEnvironment, findExecutable, hermesHomeDir, installGuidance, readConfiguredProviders,
} from '../src/engines/hermes/HermesRuntime.js';
import { HermesSettingsStore } from '../src/engines/hermes/HermesSettingsStore.js';
import { HERMES_DEFAULTS, hermesSettingsFromEnv, publicHermesSettings, resolveHermesSettings, validateHermesSettings } from '../src/engines/hermes/hermesConfig.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-hrt-'));
const isWin = process.platform === 'win32';

/** Writes an executable named `hermes` that behaves like `hermes gateway` with the API server: serves /health and /v1/capabilities. */
function installFakeHermesBinary(dir, { exitCode = null } = {}) {
  const script = path.join(dir, 'hermes');
  fs.writeFileSync(script, `#!/usr/bin/env node
${exitCode !== null ? `console.error('boom: no model configured'); process.exit(${exitCode});` : ''}
const http = require('node:http');
if (process.argv[2] === '--version') { console.log('Hermes Agent v9.9.9-test'); process.exit(0); }
if (process.argv[2] !== 'gateway') { console.error('unknown command'); process.exit(2); }
const port = Number(process.env.API_SERVER_PORT); const key = process.env.API_SERVER_KEY;
console.log('gateway starting api_key=' + key);   // a leaky log line, to prove log redaction
http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok' }));
  if (req.headers.authorization !== 'Bearer ' + key) { res.statusCode = 401; return res.end('{}'); }
  if (req.url === '/v1/capabilities') return res.end(JSON.stringify({ features: { run_approval: true } }));
  if (req.url === '/v1/toolsets') return res.end(JSON.stringify({ toolsets: [{ name: 'terminal', enabled: true, tools: ['terminal'] }, { name: 'file', enabled: true, tools: ['read_file'] }] }));
  if (req.url === '/health/detailed') return res.end(JSON.stringify({ readiness: { checks: { model: 'ok' } } }));
  res.statusCode = 404; res.end('{}');
}).listen(port, '127.0.0.1');
`, { mode: 0o755 });
  return script;
}

test('config: defaults are safe; env parsing; precedence defaults < env < saved; validation rejects bad input', () => {
  assert.equal(HERMES_DEFAULTS.autoStart, false, 'Xoft never spawns Hermes unless asked');
  assert.equal(HERMES_DEFAULTS.permissionProfile, 'standard'); assert.equal(HERMES_DEFAULTS.nativeToolPolicy, 'monitor');
  assert.equal(HERMES_DEFAULTS.baseUrl, 'http://127.0.0.1:8642');
  const env = hermesSettingsFromEnv({ HERMES_ENABLED: 'false', HERMES_MAX_CONCURRENT_TASKS: '4', HERMES_DEFAULT_AUTONOMY: '9', HERMES_ALLOWED_ROOTS: '/a, /b;/c', HERMES_NATIVE_TOOL_POLICY: 'enforce' });
  assert.equal(env.enabled, false); assert.equal(env.maxConcurrentTasks, 4); assert.equal(env.defaultAutonomy, 5, 'clamped'); assert.deepEqual(env.allowedRoots, ['/a', '/b', '/c']);
  const r = resolveHermesSettings({ env: { HERMES_MAX_CONCURRENT_TASKS: '4', HERMES_WORKSPACE_MODE: 'worktree' }, saved: { maxConcurrentTasks: 6 } });
  assert.equal(r.maxConcurrentTasks, 6, 'saved settings beat the environment'); assert.equal(r.workspaceMode, 'worktree'); assert.equal(r.enabled, true);
  const bad = resolveHermesSettings({ env: { HERMES_NATIVE_TOOL_POLICY: 'yolo', HERMES_PERMISSION_PROFILE: 'root' } });
  assert.equal(bad.nativeToolPolicy, 'monitor', 'an invalid env value never becomes a setting'); assert.equal(bad.permissionProfile, 'standard');
  for (const [k, v, re] of [['enabled', 'yes', /true or false/], ['baseUrl', 'nope', /valid/], ['allowedRoots', 'x', /array/], ['timeoutMs', 5, /between/], ['maxToolCalls', -1, /between/], ['workspaceMode', 'tmp', /one of/], ['logLevel', 'trace', /one of/], ['environment', { SECRET: 'x' }, /not allowed/], ['environment', { HERMES_X: 1 }, /string/], ['runtimePath', 'a\nb', /illegal/], ['wat', 1, /Unknown Hermes setting/]]) {
    assert.throws(() => validateHermesSettings({ [k]: v }), re, k);
  }
  assert.equal(validateHermesSettings({ baseUrl: 'http://localhost:9000/' }).baseUrl, 'http://localhost:9000');
  assert.equal(validateHermesSettings({ environment: { HERMES_X: '1', HTTPS_PROXY: 'http://p' } }).environment.HERMES_X, '1');
  const pub = publicHermesSettings(resolveHermesSettings({ saved: { environment: { HERMES_X: 'secretish' } } }));
  assert.equal(pub.environment.HERMES_X, '[set]'); assert.ok(pub.permissionProfileResolved.filesystem);
});

test('settings store: owner-only file, tolerant of corruption, update merges', () => {
  const dataDir = tmp(); const s = new HermesSettingsStore({ dataDir });
  assert.deepEqual(s.load(), {});
  s.update({ maxRetries: 3 }); s.update({ logLevel: 'debug' });
  assert.deepEqual(s.load(), { maxRetries: 3, logLevel: 'debug' });
  fs.writeFileSync(s.file, '{not json'); assert.deepEqual(s.load(), {}, 'corrupt file → defaults, no crash');
  s.reset();
});

test('detection: finds executables on PATH, reads Hermes home and provider NAMES (never values), install guidance matches the OS', async () => {
  const bin = tmp(); installFakeHermesBinary(bin);
  const home = tmp(); fs.writeFileSync(path.join(home, '.env'), 'OPENROUTER_API_KEY=sk-or-realsecretvalue123\nAPI_SERVER_KEY=abc\nEMPTY_API_KEY=\n'); fs.writeFileSync(path.join(home, 'config.yaml'), 'model: x\n');
  assert.equal(findExecutable('hermes', { env: { PATH: bin }, platform: 'linux' }), path.join(bin, 'hermes'));
  assert.equal(findExecutable('definitely-not-here', { env: { PATH: bin } }), null);
  assert.deepEqual(readConfiguredProviders(home), ['OPENROUTER_API_KEY']);
  const d = await detectEnvironment({ settings: { hermesHome: home, baseUrl: 'http://127.0.0.1:8642' }, env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HERMES_HOME: home }, apiKeySource: 'env' });
  assert.equal(d.hermes.installed, true); assert.match(d.hermes.version ?? '', /9\.9\.9/); assert.equal(d.hermes.hasConfig, true); assert.deepEqual(d.hermes.configuredProviders, ['OPENROUTER_API_KEY']);
  assert.ok(!JSON.stringify(d).includes('realsecretvalue'), 'secret values never leave the detector');
  assert.equal(d.api.keyConfigured, true); assert.equal(typeof d.os.platform, 'string'); assert.ok(d.node.version.startsWith('v'));
  const none = await detectEnvironment({ settings: {}, env: { PATH: tmp(), HERMES_HOME: path.join(home, 'x') } });
  assert.equal(none.hermes.installed, false);

  assert.match(installGuidance({ platform: 'linux' }).recommended.commands[0], /install\.sh/);
  const win = installGuidance({ platform: 'win32' });
  assert.match(win.recommended.commands[0], /install\.ps1/); assert.ok(win.alternatives.some((a) => /WSL2/.test(a.title)));
  assert.ok(installGuidance({ platform: 'darwin' }).afterInstall.some((l) => /API_SERVER_KEY/.test(l)));
  assert.equal(hermesHomeDir({ env: {}, platform: 'win32', homedir: 'C:\\Users\\u' }).includes('.hermes'), true);
  assert.equal(hermesHomeDir({ env: { LOCALAPPDATA: 'C:\\L' }, platform: 'win32' }), path.join('C:\\L', 'hermes'));
  assert.equal(hermesHomeDir({ env: { HERMES_HOME: '/h' } }), '/h');
});

test('managed env passes only what Hermes needs — Xoft\'s own provider keys and secrets are NOT inherited', () => {
  const env = buildManagedEnv({ base: { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-ant-leak', OPENAI_API_KEY: 'sk-leak', AUTH_API_KEYS: 'x', JWT_SECRET: 'y' }, extra: { HERMES_FOO: '1' }, apiKey: 'k', port: 8642, host: '127.0.0.1', bridgeToken: 'tok' });
  assert.equal(env.PATH, '/bin'); assert.equal(env.API_SERVER_KEY, 'k'); assert.equal(env.API_SERVER_PORT, '8642'); assert.equal(env.API_SERVER_ENABLED, 'true'); assert.equal(env.XOFT_TOOL_TOKEN, 'tok'); assert.equal(env.HERMES_FOO, '1');
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AUTH_API_KEYS', 'JWT_SECRET']) assert.equal(k in env, false, k);
});

test('secret store: generates once, rotates, owner-only', () => {
  const dir = tmp(); const s = new EngineSecretStore({ dataDir: dir });
  const a = s.ensure('x'); assert.ok(a.length >= 40); assert.equal(s.ensure('x'), a); assert.equal(s.get('x'), a);
  const b = s.rotate('x'); assert.notEqual(a, b); assert.equal(s.info('nothing').exists, false);
  if (!isWin) assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
});

test('bridge config: snippet is the documented MCP format; applying is conservative and backs up', () => {
  const snippet = bridgeConfigSnippet({ bridgeUrl: 'http://127.0.0.1:3000/engine-bridge/mcp' });
  assert.match(snippet, /^mcp_servers:\n  xoft:\n    url: "http:\/\/127\.0\.0\.1:3000\/engine-bridge\/mcp"\n    headers:\n      Authorization: "Bearer \$\{XOFT_TOOL_TOKEN\}"$/);
  const home = tmp();
  const a = applyBridgeConfig({ hermesHome: home, snippet }); assert.equal(a.applied, true);
  assert.match(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'), /mcp_servers:/);
  assert.equal(applyBridgeConfig({ hermesHome: home, snippet }).applied, false, 'already configured → no duplicate');
  const home2 = tmp(); fs.writeFileSync(path.join(home2, 'config.yaml'), 'model: x\nmcp_servers:\n  other:\n    url: "http://o"\n');
  const b = applyBridgeConfig({ hermesHome: home2, snippet });
  assert.equal(b.applied, false); assert.match(b.reason, /by hand/);
  assert.match(fs.readFileSync(path.join(home2, 'config.yaml'), 'utf8'), /other:/, 'existing config untouched');
  const home3 = tmp(); fs.writeFileSync(path.join(home3, 'config.yaml'), 'model: x\n');
  const c = applyBridgeConfig({ hermesHome: home3, snippet });
  assert.equal(c.applied, true); assert.equal(fs.readFileSync(c.backup, 'utf8'), 'model: x\n');
  assert.match(fs.readFileSync(path.join(home3, 'config.yaml'), 'utf8'), /^model: x\n/);
});

test('process supervisor: starts, captures + REDACTS logs, reports unexpected exit, stops cleanly', { skip: isWin }, async () => {
  const bin = tmp(); const script = installFakeHermesBinary(bin);
  let exit = null; const lines = [];
  const p = new HermesProcess({ command: script, args: ['gateway'], cwd: bin, env: { PATH: process.env.PATH, API_SERVER_PORT: '0', API_SERVER_KEY: 'sk-abcdefghijklmnopqrstuvwxyz123456' }, onExit: (e) => { exit = e; }, onLog: (l) => lines.push(l) });
  await p.start();
  assert.equal(p.running, true); assert.ok(p.pid);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(p.logs().some((l) => /gateway starting/.test(l)));
  assert.ok(!p.logs().join('\n').includes('sk-abcdefghijklmnopqrstuvwxyz123456'), 'secrets in process output are redacted');
  await p.stop({ graceMs: 2000 });
  assert.equal(p.running, false); assert.equal(exit.expected, true);

  const dead = new HermesProcess({ command: path.join(bin, 'nope'), args: [], cwd: bin, env: {} });
  await assert.rejects(() => dead.start(), (e) => e.code === ErrorCode.UNAVAILABLE && /not found/.test(e.message));
});

test('HermesEngine.start(): launches a Xoft-managed Hermes on loopback with a generated API key, becomes ONLINE, stops cleanly; reuses an existing Hermes instead', { skip: isWin }, async () => {
  const bin = tmp(); installFakeHermesBinary(bin);
  const dataDir = tmp(); const port = 20000 + Math.floor(Math.random() * 20000);
  const mk = (extra = {}) => new HermesEngine({ settingsStore: new HermesSettingsStore({ dataDir }), dataDir, startTimeoutMs: 8000, env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HERMES_HOME: path.join(dataDir, 'nohome'), HERMES_API_URL: `http://127.0.0.1:${port}`, ...extra } });
  const e = mk();
  assert.equal((await e.healthCheck()).available, false);
  assert.equal((await e.healthCheck()).dependencies.runtime, true, 'binary is on PATH even though the API server is not running');
  const out = await e.start();
  assert.equal(out.started, true); assert.equal(e.managed, true);
  assert.equal(e.status, EngineStatus.ONLINE);
  assert.ok(e.describe().apiKey.configured); assert.equal(e.describe().apiKey.source, 'managed');
  const keyFile = path.join(dataDir, 'engines', 'engine-secrets.json');
  assert.ok(JSON.parse(fs.readFileSync(keyFile, 'utf8'))['hermes-api-key'].value.length >= 40, 'key generated and stored (owner-only)');
  const h = await e.healthCheck();
  assert.equal(h.available, true); assert.equal(h.dependencies.api_key, true); assert.equal(h.dependencies.model, true);
  assert.deepEqual((await e.start()), { started: false, reason: 'already running (managed by Xoft)', pid: e.proc.pid });
  assert.ok(e.logs().length > 0);
  assert.ok(!e.logs(400).join('\n').includes(JSON.parse(fs.readFileSync(keyFile, 'utf8'))['hermes-api-key'].value), 'the generated key is redacted in logs');
  await e.stop();
  assert.equal(e.status, EngineStatus.OFFLINE); assert.equal(e.managed, false);
  assert.equal((await e.healthCheck()).available, false);

  const crashBin = tmp(); installFakeHermesBinary(crashBin, { exitCode: 3 });
  const dying = new HermesEngine({ settingsStore: new HermesSettingsStore({ dataDir: tmp() }), dataDir: tmp(), startTimeoutMs: 4000, env: { PATH: `${crashBin}${path.delimiter}${process.env.PATH}`, HERMES_HOME: tmp(), HERMES_API_URL: `http://127.0.0.1:${port + 1}` } });
  await assert.rejects(() => dying.start(), (err) => /exited during start-up/.test(err.message) && /no model configured/.test(err.message));
  assert.equal(dying.status, EngineStatus.ERROR);

  const missing = new HermesEngine({ settingsStore: new HermesSettingsStore({ dataDir: tmp() }), dataDir: tmp(), env: { PATH: tmp(), HERMES_HOME: tmp(), HERMES_API_URL: 'http://127.0.0.1:1' } });
  await assert.rejects(() => missing.start(), (err) => err.code === ErrorCode.UNAVAILABLE && Boolean(err.details.guidance.recommended));
  const remote = mk({ HERMES_API_URL: 'http://10.1.2.3:8642' });
  await assert.rejects(() => remote.start(), (err) => err.code === ErrorCode.POLICY_DENIED && /loopback/.test(err.message));
});
