/**
 * GitWorkspace — safety net for autonomous code changes (spec section 31).
 *
 *   in-place  edit the project where it is. If it is a git repo, a baseline is recorded (HEAD sha, clean/dirty) and a
 *             backup ref `refs/xoft/backup/<task>` points at a snapshot commit of the working tree (git stash create —
 *             this does NOT touch the working tree, index or stash list).
 *   branch    create `xoft/task-<id>` from HEAD and switch to it (only when the tree is clean, otherwise it refuses —
 *             never silently carries someone's uncommitted work onto a new branch).
 *   worktree  `git worktree add <dir> -b xoft/task-<id>`: the agent works in a separate checkout; the original is untouched.
 *
 * Non-repositories fall back to in-place with `isRepo:false` (no rollback is offered, and that is reported, not hidden).
 * Only `execFile('git', [...])` with argument arrays is used — never a shell. Nothing here deletes user data:
 * rollback of an in-place run stashes the changes (recoverable with `git stash pop`) instead of resetting them away.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { EngineError, ErrorCode } from './constants.js';

const execFileAsync = promisify(execFile);

export class GitWorkspace {
  constructor({ dataDir = './data', gitCommand = 'git', timeoutMs = 20000 } = {}) {
    this.dataDir = dataDir;
    this.git = gitCommand;
    this.timeoutMs = timeoutMs;
  }

  async _git(cwd, args, { allowFail = false, raw = false } = {}) {
    try {
      const { stdout } = await execFileAsync(this.git, args, { cwd, timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
      return { ok: true, out: raw ? stdout.replace(/\s+$/, '') : stdout.trim() };
    } catch (err) {
      if (allowFail) return { ok: false, out: String(err.stdout ?? '').trim(), error: String(err.stderr ?? err.message).trim() };
      throw new EngineError(ErrorCode.UNAVAILABLE, `git ${args[0]} failed: ${String(err.stderr ?? err.message).trim().slice(0, 300)}`, { cause: err });
    }
  }

  async isAvailable() { return (await this._git(process.cwd(), ['--version'], { allowFail: true })).ok; }

  /** @returns {Promise<string|null>} repository top-level, or null if `dir` is not inside a work tree. */
  async repoRoot(dir) {
    const r = await this._git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
    return r.ok && r.out ? path.resolve(r.out) : null;
  }

  // raw: porcelain lines start with a significant space (" M file"), so only trailing whitespace may be trimmed
  async _status(root) { return (await this._git(root, ['status', '--porcelain'], { allowFail: true, raw: true })).out; }

  /**
   * Prepares the workspace for a task. Returns the directory the engine should work in plus a record that is saved on the task.
   * @param {{workingDirectory:string, mode?:'in-place'|'branch'|'worktree', taskId:string}} p
   */
  async prepare({ workingDirectory, mode = 'in-place', taskId }) {
    const base = { mode: 'in-place', requestedMode: mode, isRepo: false, cwd: workingDirectory, root: null, baseSha: null, cleanAtStart: null, backupRef: null, branch: null, worktreePath: null, notes: [] };
    if (!workingDirectory || !fs.existsSync(workingDirectory)) throw new EngineError(ErrorCode.INVALID, `Working directory does not exist: ${workingDirectory}`);
    if (!(await this.isAvailable())) { base.notes.push('git is not installed — no versioned safety net for this task'); return base; }
    const root = await this.repoRoot(workingDirectory);
    if (!root) { base.notes.push('working directory is not a git repository — no versioned safety net for this task'); return base; }
    base.isRepo = true; base.root = root;

    const head = await this._git(root, ['rev-parse', 'HEAD'], { allowFail: true });
    if (!head.ok) { base.notes.push('repository has no commits yet — cannot create a baseline'); return base; }
    base.baseSha = head.out;
    const dirty = await this._status(root);
    base.cleanAtStart = dirty === '';
    const short = String(taskId).slice(0, 8);

    if (mode === 'worktree') {
      const dir = path.join(path.dirname(root), '.xoft-worktrees', `${path.basename(root)}-${short}`);
      const branch = `xoft/task-${short}`;
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await this._git(root, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
      const rel = path.relative(root, path.resolve(workingDirectory));
      base.mode = 'worktree'; base.branch = branch; base.worktreePath = dir; base.cwd = rel && !rel.startsWith('..') ? path.join(dir, rel) : dir;
      base.notes.push(`working in an isolated worktree on branch ${branch}; your checkout is untouched`);
      return base;
    }
    if (mode === 'branch') {
      if (!base.cleanAtStart) { base.notes.push('branch mode needs a clean working tree — working in place instead (a backup ref was created)'); }
      else {
        const branch = `xoft/task-${short}`;
        await this._git(root, ['switch', '-c', branch]);
        base.mode = 'branch'; base.branch = branch;
        base.notes.push(`switched to new branch ${branch}`);
      }
    }
    // Backup snapshot of the (possibly dirty) tree without touching it. Empty output = nothing to snapshot (clean tree).
    const snap = await this._git(root, ['stash', 'create', `xoft backup before task ${short}`], { allowFail: true });
    const target = snap.ok && snap.out ? snap.out : base.baseSha;
    const ref = `refs/xoft/backup/${taskId}`;
    const upd = await this._git(root, ['update-ref', ref, target], { allowFail: true });
    if (upd.ok) base.backupRef = ref;
    base.notes.push(base.cleanAtStart ? 'working tree was clean at start' : 'working tree had uncommitted changes at start (captured in the backup ref; untracked files are not captured by git)');
    return base;
  }

  /** Ground-truth change summary from git itself (independent of what the agent claims). */
  async summarize(ws) {
    if (!ws?.isRepo) return { available: false, files: [], summary: null };
    const cwd = ws.worktreePath ?? ws.root;
    const status = await this._status(cwd);
    const files = status.split('\n').filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim() || '?', path: l.slice(3) }));
    let stat = '';
    if (ws.baseSha) stat = (await this._git(cwd, ['diff', '--stat', ws.baseSha], { allowFail: true })).out;
    let commits = 0;
    if (ws.baseSha) { const c = await this._git(cwd, ['rev-list', '--count', `${ws.baseSha}..HEAD`], { allowFail: true }); commits = Number(c.out) || 0; }
    return { available: true, files, commits, summary: stat.split('\n').slice(-1)[0] || (files.length ? `${files.length} file(s) changed` : 'no changes'), diffStat: stat.slice(0, 4000) };
  }

  /** Saves the full patch for review. Returns the file path (or null if there is nothing / not a repo). */
  async savePatch(ws, taskId) {
    if (!ws?.isRepo || !ws.baseSha) return null;
    const cwd = ws.worktreePath ?? ws.root;
    const patch = (await this._git(cwd, ['diff', ws.baseSha], { allowFail: true })).out;
    if (!patch) return null;
    const dir = path.join(this.dataDir, 'engines', 'patches');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${taskId}.patch`);
    fs.writeFileSync(file, `${patch}\n`);
    return file;
  }

  /**
   * Undo a task's changes without destroying them.
   *   worktree  → remove the worktree directory registration and keep the branch (so nothing is lost)
   *   branch    → switch back to the starting commit's branch is NOT guessed; the branch is kept, instructions returned
   *   in-place  → only when the tree was clean at start: `git stash push -u` (recoverable), never `reset --hard`
   */
  async rollback(ws, taskId) {
    if (!ws?.isRepo) throw new EngineError(ErrorCode.NOT_SUPPORTED, 'This task did not run in a git repository, so there is nothing to roll back to.');
    if (ws.mode === 'worktree') {
      await this._git(ws.root, ['worktree', 'remove', '--force', ws.worktreePath]);
      return { rolledBack: true, how: `removed worktree; branch ${ws.branch} still holds the work (delete it with: git branch -D ${ws.branch})` };
    }
    if (ws.mode === 'branch') {
      return { rolledBack: false, how: `The task's work is on branch ${ws.branch}. Review it, then merge it or run: git switch - && git branch -D ${ws.branch}` };
    }
    if (!ws.cleanAtStart) {
      return { rolledBack: false, how: `The working tree already had changes before this task, so an automatic rollback could mix them up. Review the saved patch (data/engines/patches/${taskId}.patch) and revert by hand; the pre-task snapshot is ${ws.backupRef}.` };
    }
    const dirty = await this._status(ws.root);
    if (!dirty) return { rolledBack: true, how: 'nothing to roll back — the working tree is already clean' };
    await this._git(ws.root, ['stash', 'push', '--include-untracked', '-m', `xoft-rollback-${String(taskId).slice(0, 8)}`]);
    return { rolledBack: true, how: 'changes were stashed (recover them with `git stash pop`)' };
  }

  /** Remove the isolated worktree after the user has merged/discarded it. */
  async cleanup(ws) {
    if (ws?.mode === 'worktree' && ws.worktreePath && fs.existsSync(ws.worktreePath)) await this._git(ws.root, ['worktree', 'remove', '--force', ws.worktreePath], { allowFail: true });
  }
}
