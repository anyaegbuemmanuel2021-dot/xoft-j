import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceRegistry } from '../src/devices/DeviceRegistry.js';
import { DeviceManager } from '../src/devices/DeviceManager.js';
import { DeviceThreatMonitor } from '../src/security/DeviceThreatMonitor.js';
import { EventBus } from '../src/events/EventBus.js';
import { ActivityLog } from '../src/activity/ActivityLog.js';

function makeHarness(thresholds = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-threatmon-test-'));
  const activityLog = new ActivityLog({ dataDir });
  const eventBus = new EventBus({ activityLog });
  const deviceRegistry = new DeviceRegistry({ activityLog, eventBus, dataDir });
  const deviceManager = new DeviceManager({ deviceRegistry, eventBus, activityLog, defaultCommandTimeoutMs: 50 });
  const monitor = new DeviceThreatMonitor({ eventBus, deviceManager, activityLog, windowMs: 60_000, thresholds });
  return { deviceManager, monitor, eventBus };
}

function trustedCapableDevice(deviceManager, capabilities = ['applications']) {
  const device = deviceManager.registerDevice('Test Device', 'desktop');
  deviceManager.trustDevice(device.id);
  deviceManager.setCapabilities(device.id, capabilities);
  deviceManager.heartbeat(device.id);
  return device;
}

describe('DeviceThreatMonitor — command flood detection', () => {
  test('a burst of commands past the threshold auto-quarantines the device', async () => {
    const { deviceManager, monitor } = makeHarness({ commandsPerWindow: 5 });
    const device = trustedCapableDevice(deviceManager);

    // Fire 6 commands without waiting for results — each rejects on timeout, that's fine, we only care about the queue-side event.
    for (let i = 0; i < 6; i++) {
      deviceManager.execute({ deviceId: device.id, capability: 'applications', action: 'open_application' }).catch(() => {});
    }

    // Synchronous within execute()'s queuing path — no need to await anything for the quarantine to have fired.
    const after = deviceManager.getDevice(device.id);
    assert.equal(after.trust, 'unverified', 'device should have been auto-quarantined after exceeding the command burst threshold');
    monitor.stop();
  });

  test('normal usage under the threshold never quarantines', async () => {
    const { deviceManager, monitor } = makeHarness({ commandsPerWindow: 50 });
    const device = trustedCapableDevice(deviceManager);

    for (let i = 0; i < 3; i++) {
      deviceManager.execute({ deviceId: device.id, capability: 'applications', action: 'open_application' }).catch(() => {});
    }

    const after = deviceManager.getDevice(device.id);
    assert.equal(after.trust, 'trusted');
    monitor.stop();
  });
});

describe('DeviceThreatMonitor — failure/probing detection', () => {
  test('repeated command failures past the threshold auto-quarantines the device', async () => {
    const { deviceManager, monitor } = makeHarness({ failuresPerWindow: 3, commandsPerWindow: 1000 });
    const device = trustedCapableDevice(deviceManager);

    for (let i = 0; i < 4; i++) {
      const p = deviceManager.execute({ deviceId: device.id, capability: 'applications', action: 'open_application' }).catch(() => {});
      const [cmd] = deviceManager.pullPending(device.id);
      if (cmd) deviceManager.submitResult(device.id, cmd.id, { success: false, error: 'simulated failure' });
      await p;
    }

    const after = deviceManager.getDevice(device.id);
    assert.equal(after.trust, 'unverified');
    monitor.stop();
  });
});

describe('DeviceThreatMonitor — quarantine gives a real, reviewable reason and stops further commands', () => {
  test('after quarantine, execute() rejects with "not trusted" just like a never-trusted device', async () => {
    const { deviceManager, monitor } = makeHarness({ commandsPerWindow: 2 });
    const device = trustedCapableDevice(deviceManager);

    for (let i = 0; i < 3; i++) {
      deviceManager.execute({ deviceId: device.id, capability: 'applications', action: 'open_application' }).catch(() => {});
    }

    await assert.rejects(
      () => deviceManager.execute({ deviceId: device.id, capability: 'applications', action: 'open_application' }),
      /not trusted/
    );
    monitor.stop();
  });

  test('getActivitySummary reflects real counts, not just a boolean', () => {
    const { deviceManager, monitor } = makeHarness({ commandsPerWindow: 1000 });
    const device = trustedCapableDevice(deviceManager);

    deviceManager.execute({ deviceId: device.id, capability: 'applications', action: 'open_application' }).catch(() => {});
    deviceManager.execute({ deviceId: device.id, capability: 'applications', action: 'open_application' }).catch(() => {});

    const summary = monitor.getActivitySummary(device.id);
    assert.equal(summary.commandsInWindow, 2);
    monitor.stop();
  });
});
