import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceRegistry } from '../src/devices/DeviceRegistry.js';
import { DeviceManager, DeviceRiskLevel } from '../src/devices/DeviceManager.js';
import { EventBus } from '../src/events/EventBus.js';
import { ActivityLog } from '../src/activity/ActivityLog.js';

function makeHarness({ onlineThresholdMs = 90_000, defaultCommandTimeoutMs = 200 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-device-test-'));
  const activityLog = new ActivityLog({ dataDir });
  const eventBus = new EventBus({ activityLog });
  const deviceRegistry = new DeviceRegistry({ activityLog, eventBus, dataDir });
  const deviceManager = new DeviceManager({ deviceRegistry, eventBus, activityLog, onlineThresholdMs, defaultCommandTimeoutMs });
  return { deviceManager, deviceRegistry, eventBus, activityLog };
}

describe('DeviceManager — registration, trust, capabilities, state', () => {
  test('a newly registered device is unverified and cannot receive commands', async () => {
    const { deviceManager } = makeHarness();
    const device = deviceManager.registerDevice("Ikenna's Laptop", 'desktop');
    assert.equal(device.trust, 'unverified');

    await assert.rejects(
      () => deviceManager.execute({ deviceId: device.id, capability: 'applications', action: 'open_application' }),
      /not trusted/
    );
  });

  test('trustDevice is a distinct, explicit step from registration', () => {
    const { deviceManager } = makeHarness();
    const device = deviceManager.registerDevice('Test Phone', 'android');
    assert.equal(device.trust, 'unverified');
    const trusted = deviceManager.trustDevice(device.id);
    assert.equal(trusted.trust, 'trusted');
  });

  test('capability check blocks commands for capabilities the device has not reported', async () => {
    const { deviceManager } = makeHarness();
    const device = deviceManager.registerDevice('Laptop', 'desktop');
    deviceManager.trustDevice(device.id);
    deviceManager.heartbeat(device.id); // online, but zero capabilities reported

    await assert.rejects(
      () => deviceManager.execute({ deviceId: device.id, capability: 'applications', action: 'open_application' }),
      /has not reported capability/
    );
  });

  test('an offline device rejects commands even if trusted and capable', async () => {
    const { deviceManager } = makeHarness({ onlineThresholdMs: 1 });
    const device = deviceManager.registerDevice('Laptop', 'desktop');
    deviceManager.trustDevice(device.id);
    deviceManager.setCapabilities(device.id, ['applications']);
    await new Promise((r) => setTimeout(r, 5)); // let the heartbeat go stale

    await assert.rejects(
      () => deviceManager.execute({ deviceId: device.id, capability: 'applications', action: 'open_application' }),
      /is offline/
    );
  });

  test('CRITICAL-risk actions are blocked outright, no exceptions', async () => {
    const { deviceManager } = makeHarness();
    const device = deviceManager.registerDevice('Laptop', 'desktop');
    deviceManager.trustDevice(device.id);
    deviceManager.setCapabilities(device.id, ['system']);

    await assert.rejects(
      () => deviceManager.execute({ deviceId: device.id, capability: 'system', action: 'factory_reset' }),
      /CRITICAL-risk/
    );
  });

  test('updateState merges partial fields and emits battery-low only on a real low reading', () => {
    const { deviceManager, eventBus } = makeHarness();
    const device = deviceManager.registerDevice('Phone', 'android');
    const events = [];
    eventBus.on('device.battery.low', (p) => events.push(p));

    deviceManager.updateState(device.id, { battery: 80, charging: false });
    assert.equal(events.length, 0);

    deviceManager.updateState(device.id, { battery: 10, charging: false });
    assert.equal(events.length, 1);
    assert.equal(events[0].battery, 10);

    deviceManager.updateState(device.id, { battery: 5, charging: true }); // charging — not "low" in the alerting sense
    assert.equal(events.length, 1);
  });
});

describe('DeviceManager — command lifecycle (spec section 10/18/29)', () => {
  test('a command genuinely waits for the agent result — never resolves early', async () => {
    const { deviceManager } = makeHarness();
    const device = deviceManager.registerDevice('Laptop', 'desktop');
    deviceManager.trustDevice(device.id);
    deviceManager.setCapabilities(device.id, ['applications']);

    const promise = deviceManager.execute({
      deviceId: device.id,
      capability: 'applications',
      action: 'open_application',
      parameters: { application: 'vscode' },
      riskLevel: DeviceRiskLevel.LOW,
    });

    // Simulate the agent polling and finding the command.
    const pending = deviceManager.pullPending(device.id);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].action, 'open_application');

    // Not resolved yet — no result has been submitted.
    let settled = false;
    promise.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(settled, false);

    deviceManager.submitResult(device.id, pending[0].id, {
      success: true,
      data: { opened: 'vscode' },
      verification: { verified: true, evidence: { windowTitle: 'Visual Studio Code' } },
    });

    const result = await promise;
    assert.equal(result.success, true);
    assert.equal(result.verification.verified, true);
    assert.deepEqual(result.result, { opened: 'vscode' });
  });

  test('an unresolved command times out honestly rather than pretending success', async () => {
    const { deviceManager } = makeHarness({ defaultCommandTimeoutMs: 30 });
    const device = deviceManager.registerDevice('Laptop', 'desktop');
    deviceManager.trustDevice(device.id);
    deviceManager.setCapabilities(device.id, ['applications']);

    await assert.rejects(
      () => deviceManager.execute({ deviceId: device.id, capability: 'applications', action: 'open_application' }),
      /timed out waiting for the device agent/
    );
  });

  test('a failed agent result rejects success but still resolves (not an exception)', async () => {
    const { deviceManager } = makeHarness();
    const device = deviceManager.registerDevice('Laptop', 'desktop');
    deviceManager.trustDevice(device.id);
    deviceManager.setCapabilities(device.id, ['applications']);

    const promise = deviceManager.execute({ deviceId: device.id, capability: 'applications', action: 'open_application' });
    const [cmd] = deviceManager.pullPending(device.id);
    deviceManager.submitResult(device.id, cmd.id, { success: false, error: 'Application not found' });

    const result = await promise;
    assert.equal(result.success, false);
    assert.equal(result.error, 'Application not found');
  });

  test('idempotencyKey prevents a duplicate command from being queued twice (spec section 29)', async () => {
    const { deviceManager } = makeHarness();
    const device = deviceManager.registerDevice('Laptop', 'desktop');
    deviceManager.trustDevice(device.id);
    deviceManager.setCapabilities(device.id, ['applications']);

    const req = { deviceId: device.id, capability: 'applications', action: 'open_application', idempotencyKey: 'launch:app:vscode' };
    const p1 = deviceManager.execute(req);
    const p2 = deviceManager.execute(req); // simulated retry before the first resolves

    const pending = deviceManager.pullPending(device.id);
    assert.equal(pending.length, 1, 'only one command should have been queued for the same idempotency key');

    deviceManager.submitResult(device.id, pending[0].id, { success: true, data: {} });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.commandId, r2.commandId);
  });

  test('submitResult for an already-completed command is a safe no-op, not a crash', async () => {
    const { deviceManager } = makeHarness();
    const device = deviceManager.registerDevice('Laptop', 'desktop');
    deviceManager.trustDevice(device.id);
    deviceManager.setCapabilities(device.id, ['applications']);

    const promise = deviceManager.execute({ deviceId: device.id, capability: 'applications', action: 'open_application' });
    const [cmd] = deviceManager.pullPending(device.id);
    deviceManager.submitResult(device.id, cmd.id, { success: true, data: {} });
    await promise;

    assert.doesNotThrow(() => deviceManager.submitResult(device.id, cmd.id, { success: true, data: {} }));
  });
});
