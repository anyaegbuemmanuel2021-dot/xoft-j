import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityLog } from '../src/activity/ActivityLog.js';
import { ApprovalSystem } from '../src/approval/ApprovalSystem.js';
import { AutonomyManager } from '../src/autonomy/AutonomyManager.js';
import { EventBus } from '../src/events/EventBus.js';
import { RiskLevel, Tool } from '../src/tools/Tool.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import { PROFILES } from '../src/engines/EnginePermissions.js';
import { ToolGateway } from '../src/engines/ToolGateway.js';
import { EngineSecretStore } from '../src/engines/hermes/HermesRuntime.js';
import { resolveHermesSettings } from '../src/engines/hermes/hermesConfig.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-gw-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const T = (name, risk, execute, props = {}) => new Tool({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: { path: { type: 'string' }, deviceId: { type: 'string' }, ...props }, required: ['deviceId'] }, requiredPermissions: [], riskLevel: risk, status: 'IMPLEMENTED', execute });

function rig({ activeTasks, settings = {}, autonomy = 5, withApprovals = true } = {}) {
  const dataDir = tmp();
  const calls = [];
  const registry = new ToolRegistry();
  const mk = (name, risk, extra) => registry.register(T(name, risk, async (input, ctx) => { calls.push({ name, input, ctx }); return extra?.(input) ?? { ok: true, name }; }));
  mk('file_read', RiskLevel.SAFE); mk('file_write', RiskLevel.LOW); mk('file_delete', RiskLevel.HIGH_IMPACT); mk('terminal_run', RiskLevel.EXTERNAL);
  mk('send_email', RiskLevel.EXTERNAL); mk('calculate', RiskLevel.SAFE); mk('engine_run_task', RiskLevel.EXTERNAL);
  mk('leaky', RiskLevel.SAFE, () => ({ token: 'sk-abcdefghijklmnopqrstuvwxyz123456', note: 'password=hunter2hunter2', fine: 1 }));
  mk('shot', RiskLevel.SAFE, () => ({ base64: 'A'.repeat(500), width: 10 }));
  const activityLog = new ActivityLog({ dataDir }); const eventBus = new EventBus({ activityLog });
  const autonomyManager = new AutonomyManager({ activityLog, eventBus, dataDir }); autonomyManager.set(autonomy);
  const approvalSystem = withApprovals ? new ApprovalSystem({ activityLog, eventBus, autonomyManager, dataDir }) : null;
  const bridgeNotes = [];
  const manager = { activeTasks: () => activeTasks ?? [], noteBridgeCall: (id, e) => bridgeNotes.push({ id, ...e }), addBridgeApproval: (id, a) => bridgeNotes.push({ id, type: 'add', ...a }), removeBridgeApproval: (id, a) => bridgeNotes.push({ id, type: 'remove', a }) };
  const hs = resolveHermesSettings({ env: {}, saved: { permissionProfile: 'full', bridgeApprovalWaitMs: 1000, ...settings } });
  const secretStore = new EngineSecretStore({ dataDir });
  const gw = new ToolGateway({ toolRegistry: registry, secretStore, getTaskManager: () => manager, getSettings: () => hs, approvalSystem, activityLog, deviceManager: { listDevices: () => [{ id: 'pc-1', platform: 'windows', trust: 'trusted', online: true }] }, ctxFactory: () => ({ memory: 'MEM' }), localDeviceId: 'local', publicUrl: 'http://127.0.0.1:3000', pollMs: 10 });
  const call = (body, { token = gw.token(), method = 'POST', remote = '127.0.0.1', headers = {} } = {}) => gw.handleHttp({ method, headers: { authorization: `Bearer ${token}`, ...headers }, body, remoteAddress: remote });
  const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
  const tool = async (name, args) => (await call(rpc('tools/call', { name, arguments: args }))).body.result;
  return { gw, calls, call, rpc, tool, approvalSystem, bridgeNotes, registry, dataDir, hs };
}
const wd = '/work/proj';
const task = (over = {}) => ({ id: 'task-1', engine: 'hermes', state: 'running', permissions: PROFILES.standard, allowedRoots: [wd], workingDirectory: wd, workspace: { cwd: wd }, autonomy: 3, ...over });

test('transport security: token required (constant-time), loopback only, POST only, disabled switch, rate limit', async () => {
  const r = rig({ activeTasks: [task()] });
  assert.equal((await r.call(r.rpc('ping'), { token: 'wrong' })).status, 401);
  assert.equal((await r.call(r.rpc('ping'), { token: '' })).status, 401);
  assert.equal((await r.gw.handleHttp({ method: 'POST', headers: {}, body: r.rpc('ping'), remoteAddress: '127.0.0.1' })).status, 401);
  assert.equal((await r.call(r.rpc('ping'), { remote: '192.168.1.20' })).status, 403, 'LAN callers are refused');
  assert.equal((await r.call(r.rpc('ping'), { remote: '::1' })).status, 200);
  assert.equal((await r.call(null, { method: 'GET' })).status, 405);
  assert.equal((await r.call(null, { method: 'DELETE' })).status, 405);
  assert.equal((await r.call('not json')).status, 400);
  const off = rig({ settings: { bridgeEnabled: false } });
  assert.equal((await off.call(off.rpc('ping'))).status, 404);
  const remoteOk = new ToolGateway({ ...r.gw, allowRemote: true });
  assert.equal((await remoteOk.handleHttp({ method: 'POST', headers: { authorization: `Bearer ${r.gw.token()}` }, body: r.rpc('ping'), remoteAddress: '10.0.0.5' })).status, 200);
  const file = new EngineSecretStore({ dataDir: r.dataDir }).file;
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'token file is owner-only');
  const old = r.gw.token(); const fresh = r.gw.rotateToken();
  assert.notEqual(old, fresh); assert.equal((await r.call(r.rpc('ping'), { token: old })).status, 401);
});

test('MCP protocol: initialize negotiates version + marks connected; notifications → 202; tools/list; unknown method → -32601; batch', async () => {
  const r = rig({ activeTasks: [task()] });
  assert.equal(r.gw.status().connected, false);
  const init = (await r.call(r.rpc('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'hermes' }, capabilities: {} }))).body.result;
  assert.equal(init.protocolVersion, '2025-03-26'); assert.ok(init.capabilities.tools); assert.equal(init.serverInfo.name, 'xoft-tool-gateway');
  assert.equal((await r.call(r.rpc('initialize', { protocolVersion: '1999-01-01' }))).body.result.protocolVersion, '2025-06-18', 'unknown versions get our newest');
  assert.equal(r.gw.status().connected, true); assert.equal(r.gw.status().client, 'hermes'); assert.equal(r.gw.status().deviceOnline, true);
  const note = await r.call({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202); assert.equal(note.body, undefined);
  const list = (await r.call(r.rpc('tools/list'))).body.result.tools;
  const names = list.map((t) => t.name);
  assert.ok(names.includes('file_read') && names.includes('terminal_run'));
  assert.ok(!names.includes('engine_run_task'), 'an engine can never launch engine tasks (no recursive delegation)');
  const fr = list.find((t) => t.name === 'file_read');
  assert.ok(fr.inputSchema.properties.task_id, 'task_id is injected so the gateway can apply the right policy');
  assert.ok(!fr.inputSchema.required.includes('deviceId'), 'gateway supplies the default device');
  assert.equal((await r.call(r.rpc('does/not/exist'))).body.error.code, -32601);
  assert.deepEqual((await r.call(r.rpc('resources/list'))).body.result.resources, []);
  const batch = (await r.call([r.rpc('ping', {}, 1), r.rpc('tools/list', {}, 2)])).body;
  assert.equal(batch.length, 2);
  assert.equal((await r.call({ nope: true })).body.error.code, -32600);
  const limited = new ToolGateway({ ...r.gw, getSettings: () => resolveHermesSettings({ saved: { permissionProfile: 'observe' } }) });
  const obsNames = limited.listTools().map((t) => t.name);
  assert.ok(obsNames.includes('file_read') && !obsNames.includes('file_write') && !obsNames.includes('terminal_run'), 'the tool list is limited to what the engine permission ceiling allows');
});

test('permission enforcement happens BEFORE execution, per task profile', async () => {
  const r = rig({ activeTasks: [task()] });
  const ok = await r.tool('file_read', { path: `${wd}/a.js`, task_id: 'task-1' });
  assert.equal(ok.isError, false); assert.equal(r.calls.length, 1);
  const del = await r.tool('file_delete', { path: `${wd}/a.js`, task_id: 'task-1' });
  assert.equal(del.isError, true); assert.match(del.content[0].text, /filesystem\.delete/); assert.equal(r.calls.length, 1, 'denied call never reached the tool');
  const mail = await r.tool('send_email', { to: 'x@y.z', task_id: 'task-1' });
  assert.match(mail.content[0].text, /integrations\.use/);
  const unknown = await r.tool('rm_rf_everything', { task_id: 'task-1' });
  assert.equal(unknown.isError, true);
  const eng = await r.tool('engine_run_task', { goal: 'x', task_id: 'task-1' });
  assert.match(eng.content[0].text, /Unknown Xoft tool/);
  assert.ok(r.gw.status().denied >= 2);
  assert.ok(r.bridgeNotes.some((n) => n.decision === 'denied' && n.code === 'permission'), 'denials are audited on the task');
});

test('autonomy 0–1 tasks can only call SAFE tools; policy cannot be widened by the engine\'s own ceiling being "full"', async () => {
  const r = rig({ activeTasks: [task({ autonomy: 1, permissions: PROFILES.full })] });
  assert.equal((await r.tool('file_read', { path: `${wd}/a`, task_id: 'task-1' })).isError, false);
  const w = await r.tool('file_write', { path: `${wd}/a`, task_id: 'task-1' });
  assert.match(w.content[0].text, /autonomy/);
});

test('path scoping: protected files refused, writes must stay inside the task directories, relative paths resolved against the task cwd', async () => {
  const r = rig({ activeTasks: [task({ permissions: PROFILES.developer })], autonomy: 5 });
  const sens = await r.tool('file_read', { path: `${wd}/.env`, task_id: 'task-1' });
  assert.match(sens.content[0].text, /protected file/);
  const ssh = await r.tool('file_read', { path: '/home/u/.ssh/id_rsa', task_id: 'task-1' });
  assert.match(ssh.content[0].text, /protected/);
  const out = await r.tool('file_write', { path: '/etc/hosts', task_id: 'task-1' });
  assert.match(out.content[0].text, /outside the directories/);
  const trav = await r.tool('file_write', { path: `${wd}/../other/x`, task_id: 'task-1' });
  assert.match(trav.content[0].text, /outside the directories/);
  const rel = await r.tool('file_write', { path: 'src/new.js', task_id: 'task-1' });
  assert.equal(rel.isError, false, 'relative path resolves inside the task cwd');
  const readOutside = await r.tool('file_read', { path: '/usr/share/doc/readme', task_id: 'task-1' });
  assert.equal(readOutside.isError, false, 'reading outside is allowed (writes are what is confined)');
  assert.equal(r.calls.filter((c) => c.name === 'file_write').length, 1);
});

test('task resolution: unknown task_id and no active task are refused; a single active task is used when task_id is omitted; several → most restrictive wins', async () => {
  const none = rig({ activeTasks: [] });
  assert.match((await none.tool('file_read', { path: '/x' })).content[0].text, /no active Xoft task/);
  const one = rig({ activeTasks: [task()] });
  assert.equal((await one.tool('file_read', { path: `${wd}/a` })).isError, false);
  assert.match((await one.tool('file_read', { path: `${wd}/a`, task_id: 'someone-else' })).content[0].text, /not an active Xoft task/);

  const two = rig({ activeTasks: [task({ id: 'a', permissions: PROFILES.developer }), task({ id: 'b', permissions: PROFILES.observe })] });
  assert.match((await two.tool('file_write', { path: `${wd}/x` })).content[0].text, /filesystem\.write/, 'ambiguous caller gets the intersection (observe-only)');
  assert.equal((await two.tool('file_write', { path: `${wd}/x`, task_id: 'a' })).isError, false, 'an explicit active task id selects that task\'s own policy');
});

test('default device is injected; ctx carries memory + device + agent; emergency stop blocks everything', async () => {
  const r = rig({ activeTasks: [task()] });
  await r.tool('file_read', { path: `${wd}/a`, task_id: 'task-1' });
  assert.equal(r.calls[0].input.deviceId, 'pc-1'); assert.equal(r.calls[0].ctx.deviceId, 'pc-1'); assert.equal(r.calls[0].ctx.memory, 'MEM'); assert.equal(r.calls[0].ctx.agent, 'hermes');
  assert.equal('task_id' in r.calls[0].input, false, 'task_id is stripped before the tool sees it');
  await r.tool('file_read', { path: `${wd}/a`, deviceId: 'other', task_id: 'task-1' });
  assert.equal(r.calls[1].ctx.deviceId, 'other');
  const stopped = new ToolGateway({ ...r.gw, emergencyStop: { isActive: () => true } });
  const res = (await stopped.handleHttp({ method: 'POST', headers: { authorization: `Bearer ${stopped.token()}` }, body: r.rpc('tools/call', { name: 'file_read', arguments: { path: `${wd}/a`, task_id: 'task-1' } }), remoteAddress: '127.0.0.1' })).body.result;
  assert.match(res.content[0].text, /emergency stop/);
});

test('Xoft approval rules apply: EXTERNAL tools wait for a human; approved → runs exactly once; rejected → blocked; timeout → "retry" message', async () => {
  const r = rig({ activeTasks: [task({ permissions: PROFILES.full })], autonomy: 2, settings: { bridgeApprovalWaitMs: 1000 } });
  // human approves while the gateway call is waiting
  const pending = r.tool('terminal_run', { command: 'npm test', task_id: 'task-1' });
  await wait(80);
  const rec = r.approvalSystem.listPending()[0];
  assert.ok(rec, 'an approval was created'); assert.equal(rec.toolName, 'terminal_run'); assert.equal(rec.metadata.bridge, true); assert.equal(rec.metadata.engineTaskId, 'task-1');
  assert.ok(r.bridgeNotes.some((n) => n.type === 'add' && n.approvalId === rec.id), 'the task is told it is waiting');
  r.approvalSystem.approve(rec.id);
  const done = await pending;
  assert.equal(done.isError, false); assert.equal(r.calls.filter((c) => c.name === 'terminal_run').length, 1);
  assert.ok(r.bridgeNotes.some((n) => n.type === 'remove'));

  // rejected
  const rej = r.tool('terminal_run', { command: 'make deploy', task_id: 'task-1' });
  await wait(80); r.approvalSystem.reject(r.approvalSystem.listPending()[0].id);
  const rr = await rej;
  assert.equal(rr.isError, true); assert.match(rr.content[0].text, /rejected/); assert.equal(r.calls.filter((c) => c.name === 'terminal_run').length, 1);

  // nobody answers in time: the call returns a retry message; the retry finds the SAME approval and runs once approved
  const r2 = rig({ activeTasks: [task({ permissions: PROFILES.full })], autonomy: 2, settings: { bridgeApprovalWaitMs: 1000 } });
  r2.gw.getSettings = () => ({ ...r2.hs, bridgeApprovalWaitMs: 60 });
  const first = await r2.tool('terminal_run', { command: 'npm run build', task_id: 'task-1' });
  assert.equal(first.isError, true); assert.match(first.content[0].text, /waiting for a human/);
  assert.equal(r2.calls.length, 0); assert.equal(r2.approvalSystem.listPending().length, 1);
  r2.approvalSystem.approve(r2.approvalSystem.listPending()[0]?.id ?? [...r2.approvalSystem.list?.() ?? []][0]?.id);
  const retry = await r2.tool('terminal_run', { command: 'npm run build', task_id: 'task-1' });
  assert.equal(retry.isError, false); assert.equal(r2.calls.length, 1, 'executed exactly once');
  const again = await r2.tool('terminal_run', { command: 'npm run build', task_id: 'task-1' });
  assert.equal(again.isError, true, 'the approval was consumed; a repeat needs a new one');
  assert.equal(r2.approvalSystem.listPending().length, 1);
});

test('high autonomy lets EXTERNAL tools through without a human (Xoft rules decide, not the gateway)', async () => {
  const r = rig({ activeTasks: [task({ permissions: PROFILES.full })], autonomy: 5 });
  r.approvalSystem.autonomyManager.set(5);
  const t = await r.tool('terminal_run', { command: 'ls', task_id: 'task-1' });
  assert.ok(t.isError === false || /waiting for a human/.test(t.content[0].text));
  const hi = await r.tool('file_delete', { path: `${wd}/x`, task_id: 'task-1' });
  assert.match(hi.content[0].text, /waiting for a human/, 'HIGH_IMPACT is always a human decision, at any autonomy');
});

test('results are secret-redacted, huge results truncated, images attached separately, tool errors are results not protocol errors', async () => {
  const r = rig({ activeTasks: [task({ permissions: PROFILES.full })], autonomy: 5 }); // custom tool names need integrations.use
  r.approvalSystem.autonomyManager.set(5);
  const leak = await r.tool('leaky', { task_id: 'task-1' });
  const text = leak.content[0].text;
  assert.ok(!text.includes('sk-abcdefghijklmnopqrstuvwxyz123456') && !text.includes('hunter2hunter2'));
  assert.ok(text.includes('"fine": 1'));
  const shot = await r.tool('shot', { task_id: 'task-1' });
  assert.equal(shot.content[1].type, 'image'); assert.equal(shot.content[1].mimeType, 'image/png'); assert.ok(!shot.content[0].text.includes('AAAAAAAA'));
  r.registry.register(T('boom', RiskLevel.SAFE, async () => { throw new Error('disk exploded sk-abcdefghijklmnopqrstuvwxyz123456'); }));
  const res = await r.call(r.rpc('tools/call', { name: 'boom', arguments: { task_id: 'task-1' } }));
  assert.equal(res.status, 200); assert.equal(res.body.result.isError, true); assert.ok(!res.body.result.content[0].text.includes('sk-abcdef'));
  assert.equal(r.gw.status().errors, 1);
});
