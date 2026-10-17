'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { redactSecrets } = require('../runtime/sensitive');

const MAX_OUTPUT = 200 * 1024;
const WIN = process.platform === 'win32';
const SAFE_TOKEN = /^[\w./@~^:=+,-]+$/; // no spaces, quotes, or shell metacharacters — also what makes the Windows .cmd path injection-safe
const GIT_FLAGS = {
  status: new Set(['-s', '--short', '-b', '--branch', '--porcelain']),
  diff: new Set(['--stat', '--name-only', '--name-status', '--cached', '--staged', '--no-color', '--shortstat']),
  log: new Set(['--oneline', '--stat', '--no-color', '--graph', '--decorate', '--name-only']),
  branch: new Set(['-a', '--all', '-v', '--list', '--show-current']),
  show: new Set(['--stat', '--name-only', '--no-color', '--oneline']),
  'rev-parse': new Set(['--short', '--abbrev-ref', '--show-toplevel', 'HEAD']),
  'ls-files': new Set(['--cached', '--others', '--exclude-standard']),
};
const VERSION_TOOLS = new Set(['node', 'npm', 'git', 'python', 'python3', 'pnpm', 'yarn']);
const PM = new Set(['npm', 'pnpm', 'yarn']);

/**
 * Classifies argv into { cls: 'safe'|'build'|'other', reason }. This is an ALLOWLIST: anything not
 * recognised is 'other' (denied by default policy). There is no shell, so no metacharacter expansion.
 * safe  = read-only inspection (git status/diff/log…, --version)
 * build = runs project code (npm test, npm run <script defined in package.json>, node --test, pytest) → 'confirm' by default
 */
function classify(command, args, { cwd } = {}) {
  if (typeof command !== 'string' || !Array.isArray(args) || args.length > 20) return { cls: 'other', reason: 'malformed command' };
  if (![command, ...args].every((t) => typeof t === 'string' && SAFE_TOKEN.test(t))) return { cls: 'other', reason: 'arguments contain characters outside the safe set (no spaces, quotes or shell metacharacters)' };
  if (args.length === 1 && args[0] === '--version' && VERSION_TOOLS.has(command)) return { cls: 'safe' };
  if (command === 'git') {
    const [sub, ...rest] = args; const allowed = GIT_FLAGS[sub];
    if (!allowed) return { cls: 'other', reason: `git ${sub ?? ''} is not on the read-only allowlist (${Object.keys(GIT_FLAGS).join(', ')})` };
    for (const a of rest) {
      if (a.startsWith('-')) { if (allowed.has(a) || (/^-(n|U)?\d+$/.test(a) && (sub === 'log' || sub === 'diff' || sub === 'show'))) continue; return { cls: 'other', reason: `git flag '${a}' is not allowed` }; }
      if (a === '..' || a.split('/').includes('..') || path.isAbsolute(a)) return { cls: 'other', reason: 'paths must be relative and stay inside the workspace' };
    }
    return { cls: 'safe' };
  }
  if (PM.has(command)) {
    const [sub, script, ...more] = args;
    if (sub === 'test' && !script) return { cls: 'build' };
    if (sub === 'run' && script && /^[\w:-]+$/.test(script) && !more.length) {
      try { const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); if (pkg.scripts?.[script]) return { cls: 'build' }; return { cls: 'other', reason: `package.json has no script '${script}'` }; }
      catch { return { cls: 'other', reason: 'no readable package.json in the working directory' }; }
    }
    return { cls: 'other', reason: `${command} ${sub ?? ''} is not allowed (only 'test' and 'run <script defined in package.json>')` };
  }
  if (command === 'node' && args[0] === '--test' && args.slice(1).every((a) => !a.startsWith('-'))) return { cls: 'build' };
  if ((command === 'python' || command === 'python3') && args[0] === '-m' && args[1] === 'pytest' && args.slice(2).every((a) => !a.startsWith('-') || a === '-q' || a === '-x')) return { cls: 'build' };
  return { cls: 'other', reason: `'${command}' is not on the terminal allowlist` };
}

function minimalEnv() {
  const keep = WIN ? ['PATH', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'PATHEXT'] : ['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER'];
  const env = { CI: '1', NO_COLOR: '1' };
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k]; // secrets (XOFT_API_KEY, tokens, cloud creds) are NOT inherited
  return env;
}

function killTree(child) {
  try {
    if (WIN) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

class TerminalService {
  constructor({ workspaces, journal, guard, agent = 'xoft' }) { Object.assign(this, { ws: workspaces, journal, guard, agent }); }

  async run({ command, args = [], cwd = '.', timeoutMs = 120000, reason }, ctx = {}) {
    let dir; try { dir = this.ws.resolve(cwd).abs; if (!fs.statSync(dir).isDirectory()) throw new Error('cwd is not a directory'); } catch (err) { return { success: false, error: err.message }; }
    const c = classify(command, args, { cwd: dir });
    const cmdline = [command, ...args].join(' ');
    try { this.guard.assertAllowed(`terminal.${c.cls}`, { command: cmdline, cwd: dir }); }
    catch (err) { return { success: false, blocked: true, error: c.reason ? `${err.message} — ${c.reason}` : err.message, classification: c.cls }; }
    let track; try { track = this.guard.halt.track(); } catch (err) { return { success: false, blocked: true, error: err.message }; }
    const timeout = Math.min(Math.max(1000, Number(timeoutMs) || 120000), 600000);
    const opId = this.journal.begin({ action: 'TERMINAL', target: `${cmdline} (cwd ${dir})`, reason: reason ?? ctx.reason ?? null, missionId: ctx.missionId ?? null, agent: ctx.agent ?? this.agent });
    const started = Date.now();
    try {
      const out = await new Promise((resolve) => {
        const [exe, exeArgs] = WIN && (PM.has(command) || command === 'npx') ? ['cmd.exe', ['/d', '/s', '/c', `${command}.cmd`, ...args]] : [command, args];
        const child = spawn(exe, exeArgs, { cwd: dir, env: minimalEnv(), shell: false, detached: !WIN, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let stdout = ''; let stderr = ''; let truncated = false; let timedOut = false; let aborted = false; let spawnError = null;
        const take = (cur, chunk) => { if (cur.length >= MAX_OUTPUT) { truncated = true; return cur; } const next = cur + chunk.toString('utf8'); if (next.length > MAX_OUTPUT) { truncated = true; return next.slice(0, MAX_OUTPUT); } return next; };
        child.stdout.on('data', (d) => { stdout = take(stdout, d); });
        child.stderr.on('data', (d) => { stderr = take(stderr, d); });
        const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
        const onAbort = () => { aborted = true; killTree(child); };
        track.signal.addEventListener('abort', onAbort, { once: true });
        child.on('error', (err) => { spawnError = err; });
        child.on('close', (code, signal) => { clearTimeout(timer); track.signal.removeEventListener('abort', onAbort); resolve({ code, signal, stdout, stderr, truncated, timedOut, aborted, spawnError }); });
      });
      const so = redactSecrets(out.stdout); const se = redactSecrets(out.stderr);
      const ok = out.code === 0 && !out.timedOut && !out.aborted && !out.spawnError;
      const data = { exitCode: out.code, signal: out.signal, stdout: so.text, stderr: se.text, durationMs: Date.now() - started, timedOut: out.timedOut, halted: out.aborted, outputTruncated: out.truncated, redactions: so.redactions + se.redactions, classification: c.cls, operationId: opId };
      const error = out.spawnError ? `Could not start '${command}': ${out.spawnError.message}` : out.aborted ? 'Halted — process tree killed' : out.timedOut ? `Timed out after ${timeout}ms — process tree killed` : !ok ? `exited with code ${out.code}` : undefined;
      this.journal.complete(opId, { result: { success: ok, exitCode: out.code, error }, newState: { exitCode: out.code, durationMs: data.durationMs }, rollback: { available: false } });
      return { success: ok, data, error, verification: { verified: true, evidence: { exitCode: out.code, source: 'child process exit status' } } };
    } finally { track.done(); }
  }
}

module.exports = { TerminalService, classify, minimalEnv };
