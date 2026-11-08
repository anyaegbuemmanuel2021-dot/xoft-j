'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeEnv } = require('./helpers/fsEnv');
const { OperationJournal } = require('../src/runtime/OperationJournal');
const { ActionPolicy, classify } = require('../src/runtime/ActionPolicy');
const { HaltGuard } = require('../src/runtime/HaltGuard');
const { RuntimeGuard } = require('../src/runtime/RuntimeGuard');

test('journal records begin/end, survives restart, and flags interrupted operations', (t) => {
  const e = makeEnv(); t.after(e.cleanup);
  const a = e.journal.begin({ action: 'EDIT', target: '/x', reason: 'r', missionId: 'M9', agent: 'coder' });
  e.journal.complete(a, { result: { success: true }, newState: { sha256: 'abc' }, rollback: { available: true, kind: 'restore_checkpoint' } });
  const b = e.journal.begin({ action: 'DELETE', target: '/y' }); // never completed = crash mid-action
  const j2 = new OperationJournal({ stateDir: e.stateDir });
  assert.equal(j2.get(a).status, 'completed'); assert.equal(j2.get(a).missionId, 'M9'); assert.equal(j2.get(a).agent, 'coder');
  assert.deepEqual(j2.interrupted().map((o) => o.id), [b]);
  assert.equal(j2.begin({ action: 'X', target: 'z' }), b + 1); // ids keep increasing across restarts
});

test('journal tolerates a corrupt line without losing other records', (t) => {
  const e = makeEnv(); t.after(e.cleanup);
  const a = e.journal.begin({ action: 'A', target: '/a' }); e.journal.complete(a, { result: { success: true } });
  fs.appendFileSync(e.journal.file, '{"type":"begin","id":\n');
  const j2 = new OperationJournal({ stateDir: e.stateDir });
  assert.equal(j2.corruptLines, 1); assert.equal(j2.get(a).status, 'completed');
});

test('failed operations are journaled as failed with the error, and never claim rollback', async (t) => {
  const e = makeEnv(); t.after(e.cleanup);
  const r = await e.fsx.edit({ path: 'missing.txt', find: 'a', replace: 'b' });
  assert.equal(r.success, false);
  const op = e.journal.get(r.operationId);
  assert.equal(op.status, 'failed'); assert.ok(op.result.error); assert.equal(op.rollback.available, false);
});

test('policy: unknown actions are denied; deny/confirm overrides block with clear reasons', async (t) => {
  assert.equal(classify('file.delete'), 'file.delete'); assert.equal(classify('browser.click'), 'browser.interact'); assert.equal(classify('bogus.thing'), null);
  assert.equal(new ActionPolicy().decide('file.format_disk').level, 'deny');
  assert.throws(() => new ActionPolicy({ 'nope.class': 'allow' }), /unknown policy class/);
  assert.throws(() => new ActionPolicy({ 'file.delete': 'maybe' }), /allow\|confirm\|deny/);
  const e = makeEnv({ files: { 'a.txt': 'a' }, policy: { 'file.delete': 'deny', 'file.write': 'confirm' } }); t.after(e.cleanup);
  const d = await e.fsx.delete({ path: 'a.txt' });
  assert.equal(d.success, false); assert.equal(d.blocked, true); assert.match(d.error, /denied by local policy/);
  assert.equal(fs.existsSync(path.join(e.root, 'a.txt')), true);
  const w = await e.fsx.write({ path: 'b.txt', content: 'x' });
  assert.equal(w.blocked, true); assert.match(w.error, /requires human approval/);
  assert.equal(fs.existsSync(path.join(e.root, 'b.txt')), false);
  assert.ok(fs.readFileSync(path.join(e.stateDir, 'audit.log'), 'utf8').includes('denied.policy'));
});

test('HALT sentinel and halt() stop every mutation; only a human resume() restores service', async (t) => {
  const e = makeEnv({ files: { 'a.txt': 'a' } }); t.after(e.cleanup);
  fs.writeFileSync(path.join(e.stateDir, 'HALT'), '');
  for (const r of [await e.fsx.write({ path: 'n.txt', content: 'x' }), await e.fsx.delete({ path: 'a.txt' }), await e.fsx.read({ path: 'a.txt' })]) { assert.equal(r.success, false); assert.equal(r.blocked, true); assert.match(r.error, /HALTED/); }
  assert.equal(fs.existsSync(path.join(e.root, 'n.txt')), false); assert.equal(fs.existsSync(path.join(e.root, 'a.txt')), true);
  e.halt.resume();
  assert.equal((await e.fsx.read({ path: 'a.txt' })).success, true);
});

test('core emergency stop syncs into a local halt, and only clears a halt that core itself set', (t) => {
  const e = makeEnv(); t.after(e.cleanup);
  e.halt.syncFromCore(true); assert.equal(e.halt.isHalted(), true);
  e.halt.syncFromCore(false); assert.equal(e.halt.isHalted(), false);
  e.halt.halt('local operator stop'); e.halt.syncFromCore(false);
  assert.equal(e.halt.isHalted(), true); // core saying "all clear" must NOT lift a local halt
});

test('halt aborts an in-flight tracked operation immediately', async (t) => {
  const e = makeEnv(); t.after(e.cleanup);
  const tr = e.halt.track(); let aborted = false; tr.signal.addEventListener('abort', () => { aborted = true; });
  e.halt.halt('stop now');
  assert.equal(aborted, true);
  assert.throws(() => e.halt.track(), /HALTED/);
});

test('mutation rate limit denies bursts', async (t) => {
  const e = makeEnv({ maxMutationsPerMinute: 3 }); t.after(e.cleanup);
  const results = []; for (let i = 0; i < 5; i++) results.push(await e.fsx.create({ path: `f${i}.txt`, content: 'x' }));
  assert.deepEqual(results.map((r) => r.success), [true, true, true, false, false]);
  assert.match(results[3].error, /Rate limit/);
});
