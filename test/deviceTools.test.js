import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceRegistry } from '../src/devices/DeviceRegistry.js';
import { DeviceManager } from '../src/devices/DeviceManager.js';
import { EventBus } from '../src/events/EventBus.js';
import { ActivityLog } from '../src/activity/ActivityLog.js';
import { PermissionSystem } from '../src/security/PermissionSystem.js';
import { EmergencyStop } from '../src/security/EmergencyStop.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import { buildDeviceTools } from '../src/tools/builtins/deviceTools.js';

function makeHarness() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-devicetools-test-'));
  const activityLog = new ActivityLog({ dataDir });
  const eventBus = new EventBus({ activityLog });
  const deviceRegistry = new DeviceRegistry({ activityLog, eventBus, dataDir });
  const deviceManager = new DeviceManager({ deviceRegistry, eventBus, activityLog, defaultCommandTimeoutMs: 200 });
  const permissionSystem = new PermissionSystem({ activityLog, dataDir });
  const emergencyStop = new EmergencyStop({ activityLog, eventBus });
  const toolRegistry = new ToolRegistry({ emergencyStop, permissionEngine: permissionSystem, defaultDeviceId: 'local' });
  for (const tool of buildDeviceTools({ deviceManager })) toolRegistry.register(tool);
  return { deviceManager, permissionSystem, emergencyStop, toolRegistry };
}

describe('Device tools — real permission enforcement, no bypass', () => {
  test('device_launch_app is denied without the apps.launch permission grant, even if the device is online', async () => {
    const { deviceManager, toolRegistry } = makeHarness();
    const device = deviceManager.registerDevice('Laptop', 'desktop');
    deviceManager.trustDevice(device.id);
    deviceManager.setCapabilities(device.id, ['applications']);
    deviceManager.heartbeat(device.id);

    await assert.rejects(
      () => toolRegistry.execute('device_launch_app', { deviceId: device.id, application: 'chrome' }, { deviceId: device.id }),
      /requires permission/
    );
  });

  test('device_launch_app succeeds end-to-end once permission is granted and the agent reports success', async () => {
    const { deviceManager, permissionSystem, toolRegistry } = makeHarness();
    const device = deviceManager.registerDevice('Laptop', 'desktop');
    deviceManager.trustDevice(device.id);
    deviceManager.setCapabilities(device.id, ['applications']);
    deviceManager.heartbeat(device.id);
    permissionSystem.grant(device.id, 'apps.launch');

    const promise = toolRegistry.execute('device_launch_app', { deviceId: device.id, application: 'chrome' }, { deviceId: device.id });
    const [cmd] = deviceManager.pullPending(device.id);
    deviceManager.submitResult(device.id, cmd.id, { success: true, data: { launched: 'chrome' }, verification: { verified: true } });

    const result = await promise;
    assert.equal(result.success, true);
    assert.equal(result.verification.verified, true);
  });

  test('emergency stop blocks device tool execution just like any other tool', async () => {
    const { deviceManager, permissionSystem, emergencyStop, toolRegistry } = makeHarness();
    const device = deviceManager.registerDevice('Laptop', 'desktop');
    deviceManager.trustDevice(device.id);
    deviceManager.setCapabilities(device.id, ['applications']);
    deviceManager.heartbeat(device.id);
    permissionSystem.grant(device.id, 'apps.launch');
    emergencyStop.activate('test');

    await assert.rejects(
      () => toolRegistry.execute('device_launch_app', { deviceId: device.id, application: 'chrome' }, { deviceId: device.id }),
      /EmergencyStop is active/
    );
  });

  test('device_transfer_file coordinates two devices and fails closed if the source read fails', async () => {
    const { deviceManager, permissionSystem, toolRegistry } = makeHarness();
    const laptop = deviceManager.registerDevice('Laptop', 'desktop');
    const phone = deviceManager.registerDevice('Phone', 'android');
    for (const d of [laptop, phone]) {
      deviceManager.trustDevice(d.id);
      deviceManager.setCapabilities(d.id, ['files']);
      deviceManager.heartbeat(d.id);
      permissionSystem.grant(d.id, 'files.read');
      permissionSystem.grant(d.id, 'files.write');
    }

    const promise = toolRegistry.execute(
      'device_transfer_file',
      { sourceDeviceId: laptop.id, targetDeviceId: phone.id, filePath: '/Users/x/project.zip' },
      { deviceId: laptop.id }
    );
    const [readCmd] = deviceManager.pullPending(laptop.id);
    deviceManager.submitResult(laptop.id, readCmd.id, { success: false, error: 'file not found' });

    const result = await promise;
    assert.equal(result.success, false);
    // The target should never have been asked to receive anything.
    assert.equal(deviceManager.pullPending(phone.id).length, 0);
  });
});
