import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceRegistry } from '../src/devices/DeviceRegistry.js';
import { DeviceManager } from '../src/devices/DeviceManager.js';
import { EventBus } from '../src/events/EventBus.js';
import { ActivityLog } from '../src/activity/ActivityLog.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import { buildDeviceTools } from '../src/tools/builtins/deviceTools.js';
import { TaskPlanner } from '../src/planner/TaskPlanner.js';
import { ApprovalSystem } from '../src/approval/ApprovalSystem.js';

function makeHarness() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-planner-test-'));
  const activityLog = new ActivityLog({ dataDir });
  const eventBus = new EventBus({ activityLog });
  const deviceRegistry = new DeviceRegistry({ activityLog, eventBus, dataDir });
  const deviceManager = new DeviceManager({ deviceRegistry, eventBus, activityLog });
  const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
  for (const tool of buildDeviceTools({ deviceManager })) toolRegistry.register(tool);
  const approvalSystem = new ApprovalSystem({ activityLog, eventBus, dataDir });

  // A fake router that just records the system prompt it was given instead
  // of calling a real AI provider — lets us assert on prompt content deterministically.
  let capturedSystemPrompt = null;
  const router = {
    async complete(_taskType, params) {
      capturedSystemPrompt = params.system;
      return { text: JSON.stringify({ steps: [], blockedReason: 'test stub — no real plan generated' }) };
    },
  };

  const taskPlanner = new TaskPlanner({ router, toolRegistry, approvalSystem, activityLog, memory: null, eventBus, deviceManager, dataDir });
  return { deviceManager, taskPlanner, getCapturedPrompt: () => capturedSystemPrompt };
}

describe('TaskPlanner — device-aware planning prompt', () => {
  test('an untrusted device is NOT listed as a known device for the planner', async () => {
    const { deviceManager, taskPlanner, getCapturedPrompt } = makeHarness();
    deviceManager.registerDevice("Ikenna's Laptop", 'desktop'); // never trusted

    await taskPlanner.plan('open chrome on my laptop');
    const prompt = getCapturedPrompt();
    assert.match(prompt, /No trusted devices are currently registered\./);
    assert.doesNotMatch(prompt, /Ikenna's Laptop/);
  });

  test('a trusted device with reported capabilities appears in the planner prompt with its real id', async () => {
    const { deviceManager, taskPlanner, getCapturedPrompt } = makeHarness();
    const device = deviceManager.registerDevice("Ikenna's Laptop", 'desktop');
    deviceManager.trustDevice(device.id);
    deviceManager.setCapabilities(device.id, ['applications', 'browser']);

    await taskPlanner.plan('open chrome on my laptop');
    const prompt = getCapturedPrompt();
    assert.match(prompt, new RegExp(`id: ${device.id}`));
    assert.match(prompt, /Ikenna's Laptop/);
    assert.match(prompt, /never invent one/);
  });
});
