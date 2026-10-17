import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityLog } from '../src/activity/ActivityLog.js';
import { EventBus } from '../src/events/EventBus.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import { ApprovalSystem } from '../src/approval/ApprovalSystem.js';
import { TaskPlanner } from '../src/planner/TaskPlanner.js';
import { ExecutionRecordStore } from '../src/planner/ExecutionRecordStore.js';
import { ExperienceStore } from '../src/planner/ExperienceStore.js';
import { RecoveryEngine } from '../src/recovery/RecoveryEngine.js';

function makeHarness({ tool, plannedSteps, recoveryEngine = null }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-verify-test-'));
  const activityLog = new ActivityLog({ dataDir });
  const eventBus = new EventBus({ activityLog });
  const toolRegistry = new ToolRegistry({ defaultDeviceId: 'local' });
  toolRegistry.register(tool);
  const approvalSystem = new ApprovalSystem({ activityLog, eventBus, dataDir });
  const router = { async complete() { return { text: JSON.stringify({ steps: plannedSteps, blockedReason: null }) }; } };
  const executionRecordStore = new ExecutionRecordStore({ dataDir });
  const experienceStore = new ExperienceStore({ dataDir });
  const taskPlanner = new TaskPlanner({ router, toolRegistry, approvalSystem, activityLog, memory: null, eventBus, executionRecordStore, experienceStore, recoveryEngine, dataDir });
  return { taskPlanner, executionRecordStore, experienceStore };
}

describe('Self-verification', () => {
  test('a tool with no verify() handler is marked unverified, not silently assumed successful', async () => {
    const tool = { name: 'test.no_verify', description: 'x', inputSchema: {}, riskLevel: 0, requiredPermissions: [], status: 'implemented', async run() { return { ok: true }; } };
    const { taskPlanner } = makeHarness({ tool, plannedSteps: [{ id: 's1', toolName: tool.name, input: {}, dependsOn: [], description: 'x' }] });
    const created = await taskPlanner.plan('goal');
    const result = await taskPlanner.execute(created.id);
    const step = result.steps[0];
    assert.equal(step.status, 'completed');
    assert.equal(step.verification.verified, null, 'must be null (unknown), not true');
    assert.match(step.verification.note, /no verify\(\) handler/);
  });

  test("a tool's own verify() handler is actually called with the real input/result, and its verdict is trusted", async () => {
    let calledWith = null;
    const tool = {
      name: 'test.verified',
      description: 'x', inputSchema: {}, riskLevel: 0, requiredPermissions: [], status: 'implemented',
      async run(input) { return { sent: true, to: input.to }; },
      async verify(input, result) {
        calledWith = { input, result };
        return { verified: result.to === input.to, note: 'checked recipient echoed back matches' };
      },
    };
    const { taskPlanner } = makeHarness({ tool, plannedSteps: [{ id: 's1', toolName: tool.name, input: { to: 'john' }, dependsOn: [], description: 'x' }] });
    const created = await taskPlanner.plan('goal');
    const result = await taskPlanner.execute(created.id);
    assert.equal(result.steps[0].verification.verified, true);
    assert.ok(calledWith, 'verify() must actually be invoked');
    assert.equal(calledWith.input.to, 'john');
    assert.equal(calledWith.result.to, 'john');
  });

  test('a verify() handler that itself throws is reported honestly, not treated as verified', async () => {
    const tool = {
      name: 'test.broken_verify',
      description: 'x', inputSchema: {}, riskLevel: 0, requiredPermissions: [], status: 'implemented',
      async run() { return { ok: true }; },
      async verify() { throw new Error('verification backend unreachable'); },
    };
    const { taskPlanner } = makeHarness({ tool, plannedSteps: [{ id: 's1', toolName: tool.name, input: {}, dependsOn: [], description: 'x' }] });
    const created = await taskPlanner.plan('goal');
    const result = await taskPlanner.execute(created.id);
    assert.equal(result.steps[0].verification.verified, false);
    assert.match(result.steps[0].verification.note, /verification backend unreachable/);
  });

  test('a duplicate-prevented (reused) execution carries its original verification forward, not a fresh assumption', async () => {
    const tool = {
      name: 'test.dedup_verify',
      description: 'x', inputSchema: {}, riskLevel: 0, requiredPermissions: [], status: 'implemented',
      async run() { return { ok: true }; },
      async verify() { return { verified: true, note: 'confirmed via provider receipt' }; },
    };
    const { taskPlanner } = makeHarness({ tool, plannedSteps: [{ id: 's1', toolName: tool.name, input: {}, dependsOn: [], description: 'x' }] });
    const created = await taskPlanner.plan('goal');
    await taskPlanner.execute(created.id);
    const second = await taskPlanner.execute(created.id); // re-invoked on an already-completed task
    assert.equal(second.steps[0].verification.verified, true);
    assert.match(second.steps[0].verification.note, /confirmed via provider receipt|reused/);
  });
});

describe('Experience store', () => {
  test('a real recovery attempt and its real outcome are recorded, retrievable, and confidence is derived (not fabricated)', async () => {
    let callCount = 0;
    const tool = {
      name: 'test.flaky_recoverable',
      description: 'x', inputSchema: { to: 'string' }, riskLevel: 0, requiredPermissions: [], status: 'implemented',
      async run() {
        callCount += 1;
        if (callCount === 1) throw new Error('temporary glitch');
        return { ok: true };
      },
    };
    const recoveryEngine = {
      async chooseStrategy() {
        return { diagnosis: 'transient', strategy: 'retry_same', toolName: null, inputPatch: {}, reason: 'looked transient' };
      },
    };
    const { taskPlanner, experienceStore } = makeHarness({
      tool,
      plannedSteps: [{ id: 's1', toolName: tool.name, input: { to: 'x' }, dependsOn: [], description: 'x' }],
      recoveryEngine,
    });
    const created = await taskPlanner.plan('goal');
    const result = await taskPlanner.execute(created.id);
    assert.equal(result.status, 'completed');

    const experiences = experienceStore.relevantFor({ toolName: tool.name });
    assert.equal(experiences.length, 1);
    assert.equal(experiences[0].recoveryStrategy, 'retry_same');
    assert.equal(experiences[0].recoveryOutcome, 'recovered');
    assert.equal(experiences[0].failureCategory, 'transient');

    // No fabricated confidence — it's derived from real history.
    const conf = experienceStore.confidenceFor({ toolName: tool.name, failureCategory: 'transient', recoveryStrategy: 'retry_same' });
    assert.equal(conf.confidence, 1);
    assert.equal(conf.sampleSize, 1);
  });

  test('confidenceFor returns null (not 0) when there is no history, so "no data" is never confused with "always fails"', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-exp-empty-'));
    const store = new ExperienceStore({ dataDir });
    assert.equal(store.confidenceFor({ toolName: 'nothing.seen', failureCategory: 'x', recoveryStrategy: 'y' }), null);
  });

  test('an aborted recovery is recorded as aborted, not silently dropped', async () => {
    const tool = { name: 'test.always_fails', description: 'x', inputSchema: {}, riskLevel: 0, requiredPermissions: [], status: 'implemented', async run() { throw new Error('permanent problem'); } };
    const recoveryEngine = { async chooseStrategy() { return { diagnosis: 'unsupported', strategy: 'abort', reason: 'no safe recovery' }; } };
    const { taskPlanner, experienceStore } = makeHarness({
      tool, plannedSteps: [{ id: 's1', toolName: tool.name, input: {}, dependsOn: [], description: 'x' }], recoveryEngine,
    });
    const created = await taskPlanner.plan('goal');
    const result = await taskPlanner.execute(created.id);
    assert.equal(result.status, 'failed');
    const experiences = experienceStore.relevantFor({ toolName: tool.name });
    assert.equal(experiences.length, 1);
    assert.equal(experiences[0].recoveryOutcome, 'aborted');
  });

  test('exhausted retries with no recovery engine are recorded as exhausted', async () => {
    const tool = { name: 'test.no_recovery', description: 'x', inputSchema: {}, riskLevel: 0, requiredPermissions: [], status: 'implemented', async run() { throw new Error('nope'); } };
    const { taskPlanner, experienceStore } = makeHarness({ tool, plannedSteps: [{ id: 's1', toolName: tool.name, input: {}, dependsOn: [], description: 'x' }] });
    const created = await taskPlanner.plan('goal');
    const result = await taskPlanner.execute(created.id);
    assert.equal(result.status, 'failed');
    const experiences = experienceStore.relevantFor({ toolName: tool.name });
    assert.equal(experiences.length, 1);
    assert.equal(experiences[0].recoveryOutcome, 'exhausted');
  });

  test('ExperienceStore.inputSignature captures shape, not values', () => {
    assert.equal(ExperienceStore.inputSignature({ to: 'john', body: 'secret text' }), 'body,to');
    assert.equal(ExperienceStore.inputSignature({}), '(no input)');
  });
});

describe('RecoveryEngine + ExperienceStore integration', () => {
  test('chooseStrategy passes real past experience into the prompt as advisory context', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-recovery-exp-'));
    const experienceStore = new ExperienceStore({ dataDir });
    experienceStore.record({ toolName: 'browser.click', failureCategory: 'transient', errorMessage: 'selector not found', recoveryStrategy: 'alternative_tool', recoveryOutcome: 'recovered', inputSignature: 'selector' });

    let capturedPrompt = null;
    const toolRegistry = { schemasForAI: () => [{ name: 'browser.click', description: 'x', inputSchema: {} }], has: () => true, get: () => ({ riskLevel: 0 }) };
    const router = { async complete(_type, params) { capturedPrompt = params.messages[0].content; return { text: JSON.stringify({ diagnosis: 'transient', strategy: 'abort', toolName: null, inputPatch: {}, reason: 'test' }) }; } };
    const engine = new RecoveryEngine({ router, toolRegistry });

    await engine.chooseStrategy({ goal: 'test', step: { description: 'click', toolName: 'browser.click', input: {} }, error: new Error('boom'), experienceStore });
    const parsed = JSON.parse(capturedPrompt);
    assert.ok(Array.isArray(parsed.pastExperience));
    assert.equal(parsed.pastExperience[0].outcome, 'recovered');
  });
});
