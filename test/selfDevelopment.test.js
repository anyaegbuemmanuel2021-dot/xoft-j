import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SelfDevelopmentEngine } from '../src/selfdev/SelfDevelopmentEngine.js';

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-repo-'));
  fs.mkdirSync(path.join(root, 'src/security'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/util.js'), 'export const v = 1;\n');
  fs.writeFileSync(path.join(root, 'src/security/guard.js'), 'export const g = 1;\n');
  fs.writeFileSync(path.join(root, 'check.js'), 'import { v } from "./src/util.js"; if (v !== 2) process.exit(1);\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  const eng = new SelfDevelopmentEngine({ repoRoot: root, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sd-data-')), testCommand: ['node', 'check.js'], testTimeoutMs: 20000 });
  return { root, eng };
}
const read = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');

test('protected modules, traversal and absolute paths are rejected at proposal time', () => {
  const { eng } = repo();
  for (const f of ['src/security/guard.js', 'src/approval/x.js', 'src/selfdev/SelfDevelopmentEngine.js', '.env', '../evil.js', '/etc/passwd', 'data/x.json', 'node_modules/x/index.js']) {
    assert.throws(() => eng.propose({ title: 't', files: { [f]: 'x' } }), /protected|escapes|outside/, f);
  }
});

test('propose never touches the live tree; sandbox test passes only when the change is good', async () => {
  const { root, eng } = repo();
  const good = eng.propose({ title: 'v2', files: { 'src/util.js': 'export const v = 2;\n' } });
  assert.equal(read(root, 'src/util.js'), 'export const v = 1;\n');
  const r = await eng.sandboxTest(good.id);
  assert.equal(r.ok, true);
  assert.equal(read(root, 'src/util.js'), 'export const v = 1;\n', 'live file unchanged after sandbox run');
  const bad = eng.propose({ title: 'broken', files: { 'src/util.js': 'export const v = ;\n' } });
  const rb = await eng.sandboxTest(bad.id);
  assert.equal(rb.ok, false); assert.match(rb.steps[0].name, /syntax/);
  const wrong = eng.propose({ title: 'wrong', files: { 'src/util.js': 'export const v = 3;\n' } });
  assert.equal((await eng.sandboxTest(wrong.id)).ok, false, 'tests fail -> not verified');
});

test('apply requires a named approver and a passing sandbox; is idempotent; rollback restores', async () => {
  const { root, eng } = repo();
  const p = eng.propose({ title: 'v2', files: { 'src/util.js': 'export const v = 2;\n', 'src/new.js': 'export const n = 1;\n' } });
  await assert.rejects(() => eng.apply(p.id, { approvedBy: 'me' }), /not passed sandbox/);
  await eng.sandboxTest(p.id);
  await assert.rejects(() => eng.apply(p.id), /approvedBy/);
  assert.equal(read(root, 'src/util.js'), 'export const v = 1;\n');
  const applied = await eng.apply(p.id, { approvedBy: 'ikye' });
  assert.equal(applied.status, 'applied'); assert.equal(read(root, 'src/util.js'), 'export const v = 2;\n');
  await assert.rejects(() => eng.apply(p.id, { approvedBy: 'ikye' }), /already applied/);
  eng.rollback(p.id);
  assert.equal(read(root, 'src/util.js'), 'export const v = 1;\n'); assert.equal(fs.existsSync(path.join(root, 'src/new.js')), false, 'newly created file removed');
  assert.equal(eng.get(p.id).status, 'rolled_back');
});

test('emergency stop blocks testing and applying', async () => {
  const { root } = repo();
  const eng = new SelfDevelopmentEngine({ repoRoot: root, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sd-')), emergencyStop: { isActive: () => true } });
  const p = eng.propose({ title: 't', files: { 'src/util.js': 'export const v = 2;\n' } });
  await assert.rejects(() => eng.sandboxTest(p.id), /Emergency stop/);
  await assert.rejects(() => eng.apply(p.id, { approvedBy: 'x' }), /Emergency stop/);
});

test('invalid proposal ids are rejected (no path injection through the id)', () => {
  const { eng } = repo();
  assert.throws(() => eng.get('../../etc/passwd'), /invalid proposal id/);
});
