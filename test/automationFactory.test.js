import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutomationFactory } from '../src/automation/AutomationFactory.js';
import { RulesEngine } from '../src/automation/RulesEngine.js';
import { WorkflowEngine } from '../src/workflows/WorkflowEngine.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import { Tool, RiskLevel } from '../src/tools/Tool.js';
import { ActivityLog } from '../src/activity/ActivityLog.js';
import { ApprovalSystem } from '../src/approval/ApprovalSystem.js';
import { EventBus } from '../src/events/EventBus.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'automation-'));

function harness(scriptedReplies) {
  const dataDir = tmp();
  const activityLog = new ActivityLog({ dataDir });
  const eventBus = new EventBus({ activityLog });
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(new Tool({ name: 'send_email', description: 'send an email', riskLevel: RiskLevel.EXTERNAL, execute: async () => ({ success: true }) }));
  toolRegistry.register(new Tool({ name: 'search_web', description: 'search the web', riskLevel: RiskLevel.SAFE, execute: async () => ({ success: true, results: [] }) }));
  const approvalSystem = new ApprovalSystem({ activityLog, eventBus, dataDir });
  const memory = { recallStructured: () => [] };
  let call = 0;
  const router = { complete: async () => ({ text: scriptedReplies[Math.min(call++, scriptedReplies.length - 1)] }) };
  const rulesEngine = new RulesEngine({ router, toolRegistry, approvalSystem, activityLog, memory, eventBus, dataDir });
  const workflowEngine = new WorkflowEngine({ toolRegistry, activityLog, eventBus, memory, dataDir });
  const factory = new AutomationFactory({ router, toolRegistry, rulesEngine, workflowEngine, activityLog });
  return { factory, rulesEngine, workflowEngine, toolRegistry };
}

test('AutomationFactory builds a rule when the request is a single trigger/action', async () => {
  const ruleJson = JSON.stringify({ trigger: { type: 'manual' }, condition: null, actionDescription: 'search the web for news', toolName: 'search_web' });
  const { factory, rulesEngine } = harness([
    JSON.stringify({ kind: 'rule', reason: 'single trigger, single action' }),
    ruleJson,
  ]);
  const result = await factory.create('when I ask, search the web for news');
  assert.equal(result.kind, 'rule');
  assert.equal(rulesEngine.list().length, 1);
  assert.equal(result.automation.toolName, 'search_web');
});

test('AutomationFactory builds a workflow when the request chains multiple tools, and validates tool names', async () => {
  const draft = JSON.stringify({
    name: 'notify then log',
    triggerEventType: 'task_completed',
    steps: [{ toolName: 'search_web', input: { query: 'status' } }, { toolName: 'send_email', input: { to: 'me@example.com', body: '{{steps.0.result.results}}' } }],
  });
  const { factory, workflowEngine } = harness([
    JSON.stringify({ kind: 'workflow', reason: 'chains two distinct tools' }),
    draft,
  ]);
  const result = await factory.create('when a task completes, search the web then email me the results');
  assert.equal(result.kind, 'workflow');
  assert.equal(workflowEngine.list().length, 1);
  assert.equal(result.automation.steps.length, 2);
});

test('AutomationFactory refuses a drafted workflow that invents a tool name', async () => {
  const draft = JSON.stringify({ name: 'bad', triggerEventType: 'task_completed', steps: [{ toolName: 'launch_missiles', input: {} }] });
  const { factory } = harness([JSON.stringify({ kind: 'workflow', reason: 'x' }), draft]);
  await assert.rejects(() => factory.create('do the dangerous thing'), /unknown tool 'launch_missiles'/);
});

test('AutomationFactory.list() merges both engines, newest first', async () => {
  const { factory } = harness([
    JSON.stringify({ kind: 'rule', reason: 'r' }),
    JSON.stringify({ trigger: { type: 'manual' }, condition: null, actionDescription: 'a', toolName: 'search_web' }),
  ]);
  await factory.create('when I say go, search the web');
  const list = factory.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'rule');
});
