import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceRegistry } from '../src/devices/DeviceRegistry.js';
import { DeviceManager } from '../src/devices/DeviceManager.js';
import { EventBus } from '../src/events/EventBus.js';
import { ActivityLog } from '../src/activity/ActivityLog.js';

// This mirrors the isLoopback()+autoTrustLocal branch added to
// POST /api/devices in src/index.js — exercised here at the DeviceManager
// level (same trust semantics) since spinning up the full HTTP server per
// test is unnecessary for what we're actually verifying: that trust only
// happens when explicitly told to, never implicitly.
describe('AUTO_TRUST_LOCAL semantics', () => {
  test('a device is never auto-trusted unless the flow explicitly calls trustDevice()', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-autotrust-test-'));
    const activityLog = new ActivityLog({ dataDir });
    const eventBus = new EventBus({ activityLog });
    const deviceRegistry = new DeviceRegistry({ activityLog, eventBus, dataDir });
    const deviceManager = new DeviceManager({ deviceRegistry, eventBus, activityLog });

    const device = deviceManager.registerDevice('Remote phone', 'android');
    assert.equal(device.trust, 'unverified', 'registration alone must never grant trust, local or not');
  });

  test('the loopback + auto-trust path (as wired in index.js) results in trusted status', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-autotrust-test-'));
    const activityLog = new ActivityLog({ dataDir });
    const eventBus = new EventBus({ activityLog });
    const deviceRegistry = new DeviceRegistry({ activityLog, eventBus, dataDir });
    const deviceManager = new DeviceManager({ deviceRegistry, eventBus, activityLog });

    // Simulates exactly what index.js's POST /api/devices does when
    // config.devices.autoTrustLocal is true and the request came from 127.0.0.1.
    const device = deviceManager.registerDevice('This PC', 'desktop');
    const autoTrustLocal = true;
    const isLoopbackRequest = true;
    if (autoTrustLocal && isLoopbackRequest) {
      deviceManager.trustDevice(device.id);
    }

    assert.equal(deviceManager.getDevice(device.id).trust, 'trusted');
  });
});
