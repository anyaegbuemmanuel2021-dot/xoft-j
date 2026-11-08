import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KillSwitch } from '../src/security/KillSwitch.js';
import { EmergencyStop } from '../src/security/EmergencyStop.js';
import { ActivityLog } from '../src/activity/ActivityLog.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'killswitch-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('KillSwitch trips EmergencyStop when the sentinel file is dropped, with no HTTP call involved', async () => {
  const dataDir = tmp();
  const activityLog = new ActivityLog({ dataDir });
  const emergencyStop = new EmergencyStop({ activityLog });
  const ks = new KillSwitch({ emergencyStop, activityLog, dataDir, pollIntervalMs: 20 });
  ks.start();
  try {
    assert.equal(emergencyStop.isActive(), false);
    fs.writeFileSync(path.join(dataDir, 'KILL'), 'stop\n');
    await wait(200);
    assert.equal(emergencyStop.isActive(), true);
  } finally {
    ks.stop();
  }
});

test('KillSwitch trips EmergencyStop on SIGUSR2', async () => {
  const dataDir = tmp();
  const activityLog = new ActivityLog({ dataDir });
  const emergencyStop = new EmergencyStop({ activityLog });
  const ks = new KillSwitch({ emergencyStop, activityLog, dataDir, pollIntervalMs: 5000 });
  ks.start();
  try {
    assert.equal(emergencyStop.isActive(), false);
    process.emit('SIGUSR2');
    await wait(20);
    assert.equal(emergencyStop.isActive(), true);
  } finally {
    ks.stop();
  }
});

test('clearSentinel removes the file so a later restart does not immediately re-trip', () => {
  const dataDir = tmp();
  const activityLog = new ActivityLog({ dataDir });
  const emergencyStop = new EmergencyStop({ activityLog });
  const ks = new KillSwitch({ emergencyStop, activityLog, dataDir });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'KILL'), 'x');
  assert.equal(ks.status().sentinelPresent, true);
  ks.clearSentinel();
  assert.equal(ks.status().sentinelPresent, false);
  assert.doesNotThrow(() => ks.clearSentinel()); // already-absent is fine, not an error
});

test('starting the kill switch with a pre-existing sentinel file trips immediately, without waiting for a poll tick', async () => {
  const dataDir = tmp();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'KILL'), 'already down');
  const activityLog = new ActivityLog({ dataDir });
  const emergencyStop = new EmergencyStop({ activityLog });
  const ks = new KillSwitch({ emergencyStop, activityLog, dataDir, pollIntervalMs: 60000 });
  ks.start();
  try {
    assert.equal(emergencyStop.isActive(), true);
  } finally {
    ks.stop();
  }
});
