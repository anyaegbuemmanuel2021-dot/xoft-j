import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DomainAutonomy, DOMAINS, domainForTool } from '../src/autonomy/DomainAutonomy.js';
import { AutonomyManager } from '../src/autonomy/AutonomyManager.js';
import { ApprovalSystem } from '../src/approval/ApprovalSystem.js';
import { ActivityLog } from '../src/activity/ActivityLog.js';
import { Tool, RiskLevel } from '../src/tools/Tool.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'domain-autonomy-'));

test('domainForTool maps real registered tool names correctly and falls back to general', () => {
  assert.equal(domainForTool('send_email'), 'communication');
  assert.equal(domainForTool('device_screen_click'), 'browser');
  assert.equal(domainForTool('device_launch_app'), 'devices');
  assert.equal(domainForTool('remember_fact'), 'memory');
  assert.equal(domainForTool('generate_image'), 'media');
  assert.equal(domainForTool('some_future_tool'), 'general');
  assert.ok(DOMAINS.includes('finance')); // reserved even with no tools yet
});

test('DomainAutonomy set/get/clear round-trips and rejects unknown domains or out-of-range levels', () => {
  const da = new DomainAutonomy({ dataDir: tmp() });
  assert.equal(da.get('browser'), null);
  assert.equal(da.effectiveLevel('browser', 2), 2); // falls back to global when unset

  da.set('browser', 5);
  assert.equal(da.get('browser'), 5);
  assert.equal(da.effectiveLevel('browser', 2), 5); // override wins

  assert.throws(() => da.set('teleportation', 3), /unknown domain/);
  assert.throws(() => da.set('browser', 9), /0 to 5/);

  da.clear('browser');
  assert.equal(da.get('browser'), null);
});

test('DomainAutonomy override changes ApprovalSystem auto-approve decisions for LOW-risk tools in that domain only', () => {
  const dataDir = tmp();
  const activityLog = new ActivityLog({ dataDir });
  const autonomyManager = new AutonomyManager({ activityLog, dataDir });
  autonomyManager.set(2); // global: approval-required for LOW/EXTERNAL
  const domainAutonomy = new DomainAutonomy({ activityLog, dataDir });
  const approvalSystem = new ApprovalSystem({ activityLog, autonomyManager, domainAutonomy, userSettings: { autoApproveLow: false }, dataDir });

  const browserTool = new Tool({ name: 'device_open_url', description: 'open url', riskLevel: RiskLevel.LOW, execute: async () => ({}) });
  const commsTool = new Tool({ name: 'send_email', description: 'send', riskLevel: RiskLevel.LOW, execute: async () => ({}) });

  // Global level 2 -> LOW requires level>=3 -> both need approval by default.
  assert.equal(approvalSystem.evaluate({ tool: browserTool, input: {} }).decision, 'requires_approval');
  assert.equal(approvalSystem.evaluate({ tool: commsTool, input: {} }).decision, 'requires_approval');

  // Raise ONLY the browser domain to level 3 -> browser auto-approves, communication still doesn't.
  domainAutonomy.set('browser', 3);
  assert.equal(approvalSystem.evaluate({ tool: browserTool, input: {} }).decision, 'auto');
  assert.equal(approvalSystem.evaluate({ tool: commsTool, input: {} }).decision, 'requires_approval');
});

test('DomainAutonomy cannot move HIGH_IMPACT out of always-approval, regardless of level', () => {
  const dataDir = tmp();
  const activityLog = new ActivityLog({ dataDir });
  const autonomyManager = new AutonomyManager({ activityLog, dataDir });
  autonomyManager.set(5);
  const domainAutonomy = new DomainAutonomy({ activityLog, dataDir });
  domainAutonomy.set('finance', 5);
  const approvalSystem = new ApprovalSystem({ activityLog, autonomyManager, domainAutonomy, dataDir });
  const dangerousTool = new Tool({ name: 'wire_transfer', description: 'irreversible', riskLevel: RiskLevel.HIGH_IMPACT, execute: async () => ({}) });
  assert.equal(approvalSystem.evaluate({ tool: dangerousTool, input: {} }).decision, 'requires_approval');
});
