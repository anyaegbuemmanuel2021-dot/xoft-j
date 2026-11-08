import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomyManager } from '../src/autonomy/AutonomyManager.js';

test('AutonomyManager persists and enforces bounded autonomy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-autonomy-'));
  const manager = new AutonomyManager({ dataDir: dir });
  assert.equal(manager.get().level, 2);
  assert.equal(manager.canAutoExecute({ riskLevel: 1 }), false);
  manager.set(3);
  assert.equal(manager.canAutoExecute({ riskLevel: 1 }), true);
  assert.equal(manager.canAutoExecute({ riskLevel: 3 }), false);
  manager.set(4);
  assert.equal(manager.canAutoExecute({ riskLevel: 2, trusted: true, mission: false }), false);
  manager.set(5);
  assert.equal(manager.canAutoExecute({ riskLevel: 2, trusted: true, mission: true }), true);
});
