import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SelfDevelopmentEngine } from '../src/selfdev/SelfDevelopmentEngine.js';
import { ToolGenerator } from '../src/selfdev/ToolGenerator.js';
import { DeploymentManager } from '../src/selfdev/DeploymentManager.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import { ActivityLog } from '../src/activity/ActivityLog.js';

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolgen-repo-'));
  fs.mkdirSync(path.join(root, 'src/tools/builtins/generated'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'check.js'), 'process.exit(0);\n'); // trivial always-green sandbox test command
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolgen-data-'));
  const activityLog = new ActivityLog({ dataDir });
  const selfDev = new SelfDevelopmentEngine({ repoRoot: root, dataDir, activityLog, testCommand: ['node', 'check.js'], testTimeoutMs: 20000 });
  const toolRegistry = new ToolRegistry();
  return { root, dataDir, activityLog, selfDev, toolRegistry };
}

const VALID_TOOL_CODE = `export function buildTool(deps) {
  return {
    name: 'count_words',
    description: 'Counts words in a string',
    riskLevel: 0,
    execute: async (input) => ({ success: true, count: String(input?.text ?? '').split(/\\s+/).filter(Boolean).length }),
  };
}
`;

test('ToolGenerator.propose refuses drafted code that does not export buildTool', async () => {
  const { selfDev, toolRegistry, activityLog } = repo();
  const router = { complete: async () => ({ text: 'export function notTheRightExport() {}' }) };
  const gen = new ToolGenerator({ router, selfDev, toolRegistry, activityLog });
  await assert.rejects(() => gen.propose('a tool that does nothing useful'), /did not export the required buildTool/);
});

test('ToolGenerator.propose files a real SelfDevelopmentEngine proposal under generated/, and registerApplied only works after apply()', async () => {
  const { selfDev, toolRegistry, activityLog } = repo();
  const router = { complete: async () => ({ text: VALID_TOOL_CODE }) };
  const gen = new ToolGenerator({ router, selfDev, toolRegistry, activityLog });

  const proposal = await gen.propose('a tool that counts words in a string', { toolName: 'count_words' });
  assert.equal(proposal.status, 'proposed');
  const relFile = Object.keys(proposal.files)[0];
  assert.match(relFile, /^src\/tools\/builtins\/generated\/count_words\.js$/);

  // Not registerable before it's applied — registerApplied must not bypass the human-approval gate.
  await assert.rejects(() => gen.registerApplied(proposal.id), /has not been applied yet/);

  const sandboxResult = await selfDev.sandboxTest(proposal.id);
  assert.equal(sandboxResult.ok, true);
  await selfDev.apply(proposal.id, { approvedBy: 'lion' });

  const tool = await gen.registerApplied(proposal.id);
  assert.equal(tool.name, 'count_words');
  assert.equal(toolRegistry.has('count_words'), true);
  const result = await toolRegistry.get('count_words').run({ text: 'four score and seven' });
  assert.equal(result.count, 4);
});

test('DeploymentManager promotes a change when the watchdog stays healthy through the canary window', async () => {
  const { selfDev, activityLog } = repo();
  const proposal = selfDev.propose({ title: 'safe change', files: { 'src/tools/builtins/generated/noop.js': 'export function buildTool(){return {name:"noop",description:"x",riskLevel:0,execute:async()=>({success:true})};}\n' } });
  await selfDev.sandboxTest(proposal.id);
  const watchdog = { diagnose: async () => ({ checks: [{ name: 'system', level: 'OK', detail: 'fine' }] }) };
  const dm = new DeploymentManager({ selfDev, watchdog, activityLog, canaryWindowMs: 60, pollIntervalMs: 15 });
  const outcome = await dm.deploy(proposal.id, { approvedBy: 'lion' });
  assert.equal(outcome.status, 'promoted');
  assert.equal(selfDev.get(proposal.id).status, 'applied');
});

test('DeploymentManager automatically rolls back when the watchdog reports CRITICAL during the canary window', async () => {
  const { root, selfDev, activityLog } = repo();
  const proposal = selfDev.propose({ title: 'risky change', files: { 'src/tools/builtins/generated/noop2.js': 'export function buildTool(){return {name:"noop2",description:"x",riskLevel:0,execute:async()=>({success:true})};}\n' } });
  await selfDev.sandboxTest(proposal.id);
  let calls = 0;
  const watchdog = { diagnose: async () => { calls += 1; return calls === 1 ? { checks: [{ name: 'system', level: 'OK', detail: 'fine' }] } : { checks: [{ name: 'provider', level: 'CRITICAL', detail: 'all providers down' }] }; } };
  const dm = new DeploymentManager({ selfDev, watchdog, activityLog, canaryWindowMs: 120, pollIntervalMs: 15 });
  const outcome = await dm.deploy(proposal.id, { approvedBy: 'lion' });
  assert.equal(outcome.status, 'rolled_back');
  assert.match(outcome.reason, /provider — all providers down/);
  assert.equal(selfDev.get(proposal.id).status, 'rolled_back');
  // The rolled-back file must be gone from the live tree again.
  assert.equal(fs.existsSync(path.join(root, 'src/tools/builtins/generated/noop2.js')), false);
});
