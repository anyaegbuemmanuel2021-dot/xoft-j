import test from 'node:test';
import assert from 'node:assert/strict';
import { taskRow } from '../public/js/views/task-row.js';

test('task rows expose step status, attempts, dependencies and errors', () => {
  const html = taskRow({
    id: 'task-1',
    goal: 'Build a demo',
    status: 'running',
    createdAt: '2026-11-08T10:00:00.000Z',
    steps: [
      { id: 'step-1', description: 'Create files', toolName: 'files.create', status: 'completed', attempts: 1, dependsOn: [] },
      { id: 'step-2', description: 'Run checks', toolName: 'terminal.run', status: 'running', attempts: 2, dependsOn: ['step-1'] },
    ],
  });

  assert.match(html, /Step-by-step progress \(2\)/);
  assert.match(html, /1\. Create files/);
  assert.match(html, /2\. Run checks/);
  assert.match(html, /completed/);
  assert.match(html, /running/);
  assert.match(html, /2 attempts/);
  assert.match(html, /Depends on: step-1/);
  assert.ok(html.includes('<details open style='));
});

test('task row escapes untrusted step descriptions and error text', () => {
  const html = taskRow({
    id: 'task-2',
    goal: 'Check safely',
    status: 'failed',
    createdAt: '2026-11-08T10:00:00.000Z',
    steps: [{
      id: 'step-x',
      description: '<script>alert(1)</script>',
      toolName: 'test.tool',
      status: 'failed',
      attempts: 1,
      dependsOn: [],
      error: '<img src=x onerror=alert(1)>',
    }],
  });

  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x/);
});
