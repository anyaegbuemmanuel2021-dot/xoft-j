import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceRegistry } from '../src/devices/DeviceRegistry.js';
import { DeviceManager } from '../src/devices/DeviceManager.js';
import { EventBus } from '../src/events/EventBus.js';
import { ActivityLog } from '../src/activity/ActivityLog.js';
import { PermissionSystem, ALL_PERMISSIONS } from '../src/security/PermissionSystem.js';
import { EmergencyStop } from '../src/security/EmergencyStop.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import { RiskLevel } from '../src/tools/Tool.js';
import { buildRuntimeTools } from '../src/tools/builtins/runtimeTools.js';
import { domainForTool, DomainAutonomy } from '../src/autonomy/DomainAutonomy.js';
import { AutonomyManager } from '../src/autonomy/AutonomyManager.js';
import { ApprovalSystem } from '../src/approval/ApprovalSystem.js';
import { Watchdog } from '../src/watchdog/Watchdog.js';

function harness() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-runtimetools-'));
  const activityLog = new ActivityLog({ dataDir });
  const eventBus = new EventBus({ activityLog });
  const deviceRegistry = new DeviceRegistry({ activityLog, eventBus, dataDir });
  const deviceManager = new DeviceManager({ deviceRegistry, eventBus, activityLog, defaultCommandTimeoutMs: 300 });
  const permissionSystem = new PermissionSystem({ activityLog, dataDir });
  const emergencyStop = new EmergencyStop({ activityLog, eventBus });
  const toolRegistry = new ToolRegistry({ emergencyStop, permissionEngine: permissionSystem, defaultDeviceId: 'local' });
  const tools = buildRuntimeTools({ deviceManager });
  for (const t of tools) toolRegistry.register(t);
  const device = deviceManager.registerDevice('Dev PC', 'desktop');
  deviceManager.trustDevice(device.id);
  deviceManager.setCapabilities(device.id, ['browser', 'files', 'terminal', 'workspace', 'operations', 'runtime']);
  deviceManager.heartbeat(device.id);
  return { dataDir, activityLog, eventBus, deviceManager, permissionSystem, emergencyStop, toolRegistry, tools, device, autonomyManager: new AutonomyManager({ dataDir, activityLog, eventBus }), domainAutonomy: new DomainAutonomy({ dataDir, activityLog, eventBus }) };
}

describe('Device Runtime tools — registration surface', () => {
  test('every tool is uniquely named, permission-declared with known permissions, and mapped to a real domain', () => {
    const { tools } = harness();
    const names = tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.length >= 45);
    for (const t of tools) {
      assert.ok(t.requiredPermissions.length > 0, `${t.name} declares no permission`);
      for (const p of t.requiredPermissions) assert.ok(ALL_PERMISSIONS.includes(p), `${t.name}: unknown permission ${p}`);
      assert.notEqual(domainForTool(t.name), 'general', `${t.name} has no autonomy domain`);
    }
  });

  test('dangerous capabilities are NOT exposed: no arbitrary JS, no arbitrary shell, no workspace add/remove, no force-undo', () => {
    const { tools } = harness();
    const names = tools.map((t) => t.name).join(' ');
    assert.doesNotMatch(names, /execute_js|evaluate|eval|shell|exec\b|workspace_add|workspace_remove|register_workspace|resume/);
    for (const t of tools) assert.equal('force' in t.inputSchema.properties, false, `${t.name} must not accept force`);
    assert.equal(tools.find((t) => t.name === 'terminal_run').inputSchema.properties.command.type, 'string');
  });

  test('risk levels: observation SAFE, page interaction/recoverable edits LOW, delete/undo/terminal EXTERNAL', () => {
    const { tools } = harness(); const risk = (n) => tools.find((t) => t.name === n).riskLevel;
    for (const n of ['browser_get_dom', 'browser_screenshot', 'file_read', 'file_search', 'runtime_halt']) assert.equal(risk(n), RiskLevel.SAFE, n);
    for (const n of ['browser_click', 'browser_fill', 'file_edit', 'file_create']) assert.equal(risk(n), RiskLevel.LOW, n);
    for (const n of ['file_delete', 'file_restore', 'file_undo_last', 'terminal_run']) assert.equal(risk(n), RiskLevel.EXTERNAL, n);
  });
});

describe('Device Runtime tools — enforcement and honest routing', () => {
  test('denied without the permission grant; nothing is queued to the device', async () => {
    const h = harness();
    await assert.rejects(() => h.toolRegistry.execute('browser_click', { deviceId: h.device.id, locator: { selector: '#go' } }, { deviceId: h.device.id }), /requires permission/);
    assert.equal(h.deviceManager.pullPending(h.device.id).length, 0);
  });

  test('with permission, queues the exact capability/action, strips deviceId, attributes the mission, and returns the agent-verified result', async () => {
    const h = harness();
    h.permissionSystem.grant(h.device.id, 'files.write');
    const p = h.toolRegistry.execute('file_edit', { deviceId: h.device.id, path: 'src/a.js', find: 'x', replace: 'y', reason: 'fix bug' }, { deviceId: h.device.id, missionId: 'M-42', agent: 'coder' });
    const [cmd] = h.deviceManager.pullPending(h.device.id);
    assert.equal(cmd.capability, 'files'); assert.equal(cmd.action, 'edit');
    assert.equal(cmd.parameters.deviceId, undefined);
    assert.equal(cmd.parameters.path, 'src/a.js');
    assert.deepEqual(cmd.parameters._context, { missionId: 'M-42', agent: 'coder', reason: null });
    h.deviceManager.submitResult(h.device.id, cmd.id, { success: true, data: { operationId: 9, rollbackAvailable: true }, verification: { verified: true, evidence: { sha256: 'abc' } } });
    const r = await p;
    assert.equal(r.success, true); assert.equal(r.result.operationId, 9); assert.equal(r.verification.verified, true);
  });

  test('an agent failure is surfaced as a failure (never converted to success)', async () => {
    const h = harness();
    h.permissionSystem.grant(h.device.id, 'files.write');
    const p = h.toolRegistry.execute('file_write', { deviceId: h.device.id, path: '.env', content: 'x', overwrite: true }, { deviceId: h.device.id });
    const [cmd] = h.deviceManager.pullPending(h.device.id);
    h.deviceManager.submitResult(h.device.id, cmd.id, { success: false, error: 'protected/sensitive file' });
    const r = await p; assert.equal(r.success, false); assert.match(r.error, /sensitive/);
  });

  test('non-capable, silent and offline devices fail loudly instead of pretending', async () => {
    const h = harness();
    h.permissionSystem.grant(h.device.id, 'browser.read');
    const legacy = h.deviceManager.registerDevice('Old agent', 'desktop'); h.deviceManager.trustDevice(legacy.id); h.deviceManager.setCapabilities(legacy.id, ['files']); h.deviceManager.heartbeat(legacy.id);
    await assert.rejects(() => h.toolRegistry.execute('browser_get_page', { deviceId: legacy.id }, { deviceId: h.device.id }), /has not reported capability 'browser'/);
    await assert.rejects(() => h.toolRegistry.execute('browser_get_page', { deviceId: h.device.id }, { deviceId: h.device.id }), /timed out waiting for the device agent/); // online but the agent never answered
    h.deviceManager.onlineThresholdMs = 0; await new Promise((r) => setTimeout(r, 5)); // now every device counts as offline
    await assert.rejects(() => h.toolRegistry.execute('browser_get_page', { deviceId: h.device.id }, { deviceId: h.device.id }), /offline/);
  });

  test('core emergency stop blocks every runtime tool', async () => {
    const h = harness();
    h.permissionSystem.grant(h.device.id, 'files.read'); h.emergencyStop.activate('test');
    await assert.rejects(() => h.toolRegistry.execute('file_read', { deviceId: h.device.id, path: 'a' }, { deviceId: h.device.id }), /EmergencyStop is active/);
  });
});

describe('Device Runtime tools — approval / per-domain autonomy integration (existing engine, unchanged)', () => {
  const decide = (h, name, input = {}, userSettings = {}) => new ApprovalSystem({ activityLog: h.activityLog, eventBus: h.eventBus, userSettings, autonomyManager: h.autonomyManager, domainAutonomy: h.domainAutonomy, deviceManager: h.deviceManager, dataDir: h.dataDir }).evaluate({ tool: h.toolRegistry.get(name), input: { deviceId: h.device.id, ...input } }).decision;

  test('default settings (existing autoApproveLow=true): observation, page interaction and recoverable edits run; delete/undo/terminal always ask', () => {
    const h = harness(); assert.equal(h.autonomyManager.get().level, 2);
    for (const n of ['browser_get_dom', 'browser_click', 'browser_fill', 'file_edit', 'file_create']) assert.equal(decide(h, n), 'auto', n);
    for (const n of ['file_delete', 'file_restore', 'file_undo_last', 'terminal_run']) assert.equal(decide(h, n), 'requires_approval', n);
  });

  test('strict mode (autoApproveLow=false): everything above observation asks; raising ONLY the browser domain frees clicks, not files or terminal', () => {
    const h = harness(); const strict = { autoApproveLow: false };
    assert.equal(decide(h, 'browser_get_dom', {}, strict), 'auto');
    for (const n of ['browser_click', 'file_edit', 'terminal_run']) assert.equal(decide(h, n, {}, strict), 'requires_approval', n);
    h.domainAutonomy.set('browser', 3);
    assert.equal(decide(h, 'browser_click', {}, strict), 'auto');
    assert.equal(decide(h, 'file_edit', {}, strict), 'requires_approval');
    assert.equal(decide(h, 'terminal_run', {}, strict), 'requires_approval');
  });

  test('terminal is its own domain: maximum file autonomy never unlocks the terminal', () => {
    const h = harness(); const strict = { autoApproveLow: false }; h.domainAutonomy.set('files', 5); h.domainAutonomy.set('terminal', 1);
    assert.equal(decide(h, 'file_edit', {}, strict), 'auto');
    assert.equal(decide(h, 'file_delete', { missionId: 'M1' }, strict), 'auto'); // EXTERNAL + trusted device + mission + level 5: the engine's existing rule
    assert.equal(decide(h, 'terminal_run', { missionId: 'M1' }, strict), 'requires_approval');
  });
});

describe('Watchdog — Device Runtime health is read from real agent reports', () => {
  const wd = (runtimeHealth) => new Watchdog({
    telemetry: { snapshot: () => ({ memory: { usedPercent: 10 }, storage: { usedPercent: 10 }, cpu: { percent: 5 } }) },
    providerOverview: async () => [], missionManager: { list: () => [], isStuck: () => false }, emergencyStop: { isActive: () => false }, runtimeHealth,
  });
  const check = async (rts) => (await wd(() => rts).diagnose()).checks.find((c) => c.name === 'device_runtime');

  test('absent when no runtime device exists (no fabricated check)', async () => assert.equal(await check([]), undefined));
  test('healthy report', async () => { const c = await check([{ name: 'PC', online: true, runtime: { halted: false, interruptedOperations: 0, browser: { ok: true } } }]); assert.equal(c.level, 'HEALTHY'); });
  test('operations interrupted by a crash → WARNING', async () => { const c = await check([{ name: 'PC', online: true, runtime: { halted: false, interruptedOperations: 2, browser: { ok: false } } }]); assert.equal(c.level, 'WARNING'); assert.match(c.detail, /2 operation/); });
  test('halted → DEGRADED and says a human must resume', async () => { const c = await check([{ name: 'PC', online: true, runtime: { halted: true, interruptedOperations: 0 } }]); assert.equal(c.level, 'DEGRADED'); assert.match(c.detail, /human resume/); });
  test('offline runtime device → WARNING', async () => { const c = await check([{ name: 'PC', online: false, runtime: null }]); assert.equal(c.level, 'WARNING'); });
  test('unreachable browser alone does not degrade health (only matters if used)', async () => { const c = await check([{ name: 'PC', online: true, runtime: { halted: false, interruptedOperations: 0, browser: { ok: false } } }]); assert.equal(c.level, 'HEALTHY'); assert.match(c.detail, /not reachable/); });
  test('a throwing health source is reported, not swallowed', async () => { const r = await wd(() => { throw new Error('boom'); }).diagnose(); assert.equal(r.checks.find((c) => c.name === 'device_runtime').level, 'WARNING'); });
});
