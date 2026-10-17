import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityLog } from '../src/activity/ActivityLog.js';
import { EventBus } from '../src/events/EventBus.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import { ApprovalSystem } from '../src/approval/ApprovalSystem.js';
import { MonitorManager } from '../src/background/MonitorManager.js';
import { RulesEngine } from '../src/automation/RulesEngine.js';
import { BackgroundJobManager } from '../src/background/BackgroundJobManager.js';
import { WorkflowEngine } from '../src/workflows/WorkflowEngine.js';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeCountingTool(name) {
  let calls = 0;
  return { tool: { name, description: 'x', inputSchema: {}, riskLevel: 0, requiredPermissions: [], status: 'implemented', async run() { calls += 1; return { ok: true }; } }, getCalls: () => calls };
}

/** A real restart kills the whole process, so an old instance's in-memory timers simply cease to exist — simulate that here rather than leaving them running alongside a second instance in the same test process. */
function killTimers(manager) {
  for (const t of manager._timers.values()) { clearTimeout(t); clearInterval(t); }
  manager._timers.clear();
}

describe('MonitorManager — restart-accurate re-arm', () => {
  test('a monitor re-armed shortly before it was due checks again promptly, not after a fresh full interval', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-monitor-restart-'));
    const activityLog = new ActivityLog({ dataDir });
    const eventBus = new EventBus({ activityLog });
    const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
    const { tool, getCalls } = makeCountingTool('test.check');
    toolRegistry.register(tool);

    const intervalMs = 300;
    const monitor1 = new MonitorManager({ router: null, toolRegistry, activityLog, eventBus, memory: null, dataDir });
    const created = monitor1.create({ description: 'x', toolName: tool.name, input: {}, intervalMinutes: intervalMs / 60000 });

    const data = JSON.parse(fs.readFileSync(path.join(dataDir, 'monitors.json'), 'utf-8'));
    data.monitors.find((m) => m.id === created.id).lastCheckedAt = new Date(Date.now() - (intervalMs - 50)).toISOString();
    fs.writeFileSync(path.join(dataDir, 'monitors.json'), JSON.stringify(data));
    killTimers(monitor1); // "process 1" is gone

    const monitor2 = new MonitorManager({ router: null, toolRegistry, activityLog, eventBus, memory: null, dataDir });
    monitor2.loadAndSchedule();

    await sleep(120);
    assert.ok(getCalls() >= 1, 'the monitor must check again using its remaining time, not restart a full fresh interval');
    killTimers(monitor2);
  });

  test('a monitor with no prior lastCheckedAt (never checked yet) waits a full interval on re-arm, not zero', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-monitor-fresh-'));
    const activityLog = new ActivityLog({ dataDir });
    const eventBus = new EventBus({ activityLog });
    const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
    const { tool, getCalls } = makeCountingTool('test.check2');
    toolRegistry.register(tool);
    const intervalMs = 400;
    const manager1 = new MonitorManager({ router: null, toolRegistry, activityLog, eventBus, memory: null, dataDir });
    manager1.create({ description: 'x', toolName: tool.name, input: {}, intervalMinutes: intervalMs / 60000 });
    killTimers(manager1);

    const manager2 = new MonitorManager({ router: null, toolRegistry, activityLog, eventBus, memory: null, dataDir });
    manager2.loadAndSchedule();
    await sleep(100);
    assert.equal(getCalls(), 0, 'must not check immediately when re-arming a never-checked monitor');
    killTimers(manager2);
  });
});

describe('RulesEngine — restart-accurate re-arm', () => {
  test('a rule re-armed shortly before it was due schedules a short remaining delay, not a fresh full interval', () => {
    // RulesEngine clamps intervalMinutes to a minimum of 1 (pre-existing,
    // intentional — rules shouldn't fire more than once a minute), so a
    // real-time wait isn't practical here; intercept setTimeout instead to
    // verify the computed delay directly and deterministically.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-rules-restart-'));
    const activityLog = new ActivityLog({ dataDir });
    const eventBus = new EventBus({ activityLog });
    const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
    const approvalSystem = new ApprovalSystem({ activityLog, eventBus, dataDir });

    const intervalMinutes = 1;
    const intervalMs = intervalMinutes * 60 * 1000;
    const elapsedMs = 50_000; // ran 50s ago out of a 60s interval -> ~10s should remain
    const rule = {
      id: 'rule-1', rawText: 'x', trigger: { type: 'time', intervalMinutes },
      condition: null, actionDescription: 'x', toolName: null, enabled: true, createdAt: new Date().toISOString(),
      lastRunAt: new Date(Date.now() - elapsedMs).toISOString(),
    };
    fs.writeFileSync(path.join(dataDir, 'rules.json'), JSON.stringify({ rules: [rule] }));

    const engine = new RulesEngine({ router: null, toolRegistry, approvalSystem, activityLog, memory: null, eventBus, dataDir });

    const realSetTimeout = globalThis.setTimeout;
    let capturedDelay = null;
    globalThis.setTimeout = (fn, delay) => { capturedDelay = delay; return realSetTimeout(() => {}, 0); }; // never actually let it fire
    try {
      engine.loadAndSchedule();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    assert.ok(capturedDelay !== null, 'loadAndSchedule must schedule a timer for an enabled time-triggered rule');
    assert.ok(capturedDelay < intervalMs, `remaining delay (${capturedDelay}ms) must be less than a full fresh interval (${intervalMs}ms)`);
    assert.ok(capturedDelay <= elapsedMs === false || Math.abs(capturedDelay - (intervalMs - elapsedMs)) < 2000, `expected roughly ${intervalMs - elapsedMs}ms remaining, got ${capturedDelay}ms`);
    killTimers(engine);
  });

  test('a rule that has never run waits a full interval on re-arm, not zero', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-rules-fresh-'));
    const activityLog = new ActivityLog({ dataDir });
    const eventBus = new EventBus({ activityLog });
    const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
    const approvalSystem = new ApprovalSystem({ activityLog, eventBus, dataDir });

    const rule = {
      id: 'rule-2', rawText: 'x', trigger: { type: 'time', intervalMinutes: 1 },
      condition: null, actionDescription: 'x', toolName: null, enabled: true, createdAt: new Date().toISOString(),
      lastRunAt: null,
    };
    fs.writeFileSync(path.join(dataDir, 'rules.json'), JSON.stringify({ rules: [rule] }));
    const engine = new RulesEngine({ router: null, toolRegistry, approvalSystem, activityLog, memory: null, eventBus, dataDir });

    const realSetTimeout = globalThis.setTimeout;
    let capturedDelay = null;
    globalThis.setTimeout = (fn, delay) => { capturedDelay = delay; return realSetTimeout(() => {}, 0); };
    try {
      engine.loadAndSchedule();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert.equal(capturedDelay, 60_000, 'a never-run rule must wait the full interval, not fire immediately');
    killTimers(engine);
  });
});

describe('BackgroundJobManager — restart-safe absolute scheduling', () => {
  test('loadAndSchedule re-arms a scheduled job at its stored absolute runAt, unaffected by restart timing', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-jobs-restart-'));
    const activityLog = new ActivityLog({ dataDir });
    const eventBus = new EventBus({ activityLog });
    const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
    const { tool, getCalls } = makeCountingTool('test.job');
    toolRegistry.register(tool);

    const manager1 = new BackgroundJobManager({ toolRegistry, taskPlanner: null, activityLog, eventBus, memory: null, dataDir });
    manager1.scheduleOnce({ toolName: tool.name, input: {}, delayMs: 150 });
    killTimers(manager1);

    const manager2 = new BackgroundJobManager({ toolRegistry, taskPlanner: null, activityLog, eventBus, memory: null, dataDir });
    manager2.loadAndSchedule();

    await sleep(80);
    assert.equal(getCalls(), 0, 'must not run before its absolute runAt just because the process restarted');
    await sleep(150);
    assert.equal(getCalls(), 1, 'must still run at its originally scheduled absolute time');
    killTimers(manager2);
  });
});

describe('WorkflowEngine — restart-safe event listeners', () => {
  test('reattachListeners() re-subscribes an enabled event-triggered workflow after a simulated restart', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-workflow-restart-'));
    const activityLog = new ActivityLog({ dataDir });
    const eventBus = new EventBus({ activityLog });
    const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
    const { tool, getCalls } = makeCountingTool('test.wfstep');
    toolRegistry.register(tool);

    const engine1 = new WorkflowEngine({ toolRegistry, activityLog, eventBus, memory: null, dataDir });
    engine1.define({ name: 'on-custom-event', triggerEventType: 'custom.test.event', steps: [{ toolName: tool.name, input: {} }] });
    for (const [, listener] of engine1._listeners) eventBus.off('custom.test.event', listener);

    const engine2 = new WorkflowEngine({ toolRegistry, activityLog, eventBus, memory: null, dataDir });
    eventBus.emitEvent('custom.test.event', { hello: 'world' });
    await sleep(50);
    assert.equal(getCalls(), 0, 'must NOT fire before reattachListeners() is called — no listener exists yet on the fresh instance');

    engine2.reattachListeners();
    eventBus.emitEvent('custom.test.event', { hello: 'world' });
    await sleep(50);
    assert.equal(getCalls(), 1, 'must fire once reattached');
  });

  test('reattachListeners() does not double-attach if called more than once', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-workflow-double-'));
    const activityLog = new ActivityLog({ dataDir });
    const eventBus = new EventBus({ activityLog });
    const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
    const { tool, getCalls } = makeCountingTool('test.wfstep2');
    toolRegistry.register(tool);

    const engine = new WorkflowEngine({ toolRegistry, activityLog, eventBus, memory: null, dataDir });
    engine.define({ name: 'on-custom-event-2', triggerEventType: 'custom.test.event2', steps: [{ toolName: tool.name, input: {} }] });
    engine.reattachListeners();
    engine.reattachListeners();
    eventBus.emitEvent('custom.test.event2', {});
    await sleep(50);
    assert.equal(getCalls(), 1, 'must not run the workflow twice from a double-attached listener');
  });
});
