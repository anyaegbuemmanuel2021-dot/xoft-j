import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitWorkspace } from '../src/engines/GitWorkspace.js';

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-git-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
function repo() {
  const dir = fs.realpathSync(tmp());
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('non-repository / missing directory are handled without throwing (no safety net, and it says so)', { skip: !hasGit }, async () => {
  const g = new GitWorkspace({ dataDir: tmp() });
  const plain = tmp();
  const ws = await g.prepare({ workingDirectory: plain, taskId: 'abcd1234' });
  assert.equal(ws.isRepo, false); assert.equal(ws.cwd, plain); assert.match(ws.notes.join(' '), /not a git repository/);
  await assert.rejects(() => g.prepare({ workingDirectory: path.join(plain, 'ghost'), taskId: 'x' }), /does not exist/);
  await assert.rejects(() => g.rollback(ws, 'abcd1234'), /not run in a git repository|nothing to roll back/i);
  assert.deepEqual(await g.summarize(ws), { available: false, files: [], summary: null });
});

test('in-place: records baseline + backup ref without touching the tree; summary and patch reflect real changes', { skip: !hasGit }, async () => {
  const dir = repo(); const g = new GitWorkspace({ dataDir: tmp() });
  const before = git(dir, 'rev-parse', 'HEAD');
  const ws = await g.prepare({ workingDirectory: dir, taskId: 'task-aaaa-bbbb' });
  assert.equal(ws.isRepo, true); assert.equal(ws.mode, 'in-place'); assert.equal(ws.baseSha, before); assert.equal(ws.cleanAtStart, true);
  assert.equal(git(dir, 'status', '--porcelain'), '', 'preparing must not modify the working tree');
  assert.equal(git(dir, 'rev-parse', 'refs/xoft/backup/task-aaaa-bbbb'), before);
  assert.equal(git(dir, 'stash', 'list'), '', 'and must not pollute the stash list');

  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n'); fs.writeFileSync(path.join(dir, 'new.txt'), 'n\n');
  const s = await g.summarize(ws);
  assert.equal(s.available, true); assert.deepEqual(s.files.map((f) => f.path).sort(), ['a.txt', 'new.txt']);
  const patch = await g.savePatch(ws, 'task-aaaa-bbbb');
  assert.match(fs.readFileSync(patch, 'utf8'), /\+two/);
});

test('in-place with pre-existing uncommitted work: snapshot is captured in the backup ref; automatic rollback is refused (would mix work)', { skip: !hasGit }, async () => {
  const dir = repo(); fs.writeFileSync(path.join(dir, 'a.txt'), 'mine, uncommitted\n');
  const g = new GitWorkspace({ dataDir: tmp() });
  const ws = await g.prepare({ workingDirectory: dir, taskId: 'dirty-task-1' });
  assert.equal(ws.cleanAtStart, false);
  const snap = git(dir, 'show', `${ws.backupRef}:a.txt`);
  assert.equal(snap, 'mine, uncommitted', 'the user\'s uncommitted edit is preserved in the backup ref');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'mine, uncommitted\n');
  const rb = await g.rollback(ws, 'dirty-task-1');
  assert.equal(rb.rolledBack, false); assert.match(rb.how, /already had changes/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'mine, uncommitted\n', 'nothing was destroyed');
});

test('in-place rollback on a clean start stashes the agent\'s changes (recoverable) instead of resetting them away', { skip: !hasGit }, async () => {
  const dir = repo(); const g = new GitWorkspace({ dataDir: tmp() });
  const ws = await g.prepare({ workingDirectory: dir, taskId: 'clean-task-1' });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'agent edit\n'); fs.writeFileSync(path.join(dir, 'agent-new.txt'), 'x\n');
  const rb = await g.rollback(ws, 'clean-task-1');
  assert.equal(rb.rolledBack, true);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\n');
  assert.match(git(dir, 'stash', 'list'), /xoft-rollback-clean-ta/);
  git(dir, 'stash', 'pop');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'agent edit\n', 'the work is recoverable');
});

test('worktree mode: the agent works in an isolated checkout on its own branch; the original tree is untouched; rollback removes the worktree but keeps the branch', { skip: !hasGit }, async () => {
  const dir = repo(); fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty in main checkout\n');
  const g = new GitWorkspace({ dataDir: tmp() });
  const ws = await g.prepare({ workingDirectory: dir, mode: 'worktree', taskId: 'wt-task-0001' });
  assert.equal(ws.mode, 'worktree'); assert.notEqual(ws.cwd, dir); assert.ok(fs.existsSync(ws.cwd));
  assert.equal(ws.branch, 'xoft/task-wt-task-');
  assert.equal(fs.readFileSync(path.join(ws.cwd, 'a.txt'), 'utf8'), 'one\n', 'worktree starts from HEAD, not from the dirty tree');
  fs.writeFileSync(path.join(ws.cwd, 'b.txt'), 'agent\n');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'dirty in main checkout\n');
  assert.ok(!fs.existsSync(path.join(dir, 'b.txt')));
  assert.deepEqual((await g.summarize(ws)).files.map((f) => f.path), ['b.txt']);
  const rb = await g.rollback(ws, 'wt-task-0001');
  assert.equal(rb.rolledBack, true); assert.ok(!fs.existsSync(ws.worktreePath));
  assert.match(git(dir, 'branch', '--list', ws.branch), /xoft\/task-wt-task-/);
});

test('branch mode: needs a clean tree (otherwise falls back to in-place and says so); on a clean tree it creates and switches to the task branch', { skip: !hasGit }, async () => {
  const g = new GitWorkspace({ dataDir: tmp() });
  const dirty = repo(); fs.writeFileSync(path.join(dirty, 'a.txt'), 'dirty\n');
  const w1 = await g.prepare({ workingDirectory: dirty, mode: 'branch', taskId: 'br-dirty-01' });
  assert.equal(w1.mode, 'in-place'); assert.match(w1.notes.join(' '), /needs a clean working tree/);
  assert.notEqual(git(dirty, 'rev-parse', '--abbrev-ref', 'HEAD').startsWith('xoft/'), true);
  const clean = repo();
  const w2 = await g.prepare({ workingDirectory: clean, mode: 'branch', taskId: 'br-clean-01' });
  assert.equal(w2.mode, 'branch'); assert.equal(git(clean, 'rev-parse', '--abbrev-ref', 'HEAD'), 'xoft/task-br-clean');
  const rb = await g.rollback(w2, 'br-clean-01');
  assert.equal(rb.rolledBack, false); assert.match(rb.how, /Review it, then merge/);
});
