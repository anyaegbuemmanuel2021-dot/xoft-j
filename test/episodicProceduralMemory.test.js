import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EpisodicMemory } from '../src/memory/EpisodicMemory.js';
import { ProceduralMemory } from '../src/memory/ProceduralMemory.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));

test('EpisodicMemory records and recalls real episodes, filtered honestly', () => {
  const ep = new EpisodicMemory({ dataDir: tmp() });
  ep.record({ kind: 'task', summary: 'Sent the weekly report', outcome: 'completed', tags: ['email'] });
  ep.record({ kind: 'mission', summary: 'Mission paused on budget', outcome: 'partial', tags: ['budget'] });
  assert.throws(() => ep.record({ kind: 'task' }), /requires kind and summary/);

  const all = ep.recall({});
  assert.equal(all.length, 2);
  const tasksOnly = ep.recall({ kind: 'task' });
  assert.equal(tasksOnly.length, 1);
  assert.equal(tasksOnly[0].outcome, 'completed');

  const line = ep.timeline({ limit: 5 });
  assert.equal(line.length, 2);
  assert.match(line[0], /Mission paused on budget/); // most recent first

  const id = all[0].id;
  assert.equal(ep.forget(id), true);
  assert.equal(ep.list().length, 1);
});

test('ProceduralMemory learns from completed tasks and derives (not invents) a success rate', () => {
  const pm = new ProceduralMemory({ dataDir: tmp() });
  const task = { status: 'completed', steps: [{ toolName: 'send_email', input: { to: 'x', body: 'y' } }, { toolName: 'remember_fact', input: { content: 'z' } }] };

  const first = pm.learnFromTask('send weekly report', task);
  assert.equal(first.runCount, 1);
  assert.equal(first.successCount, 1);

  // A second identical real run increments the SAME entry rather than duplicating it.
  const second = pm.learnFromTask('send weekly report', task);
  assert.equal(second.id, first.id);
  assert.equal(second.runCount, 2);
  assert.equal(second.successCount, 2);

  // A failed run of the SAME step shape lowers the derived rate honestly.
  pm.learnFromTask('send weekly report', { ...task, status: 'failed' });
  const recalled = pm.recall('send weekly report');
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].runCount, 3);
  assert.equal(recalled[0].successCount, 2);
  assert.ok(Math.abs(recalled[0].successRate - 2 / 3) < 1e-9);

  assert.equal(pm.recall('nothing like this ever ran').length, 0);
});
