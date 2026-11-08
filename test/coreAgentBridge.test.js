import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DeviceRegistry } from '../src/devices/DeviceRegistry.js';
import { DeviceManager } from '../src/devices/DeviceManager.js';
import { EventBus } from '../src/events/EventBus.js';
import { ActivityLog } from '../src/activity/ActivityLog.js';
import { PermissionSystem } from '../src/security/PermissionSystem.js';
import { EmergencyStop } from '../src/security/EmergencyStop.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import { buildRuntimeTools } from '../src/tools/builtins/runtimeTools.js';

const require = createRequire(import.meta.url);
const { DeviceRuntime } = require('../pc-agent/src/runtime/DeviceRuntime.js');
const { dispatchCommand } = require('../pc-agent/src/index.js');

/**
 * REAL core tool registry + REAL DeviceManager + REAL pc-agent DeviceRuntime, joined by an in-process pump that does exactly what the
 * agent poll loop does (pullPending → dispatchCommand → submitResult). Only the HTTP hop between them is not exercised here.
 */
function world() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-bridge-')));
  const root = path.join(base, 'proj'); fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"demo","scripts":{"test":"node --test"}}');
  fs.writeFileSync(path.join(root, 'calc.js'), 'exports.add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(root, 'test/calc.test.js'), "const t=require('node:test');const a=require('node:assert');const {add}=require('../calc.js');t('adds',()=>a.equal(add(2,3),5));\n");
  const config = { stateDir: path.join(base, 'state'), workspaces: [{ name: 'demo', root }], policy: { 'terminal.build': 'allow' }, browser: {}, appAllowlist: {} };
  const runtime = new DeviceRuntime({ config, logger: { warn() {} } });
  const dataDir = path.join(base, 'core'); fs.mkdirSync(dataDir);
  const activityLog = new ActivityLog({ dataDir }); const eventBus = new EventBus({ activityLog });
  const deviceManager = new DeviceManager({ deviceRegistry: new DeviceRegistry({ activityLog, eventBus, dataDir }), eventBus, activityLog, defaultCommandTimeoutMs: 20000 });
  const permissionSystem = new PermissionSystem({ activityLog, dataDir }); const emergencyStop = new EmergencyStop({ activityLog, eventBus });
  const toolRegistry = new ToolRegistry({ emergencyStop, permissionEngine: permissionSystem, defaultDeviceId: 'local' });
  for (const t of buildRuntimeTools({ deviceManager })) toolRegistry.register(t);
  const device = deviceManager.registerDevice('Dev PC', 'desktop'); deviceManager.trustDevice(device.id);
  deviceManager.setCapabilities(device.id, DeviceRuntime.CAPABILITIES); deviceManager.heartbeat(device.id);
  for (const p of ['files', 'terminal', 'operations', 'workspace', 'runtime']) permissionSystem.grant(device.id, p === 'files' ? 'files.read' : p === 'terminal' ? 'terminal.safe' : p === 'operations' ? 'operations.read' : p === 'workspace' ? 'workspace.read' : 'runtime.halt');
  for (const p of ['files.write', 'operations.undo']) permissionSystem.grant(device.id, p);
  const timer = setInterval(async () => { for (const cmd of deviceManager.pullPending(device.id)) deviceManager.submitResult(device.id, cmd.id, await dispatchCommand(cmd, config, runtime)); }, 10);
  const call = (name, input, ctx = {}) => toolRegistry.execute(name, { deviceId: device.id, ...input }, { deviceId: device.id, missionId: 'MISSION-1', agent: 'coder', ...ctx });
  return { root, runtime, call, emergencyStop, deviceManager, device, cleanup: () => { clearInterval(timer); runtime.stop(); fs.rmSync(base, { recursive: true, force: true }); } };
}

test('MISSION: locate → inspect → break code → test FAILS → verify → rollback → test PASSES (every step journaled to the mission)', async (t) => {
  const w = world(); t.after(w.cleanup);
  const found = await w.call('file_locate', { query: 'calc' });
  assert.ok(found.result.files.some((f) => f.path.endsWith('calc.js')));
  const insp = await w.call('workspace_inspect', {}); assert.equal(insp.result.commands.test, 'npm test');
  const base = await w.call('terminal_run', { command: 'npm', args: ['test'], reason: 'baseline' });
  assert.equal(base.success, true, JSON.stringify(base)); assert.match(base.result.stdout, /pass 1/);

  const edit = await w.call('file_edit', { path: 'calc.js', find: 'a + b', replace: 'a - b', reason: 'refactor add' });
  assert.equal(edit.success, true); assert.equal(edit.verification.verified, true); assert.equal(edit.result.rollbackAvailable, true);
  const bad = await w.call('terminal_run', { command: 'npm', args: ['test'], reason: 'verify change' });
  assert.equal(bad.success, false, 'a failing test run must be reported as a failure, not success');
  assert.equal(bad.result.exitCode, 1);
  await w.call('file_history', { path: 'calc.js' });

  const undo = await w.call('file_restore', { operationId: edit.result.operationId, reason: 'tests failed after edit' });
  assert.equal(undo.success, true);
  assert.equal(fs.readFileSync(path.join(w.root, 'calc.js'), 'utf8'), 'exports.add = (a, b) => a + b;\n');
  const good = await w.call('terminal_run', { command: 'npm', args: ['test'], reason: 'confirm rollback' });
  assert.equal(good.success, true);

  const ops = (await w.call('operations_list', { limit: 50 })).result.operations;
  const mine = ops.filter((o) => o.missionId === 'MISSION-1');
  assert.ok(mine.length >= 5); assert.ok(mine.every((o) => o.agent === 'coder'));
  assert.deepEqual([...new Set(mine.map((o) => o.action))].sort(), ['EDIT', 'RESTORE', 'TERMINAL']);
});

test('MISSION: kill switch mid-mission — core emergency stop blocks new tools; agent halt stops the agent side independently', async (t) => {
  const w = world(); t.after(w.cleanup);
  assert.equal((await w.call('file_read', { path: 'calc.js' })).success, true);
  w.emergencyStop.activate('operator');
  await assert.rejects(() => w.call('file_edit', { path: 'calc.js', find: 'a + b', replace: 'a * b' }), /EmergencyStop is active/);
  w.emergencyStop.deactivate?.('operator');
  const halt = await w.call('runtime_halt', { reason: 'stop everything' }); assert.equal(halt.success, true);
  const after = await w.call('file_edit', { path: 'calc.js', find: 'a + b', replace: 'a * b' }).catch((e) => e);
  assert.equal(after.success === false || after instanceof Error, true);
  assert.equal(fs.readFileSync(path.join(w.root, 'calc.js'), 'utf8'), 'exports.add = (a, b) => a + b;\n'); // never modified
  assert.match(String(after.error ?? after.message), /HALTED/);
  const st = await w.call('runtime_status', {}); assert.equal(st.result.halted, true); // status stays readable while halted
});

test('MISSION: security violations are refused end-to-end and leave the disk untouched', async (t) => {
  const w = world(); t.after(w.cleanup);
  fs.writeFileSync(path.join(w.root, '.env'), 'SECRET=abc'); const outside = path.join(path.dirname(w.root), 'outside.txt'); fs.writeFileSync(outside, 'private');
  const tries = [['file_read', { path: '.env' }], ['file_read', { path: outside }], ['file_read', { path: '../outside.txt' }], ['file_write', { path: '.env', content: 'x', overwrite: true }], ['file_delete', { path: '.env' }], ['terminal_run', { command: 'rm', args: ['-rf', '.'] }], ['terminal_run', { command: 'git', args: ['push'] }], ['file_move', { from: 'calc.js', to: '../escaped.js' }]];
  for (const [name, input] of tries) {
    const r = await w.call(name, input, { }).catch((e) => ({ success: false, error: e.message }));
    const failed = r.success === false || r.result?.success === false;
    assert.equal(failed, true, `${name} ${JSON.stringify(input)} must fail`);
  }
  assert.equal(fs.readFileSync(path.join(w.root, '.env'), 'utf8'), 'SECRET=abc'); assert.equal(fs.readFileSync(outside, 'utf8'), 'private');
  assert.ok(fs.existsSync(path.join(w.root, 'calc.js'))); assert.ok(!fs.existsSync(path.join(path.dirname(w.root), 'escaped.js')));
});
