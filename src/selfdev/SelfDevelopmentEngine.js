import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

/**
 * SelfDevelopmentEngine — SAFE FOUNDATION only. It never edits the live tree on
 * its own. Pipeline:
 *   propose (validated, stored)  ->  sandboxTest (copy of the repo, syntax check +
 *   test run)  ->  apply (needs a named human approver + a passing sandbox result;
 *   backs up originals, re-checks syntax, auto-rolls back on failure)  ->  rollback.
 *
 * Not implemented here: generating the patch content (a caller — a human or an
 * LLM-backed agent — supplies file contents), canary/staged deployment, and
 * performance checks. Safety-critical modules are PROTECTED: they can be read
 * but a proposal touching them is rejected, so XOFT cannot loosen its own
 * approval, permission, emergency-stop or self-modification guards.
 */
export const PROTECTED = [
  'src/security/', 'src/approval/', 'src/selfdev/', 'src/autonomy/', 'src/privacy/', 'src/watchdog/',
  'src/tools/ToolRegistry.js', 'src/tools/Tool.js', '.env', '.git/', 'node_modules/', 'data/', 'package-lock.json',
];
const COPY_EXCLUDE = new Set(['node_modules', '.git', 'data']);
const MAX_FILES = 20;
const MAX_BYTES = 300_000;

function run(cmd, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'test' } });
    let out = '';
    const cap = (d) => { out = (out + d).slice(-20_000); };
    child.stdout.on('data', cap); child.stderr.on('data', cap);
    const timer = setTimeout(() => { child.kill('SIGKILL'); out += '\n[killed: timeout]'; }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, output: out }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 1, output: err.message }); });
  });
}

export class SelfDevelopmentEngine {
  constructor({ repoRoot, dataDir, activityLog, emergencyStop, testCommand = ['node', '--test'], testTimeoutMs = 180_000 } = {}) {
    this.repoRoot = path.resolve(repoRoot);
    this.dir = path.join(path.resolve(dataDir), 'selfdev');
    this.activityLog = activityLog; this.emergencyStop = emergencyStop;
    this.testCommand = testCommand; this.testTimeoutMs = testTimeoutMs;
    fs.mkdirSync(path.join(this.dir, 'backups'), { recursive: true });
  }

  _file(id) { return path.join(this.dir, `${id}.json`); }
  _read(id) {
    if (!/^[0-9a-f-]{36}$/.test(String(id))) throw new Error('invalid proposal id');
    try { return JSON.parse(fs.readFileSync(this._file(id), 'utf8')); } catch { throw new Error(`Proposal '${id}' not found`); }
  }
  _write(p) { fs.writeFileSync(this._file(p.id), JSON.stringify(p, null, 2)); return p; }
  _log(type, detail) { this.activityLog?.log({ type, detail }); }

  /** Returns a normalized repo-relative path or throws. */
  _checkPath(rel) {
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error('invalid file path');
    const abs = path.resolve(this.repoRoot, rel);
    const norm = path.relative(this.repoRoot, abs).split(path.sep).join('/');
    if (norm.startsWith('..') || path.isAbsolute(norm)) throw new Error(`Path escapes the repository: ${rel}`);
    for (const p of PROTECTED) if (norm === p || norm.startsWith(p.endsWith('/') ? p : `${p}/`) || (p.endsWith('/') && norm === p.slice(0, -1))) throw new Error(`'${norm}' is protected and cannot be modified by self-development`);
    // resolve symlinks on the existing part so a link cannot point outside
    let probe = abs;
    while (!fs.existsSync(probe) && probe !== this.repoRoot) probe = path.dirname(probe);
    if (fs.existsSync(probe) && !fs.realpathSync(probe).startsWith(fs.realpathSync(this.repoRoot))) throw new Error(`Path resolves outside the repository: ${rel}`);
    return norm;
  }

  propose({ title, rationale = '', files } = {}) {
    if (!title) throw new Error('title is required');
    const entries = Object.entries(files ?? {});
    if (!entries.length) throw new Error('files is required (map of relative path -> new content)');
    if (entries.length > MAX_FILES) throw new Error(`Too many files (max ${MAX_FILES})`);
    const clean = {}; let bytes = 0;
    for (const [rel, content] of entries) {
      if (typeof content !== 'string') throw new Error(`Content for ${rel} must be a string`);
      bytes += Buffer.byteLength(content);
      clean[this._checkPath(rel)] = content;
    }
    if (bytes > MAX_BYTES) throw new Error('Proposal too large');
    const p = { id: crypto.randomUUID(), title, rationale, files: clean, status: 'proposed', createdAt: new Date().toISOString(), sandbox: null, applied: null };
    this._write(p);
    this._log('selfdev_proposed', { id: p.id, title, files: Object.keys(clean) });
    return p;
  }

  get(id) { return this._read(id); }
  list() {
    return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ files, ...rest }) => ({ ...rest, files: Object.keys(files) }));
  }

  _copyRepo(dest) {
    fs.cpSync(this.repoRoot, dest, { recursive: true, filter: (src) => !COPY_EXCLUDE.has(path.basename(src)) });
    const nm = path.join(this.repoRoot, 'node_modules');
    if (fs.existsSync(nm)) fs.symlinkSync(fs.realpathSync(nm), path.join(dest, 'node_modules'), 'dir');
  }

  async sandboxTest(id) {
    if (this.emergencyStop?.isActive?.()) throw new Error('Emergency stop is active');
    const p = this._read(id);
    const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'xoft-sandbox-'));
    const steps = [];
    try {
      this._copyRepo(tmp);
      for (const [rel, content] of Object.entries(p.files)) {
        const abs = path.join(tmp, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content);
      }
      let ok = true;
      for (const rel of Object.keys(p.files).filter((f) => /\.(m?js|cjs)$/.test(f))) {
        const r = await run('node', ['--check', rel], { cwd: tmp, timeoutMs: 20_000 });
        steps.push({ name: `syntax:${rel}`, ok: r.code === 0, output: r.code === 0 ? '' : r.output.slice(-800) });
        ok = ok && r.code === 0;
      }
      if (ok) {
        const [cmd, ...args] = this.testCommand;
        const r = await run(cmd, args, { cwd: tmp, timeoutMs: this.testTimeoutMs });
        steps.push({ name: 'tests', ok: r.code === 0, output: r.output.slice(-1500) });
        ok = r.code === 0;
      }
      const sandbox = { ok, ranAt: new Date().toISOString(), steps };
      this._write({ ...p, status: ok ? 'verified' : 'failed', sandbox });
      this._log('selfdev_sandbox', { id, ok, steps: steps.map((s) => ({ name: s.name, ok: s.ok })) });
      return sandbox;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async apply(id, { approvedBy } = {}) {
    if (this.emergencyStop?.isActive?.()) throw new Error('Emergency stop is active');
    if (!approvedBy || typeof approvedBy !== 'string') throw new Error('apply requires approvedBy (a named human approver)');
    const p = this._read(id);
    if (p.status === 'applied') throw new Error('Proposal already applied (idempotent: refusing to apply twice)');
    if (p.status !== 'verified' || !p.sandbox?.ok) throw new Error('Proposal has not passed sandbox testing');
    for (const rel of Object.keys(p.files)) this._checkPath(rel); // re-validate at apply time

    const backupDir = path.join(this.dir, 'backups', id);
    fs.mkdirSync(backupDir, { recursive: true });
    const manifest = [];
    for (const rel of Object.keys(p.files)) {
      const abs = path.join(this.repoRoot, rel);
      const existed = fs.existsSync(abs);
      if (existed) { const b = path.join(backupDir, rel); fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(abs, b); }
      manifest.push({ rel, existed });
    }
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest));
    for (const [rel, content] of Object.entries(p.files)) {
      const abs = path.join(this.repoRoot, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content);
    }
    // post-apply verification on the LIVE files; any failure restores the backup
    for (const rel of Object.keys(p.files).filter((f) => /\.(m?js|cjs)$/.test(f))) {
      const r = await run('node', ['--check', rel], { cwd: this.repoRoot, timeoutMs: 20_000 });
      if (r.code !== 0) {
        this._restore(id);
        this._write({ ...p, status: 'rolled_back', applied: { approvedBy, at: new Date().toISOString(), rolledBackBecause: `post-apply check failed: ${rel}` } });
        this._log('selfdev_rolled_back', { id, reason: 'post-apply syntax check failed', file: rel });
        throw new Error(`Post-apply check failed for ${rel}; changes were rolled back.`);
      }
    }
    this._write({ ...p, status: 'applied', applied: { approvedBy, at: new Date().toISOString() } });
    this._log('selfdev_applied', { id, approvedBy, files: Object.keys(p.files) });
    return this._read(id);
  }

  _restore(id) {
    const backupDir = path.join(this.dir, 'backups', id);
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
    for (const { rel, existed } of manifest) {
      const abs = path.join(this.repoRoot, rel);
      if (existed) fs.copyFileSync(path.join(backupDir, rel), abs); else fs.rmSync(abs, { force: true });
    }
  }

  rollback(id) {
    const p = this._read(id);
    if (p.status !== 'applied') throw new Error('Only an applied proposal can be rolled back');
    this._restore(id);
    this._write({ ...p, status: 'rolled_back', applied: { ...p.applied, rolledBackAt: new Date().toISOString() } });
    this._log('selfdev_rolled_back', { id, reason: 'manual rollback' });
    return this._read(id);
  }
}

