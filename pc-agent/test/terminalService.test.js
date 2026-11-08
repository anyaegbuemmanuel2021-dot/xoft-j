'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeEnv } = require('./helpers/fsEnv');
const { TerminalService, classify } = require('../src/services/TerminalService');

const PKG = JSON.stringify({ name: 't', scripts: {
  hello: 'node -e "console.log(\'hello-from-script\')"',
  leak: 'node leak.js', fail: 'node -e "process.exit(3)"', secret: 'node -e "console.log(\'sk-abcdefghijklmnopqrstuvwxyz123456\')"', hang: 'node hang.js',
} });
const files = { 'proj/package.json': PKG, 'proj/leak.js': 'console.log("KEY=" + String(process.env.XOFT_API_KEY));', 'proj/hang.js': 'require("fs").writeFileSync("pid.txt", String(process.pid)); setInterval(() => {}, 1000);' };
const mk = (policy = {}) => { const e = makeEnv({ files, policy }); return { e, term: new TerminalService({ workspaces: e.workspaces, journal: e.journal, guard: e.guard }) }; };
// A killed-but-unreaped (zombie) process still answers kill(pid,0); it is DEAD for our purposes. Read real state from /proc on Linux.
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3) !== 'Z'; } catch { return true; }
};
const dead = async (pid, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

test('classification is an allowlist: only recognised read-only/build commands pass', () => {
  const cwd = path.join(process.cwd(), 'nonexistent');
  const cls = (c, a) => classify(c, a, { cwd }).cls;
  for (const [c, a] of [['git', ['status']], ['git', ['status', '--short']], ['git', ['log', '--oneline', '-5']], ['git', ['diff', '--stat', 'src/a.js']], ['node', ['--version']], ['npm', ['--version']]]) assert.equal(cls(c, a), 'safe', `${c} ${a}`);
  for (const [c, a] of [['rm', ['-rf', 'x']], ['del', ['x']], ['git', ['push']], ['git', ['reset', '--hard']], ['git', ['clean', '-fd']], ['git', ['log', '--output=x.txt']], ['git', ['-c', 'core.pager=evil', 'status']], ['git', ['diff', '../secret']], ['git', ['diff', '/etc/passwd']],
    ['npm', ['install']], ['npm', ['publish']], ['bash', ['-c', 'ls']], ['curl', ['http://x']], ['node', ['-e', 'x']], ['git', ['status;rm']], ['git', ['status', '&&', 'x']], ['git', ['log', '$(id)']], ['powershell', ['x']], ['python', ['-c', 'x']]]) assert.equal(cls(c, a), 'other', `${c} ${a}`);
  assert.equal(classify('npm', ['run', 'nope'], { cwd: 'x' }).cls, 'other');
});

test('safe commands run with real exit status, output and a journal entry', async (t) => {
  const { e, term } = mk(); t.after(e.cleanup);
  const r = await term.run({ command: 'node', args: ['--version'], cwd: 'proj' }, { missionId: 'M2' });
  assert.equal(r.success, true); assert.match(r.data.stdout, /^v\d+\./); assert.equal(r.data.exitCode, 0);
  const op = e.journal.get(r.data.operationId); assert.equal(op.action, 'TERMINAL'); assert.equal(op.missionId, 'M2'); assert.equal(op.status, 'completed');
});

test('build commands need approval by default; with policy allow they run project scripts only', async (t) => {
  const blocked = mk(); t.after(blocked.e.cleanup);
  const b = await blocked.term.run({ command: 'npm', args: ['run', 'hello'], cwd: 'proj' });
  assert.equal(b.success, false); assert.equal(b.blocked, true); assert.match(b.error, /requires human approval/);
  const { e, term } = mk({ 'terminal.build': 'allow' }); t.after(e.cleanup);
  const r = await term.run({ command: 'npm', args: ['run', 'hello'], cwd: 'proj' });
  assert.equal(r.success, true, r.error); assert.match(r.data.stdout, /hello-from-script/);
  const denied = await term.run({ command: 'npm', args: ['install'], cwd: 'proj' });
  assert.equal(denied.blocked, true); assert.match(denied.error, /not allowed|denied/);
});

test('non-safe commands are denied outright and never spawned', async (t) => {
  const { e, term } = mk({ 'terminal.build': 'allow' }); t.after(e.cleanup);
  for (const [command, args] of [['rm', ['-rf', '.']], ['git', ['push']], ['curl', ['http://example.com']]]) {
    const r = await term.run({ command, args, cwd: 'proj' }); assert.equal(r.blocked, true, command); assert.equal(r.classification, 'other');
  }
  assert.ok(fs.existsSync(path.join(e.root, 'proj/package.json')));
});

test('child processes do NOT inherit agent secrets; printed secrets are redacted; nonzero exits are failures', async (t) => {
  process.env.XOFT_API_KEY = 'agent-secret-key-1234567890'; t.after(() => { delete process.env.XOFT_API_KEY; });
  const { e, term } = mk({ 'terminal.build': 'allow' }); t.after(e.cleanup);
  const leak = await term.run({ command: 'npm', args: ['run', 'leak'], cwd: 'proj' });
  assert.match(leak.data.stdout, /KEY=undefined/); assert.ok(!leak.data.stdout.includes('agent-secret-key'));
  const sec = await term.run({ command: 'npm', args: ['run', 'secret'], cwd: 'proj' });
  assert.ok(!sec.data.stdout.includes('sk-abcdefghijklmnop')); assert.ok(sec.data.redactions >= 1);
  const bad = await term.run({ command: 'npm', args: ['run', 'fail'], cwd: 'proj' });
  assert.equal(bad.success, false); assert.equal(bad.data.exitCode, 3); assert.match(bad.error, /exited with code 3/);
  assert.equal(e.journal.get(bad.data.operationId).status, 'failed');
});

test('timeout kills the whole process tree', async (t) => {
  const { e, term } = mk({ 'terminal.build': 'allow' }); t.after(e.cleanup);
  const t0 = Date.now();
  const r = await term.run({ command: 'npm', args: ['run', 'hang'], cwd: 'proj', timeoutMs: 1000 });
  assert.equal(r.success, false); assert.equal(r.data.timedOut, true); assert.ok(Date.now() - t0 < 8000);
  const pid = Number(fs.readFileSync(path.join(e.root, 'proj/pid.txt'), 'utf8'));
  assert.equal(await dead(pid), true, 'grandchild node process must be dead');
});

test('KILL SWITCH: halting kills a running terminal process tree and refuses new commands', async (t) => {
  const { e, term } = mk({ 'terminal.build': 'allow' }); t.after(e.cleanup);
  const running = term.run({ command: 'npm', args: ['run', 'hang'], cwd: 'proj', timeoutMs: 60000 });
  await new Promise((res) => setTimeout(res, 800));
  const pid = Number(fs.readFileSync(path.join(e.root, 'proj/pid.txt'), 'utf8')); assert.equal(alive(pid), true);
  e.halt.halt('operator pressed the kill switch');
  const r = await running;
  assert.equal(r.success, false); assert.equal(r.data.halted, true); assert.match(r.error, /Halted/);
  assert.equal(await dead(pid), true, 'grandchild node process must be dead');
  const after = await term.run({ command: 'node', args: ['--version'], cwd: 'proj' });
  assert.equal(after.blocked, true); assert.match(after.error, /HALTED/);
});

test('cwd outside every workspace is refused', async (t) => {
  const { e, term } = mk(); t.after(e.cleanup);
  const r = await term.run({ command: 'node', args: ['--version'], cwd: e.outside });
  assert.equal(r.success, false); assert.match(r.error, /outside every registered workspace/);
});
