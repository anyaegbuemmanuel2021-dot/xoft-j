'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeEnv } = require('./helpers/fsEnv');

const read = (p) => fs.readFileSync(p, 'utf8');

test('workspace boundary: paths outside, traversal and symlink escapes are refused', async (t) => {
  const e = makeEnv({ files: { 'a.txt': 'hi' } }); t.after(e.cleanup);
  fs.writeFileSync(path.join(e.outside, 'secret.txt'), 'top secret');
  fs.symlinkSync(e.outside, path.join(e.root, 'escape'));
  assert.equal((await e.fsx.read({ path: path.join(e.outside, 'secret.txt') })).success, false);
  assert.equal((await e.fsx.read({ path: '../outside/secret.txt' })).success, false);
  const viaLink = await e.fsx.read({ path: 'escape/secret.txt' });
  assert.equal(viaLink.success, false);
  assert.match(viaLink.error, /outside every registered workspace/);
  assert.equal((await e.fsx.write({ path: 'escape/new.txt', content: 'x' })).success, false);
  assert.equal(fs.existsSync(path.join(e.outside, 'new.txt')), false);
  assert.equal((await e.fsx.read({ path: 'a.txt' })).success, true);
});

test('sensitive files: content never readable/writable/searchable, but listed and flagged', async (t) => {
  const e = makeEnv({ files: { '.env': 'API_KEY=supersecretvalue123', '.env.example': 'API_KEY=', 'agent-config.json': '{"apiKey":"zzz"}', 'keys/id_rsa': 'PRIVATE', 'notes.md': 'API_KEY mention' } }); t.after(e.cleanup);
  for (const f of ['.env', 'agent-config.json', 'keys/id_rsa']) {
    const r = await e.fsx.read({ path: f }); assert.equal(r.success, false, f); assert.equal(r.sensitive, true, f);
    assert.equal((await e.fsx.write({ path: f, content: 'x', overwrite: true })).success, false, f);
    assert.equal((await e.fsx.delete({ path: f })).success, false, f);
  }
  assert.equal(read(path.join(e.root, '.env')), 'API_KEY=supersecretvalue123'); // untouched
  assert.equal((await e.fsx.read({ path: '.env.example' })).success, true);
  const list = await e.fsx.list({ path: '.' });
  assert.equal(list.data.items.find((i) => i.name === '.env').sensitive, true);
  const s = await e.fsx.search({ query: 'supersecretvalue', kind: 'content' });
  assert.equal(s.data.matches.length, 0);
  const c = await e.fsx.copy({ from: '.env', to: 'copy.env' }); assert.equal(c.success, false);
});

test('read redacts embedded secrets and reports how many', async (t) => {
  const e = makeEnv({ files: { 'cfg.js': 'const password = "hunter2hunter2";\nconst k = "sk-abcdefghijklmnopqrstuvwxyz123456";\nconst ok = 1;' } }); t.after(e.cleanup);
  const r = await e.fsx.read({ path: 'cfg.js' });
  assert.equal(r.success, true);
  assert.ok(r.data.redactions >= 2);
  assert.ok(!r.data.content.includes('hunter2hunter2'));
  assert.ok(!r.data.content.includes('sk-abcdefghijklmnop'));
  assert.ok(r.data.content.includes('const ok = 1;'));
});

test('create/write: verified, journaled, refuses silent overwrite, checkpoints on overwrite', async (t) => {
  const e = makeEnv(); t.after(e.cleanup);
  const c = await e.fsx.create({ path: 'sub/dir/new.txt', content: 'v1' }, { missionId: 'M1', reason: 'test' });
  assert.equal(c.success, true); assert.equal(c.verification.verified, true);
  assert.equal(read(path.join(e.root, 'sub/dir/new.txt')), 'v1');
  const op = e.journal.get(c.data.operationId);
  assert.equal(op.missionId, 'M1'); assert.equal(op.action, 'CREATE'); assert.equal(op.status, 'completed'); assert.equal(op.rollback.available, true);
  assert.equal((await e.fsx.write({ path: 'sub/dir/new.txt', content: 'v2' })).success, false);
  assert.equal(read(path.join(e.root, 'sub/dir/new.txt')), 'v1');
  const w = await e.fsx.write({ path: 'sub/dir/new.txt', content: 'v2', overwrite: true });
  assert.equal(w.success, true);
  assert.equal(read(w.data.path), 'v2');
  assert.equal(fs.readFileSync(e.journal.get(w.data.operationId).previousState.checkpoint, 'utf8'), 'v1');
});

test('edit: unique match applies; ambiguous or no-op edits are refused and leave the file untouched', async (t) => {
  const e = makeEnv({ files: { 'f.js': 'let a = 1;\nlet b = 1;\nfoo();\n' } }); t.after(e.cleanup);
  const f = path.join(e.root, 'f.js');
  const amb = await e.fsx.edit({ path: 'f.js', find: '= 1', replace: '= 2' });
  assert.equal(amb.success, false); assert.match(amb.error, /matched 2 time/);
  assert.equal(read(f), 'let a = 1;\nlet b = 1;\nfoo();\n');
  assert.equal((await e.fsx.edit({ path: 'f.js', find: 'nonexistent', replace: 'x' })).success, false);
  assert.equal((await e.fsx.edit({ path: 'f.js', find: 'foo();', replace: 'foo();' })).success, false);
  const ok = await e.fsx.edit({ path: 'f.js', find: 'foo();', replace: 'bar();' }, { reason: 'rename call' });
  assert.equal(ok.success, true);
  assert.equal(read(f), 'let a = 1;\nlet b = 1;\nbar();\n');
  const multi = await e.fsx.edit({ path: 'f.js', find: '= 1', replace: '= 9', expectedCount: 2 });
  assert.equal(multi.success, true);
  const lr = await e.fsx.edit({ path: 'f.js', startLine: 3, endLine: 3, replacement: 'baz();' });
  assert.equal(lr.success, true); assert.ok(read(f).includes('baz();'));
  assert.equal((await e.fsx.edit({ path: 'f.js', startLine: 99, replacement: 'x' })).success, false);
});

test('delete moves to recovery trash (never permanent) and restore brings it back', async (t) => {
  const e = makeEnv({ files: { 'keep.txt': 'important' } }); t.after(e.cleanup);
  const p = path.join(e.root, 'keep.txt');
  const d = await e.fsx.delete({ path: 'keep.txt' }, { reason: 'cleanup' });
  assert.equal(d.success, true);
  assert.equal(fs.existsSync(p), false);
  assert.equal(read(path.join(d.data.movedToTrash)), 'important');
  const r = await e.fsx.restore({ operationId: d.data.operationId });
  assert.equal(r.success, true); assert.equal(read(p), 'important');
  const again = await e.fsx.restore({ operationId: d.data.operationId });
  assert.equal(again.success, false); assert.match(again.error, /already rolled back/);
});

test('restore refuses to clobber a file that now exists at the original path', async (t) => {
  const e = makeEnv({ files: { 'x.txt': 'old' } }); t.after(e.cleanup);
  const d = await e.fsx.delete({ path: 'x.txt' });
  fs.writeFileSync(path.join(e.root, 'x.txt'), 'new content made after delete');
  const r = await e.fsx.restore({ operationId: d.data.operationId });
  assert.equal(r.success, false); assert.match(r.error, /already exists/);
  assert.equal(read(path.join(e.root, 'x.txt')), 'new content made after delete');
});

test('deleting a directory works via trash; workspace root cannot be deleted', async (t) => {
  const e = makeEnv({ files: { 'dir/a.txt': 'a', 'dir/b/c.txt': 'c' } }); t.after(e.cleanup);
  const d = await e.fsx.delete({ path: 'dir' });
  assert.equal(d.success, true); assert.equal(fs.existsSync(path.join(e.root, 'dir')), false);
  assert.equal((await e.fsx.restore({ operationId: d.data.operationId })).success, true);
  assert.equal(read(path.join(e.root, 'dir/b/c.txt')), 'c');
  const root = await e.fsx.delete({ path: e.root });
  assert.equal(root.success, false); assert.match(root.error, /workspace root/);
  assert.equal(fs.existsSync(e.root), true);
});

test('"undo what you just did": undoLast reverts the latest edit; refuses if file changed since (unless force)', async (t) => {
  const e = makeEnv({ files: { 'u.txt': 'original' } }); t.after(e.cleanup);
  const p = path.join(e.root, 'u.txt');
  await e.fsx.edit({ path: 'u.txt', find: 'original', replace: 'edited' });
  assert.equal(read(p), 'edited');
  const u = await e.fsx.undoLast();
  assert.equal(u.success, true); assert.equal(read(p), 'original');
  await e.fsx.edit({ path: 'u.txt', find: 'original', replace: 'edited-again' });
  const opId = e.journal.latestRollbackable().id;
  fs.writeFileSync(p, 'human edited this in the meantime');
  const blocked = await e.fsx.restore({ operationId: opId });
  assert.equal(blocked.success, false); assert.match(blocked.error, /changed since/);
  assert.equal(read(p), 'human edited this in the meantime');
  assert.equal((await e.fsx.restore({ operationId: opId, force: true })).success, true);
  assert.equal(read(p), 'original');
});

test('undo of a restore is itself possible (restore saves the version it replaced)', async (t) => {
  const e = makeEnv({ files: { 'u.txt': 'A' } }); t.after(e.cleanup);
  const p = path.join(e.root, 'u.txt');
  const ed = await e.fsx.edit({ path: 'u.txt', find: 'A', replace: 'B' });
  const r = await e.fsx.restore({ operationId: ed.data.operationId });
  assert.equal(read(p), 'A');
  const redo = await e.fsx.restore({ operationId: r.data.operationId });
  assert.equal(redo.success, true); assert.equal(read(p), 'B');
});

test('move / rename / copy are verified and undoable; overwrite displaces to recovery and undo restores it', async (t) => {
  const e = makeEnv({ files: { 'a.txt': 'A', 'b.txt': 'B' } }); t.after(e.cleanup);
  const P = (n) => path.join(e.root, n);
  const rn = await e.fsx.rename({ path: 'a.txt', newName: 'a2.txt' });
  assert.equal(rn.success, true); assert.equal(fs.existsSync(P('a.txt')), false); assert.equal(read(P('a2.txt')), 'A');
  assert.equal((await e.fsx.rename({ path: 'a2.txt', newName: '../evil.txt' })).success, false);
  assert.equal((await e.fsx.move({ from: 'a2.txt', to: 'b.txt' })).success, false);
  const mv = await e.fsx.move({ from: 'a2.txt', to: 'b.txt', overwrite: true });
  assert.equal(mv.success, true); assert.equal(read(P('b.txt')), 'A');
  assert.equal((await e.fsx.restore({ operationId: mv.data.operationId })).success, true);
  assert.equal(read(P('a2.txt')), 'A'); assert.equal(read(P('b.txt')), 'B');
  const cp = await e.fsx.copy({ from: 'b.txt', to: 'sub/b-copy.txt' });
  assert.equal(cp.success, true); assert.equal(read(P('sub/b-copy.txt')), 'B');
  assert.equal((await e.fsx.restore({ operationId: cp.data.operationId })).success, true);
  assert.equal(fs.existsSync(P('sub/b-copy.txt')), false);
});

test('search by name, glob and content; skips node_modules; locate ranks "browser executor"', async (t) => {
  const e = makeEnv({ files: { 'src/executors/browser.js': 'const TODO_MARK = 1;', 'src/other.js': 'nothing', 'node_modules/pkg/browser.js': 'TODO_MARK', 'README.md': 'docs' } }); t.after(e.cleanup);
  const byName = await e.fsx.search({ query: 'browser' });
  assert.deepEqual(byName.data.matches.map((m) => path.relative(e.root, m.path)), ['src/executors/browser.js']);
  const glob = await e.fsx.search({ query: '*.md' });
  assert.equal(glob.data.matches.length, 1);
  const content = await e.fsx.search({ query: 'todo_mark', kind: 'content' });
  assert.equal(content.data.matches.length, 1); assert.equal(content.data.matches[0].hits[0].line, 1);
  const loc = await e.fsx.locate({ query: 'browser executor' });
  assert.equal(path.relative(e.root, loc.data.files[0].path), 'src/executors/browser.js');
});

test('locate finds a project by fuzzy name across the workspace', async (t) => {
  const e = makeEnv({ files: { 'Social-Pulse/package.json': '{"name":"socialpulse","scripts":{"test":"node --test"}}', 'other/readme.md': 'x' } }); t.after(e.cleanup);
  const r = await e.fsx.locate({ query: 'SocialPulse' });
  assert.equal(r.data.projects[0].type, 'node');
  assert.match(r.data.projects[0].path, /Social-Pulse$/);
  const proj = e.workspaces.inspectProject('proj'); assert.equal(proj.type, null);
});

test('inspect reports metadata, project association and JS relationships', async (t) => {
  const e = makeEnv({ files: { 'package.json': '{"name":"demo","main":"src/a.js","scripts":{"test":"node --test","build":"echo b"}}', 'pnpm-lock.yaml': '', 'src/a.js': "const b = require('./b');\nconst ws = require('ws');\nmodule.exports = {};\nexports.run = () => 1;", 'src/b.js': 'module.exports = 1;' } }); t.after(e.cleanup);
  const r = await e.fsx.inspect({ path: 'src/a.js' });
  assert.equal(r.success, true);
  assert.equal(r.data.project.type, 'node'); assert.equal(r.data.project.packageManager, 'pnpm');
  assert.equal(r.data.lines, 4);
  assert.equal(path.basename(r.data.structure.relatedFiles[0].resolved), 'b.js');
  assert.deepEqual(r.data.structure.packageDependencies, ['ws']);
  assert.ok(r.data.structure.exports.includes('run'));
  const proj = e.workspaces.inspectProject('proj');
  assert.equal(proj.commands.test, 'pnpm test'); assert.equal(proj.commands.build, 'pnpm run build');
});

test('compare: identical files, and a real line diff', async (t) => {
  const e = makeEnv({ files: { 'a.txt': 'one\ntwo\nthree', 'b.txt': 'one\nTWO\nthree', 'c.txt': 'one\ntwo\nthree' } }); t.after(e.cleanup);
  assert.equal((await e.fsx.compare({ a: 'a.txt', b: 'c.txt' })).data.identical, true);
  const d = await e.fsx.compare({ a: 'a.txt', b: 'b.txt' });
  assert.equal(d.data.identical, false); assert.equal(d.data.removed, 1); assert.equal(d.data.added, 1);
  assert.deepEqual(d.data.diff.map((x) => `${x.type}${x.text}`), ['-two', '+TWO']);
});

test('archive excludes secrets; extract round-trips; unsafe archives are refused', async (t) => {
  const e = makeEnv({ files: { 'proj/a.txt': 'A', 'proj/sub/b.txt': 'B', 'proj/.env': 'SECRET=1', 'proj/server.pem': 'KEY' } }); t.after(e.cleanup);
  const ar = await e.fsx.archive({ paths: ['proj'], dest: 'out/proj.tar.gz' });
  assert.equal(ar.success, true, ar.error);
  const listing = execFileSync('tar', ['-tzf', path.join(e.root, 'out/proj.tar.gz')]).toString();
  assert.ok(listing.includes('proj/a.txt')); assert.ok(!listing.includes('.env')); assert.ok(!listing.includes('server.pem'));
  const ex = await e.fsx.extract({ archive: 'out/proj.tar.gz', destDir: 'restored' });
  assert.equal(ex.success, true, ex.error);
  assert.equal(read(path.join(e.root, 'restored/proj/sub/b.txt')), 'B');
  assert.equal((await e.fsx.extract({ archive: 'out/proj.tar.gz', destDir: 'restored' })).success, false); // non-empty dest
  // absolute-path entry (zip-slip style)
  const evilSrc = path.join(e.outside, 'evil.txt'); fs.writeFileSync(evilSrc, 'x');
  execFileSync('tar', ['-czPf', path.join(e.root, 'evil.tgz'), evilSrc]);
  const bad = await e.fsx.extract({ archive: 'evil.tgz', destDir: 'evil-out' });
  assert.equal(bad.success, false); assert.match(bad.error, /Unsafe archive entry/);
  assert.equal(fs.existsSync(path.join(e.root, 'evil-out')), false);
  assert.equal((await e.fsx.archive({ paths: ['proj'], dest: 'x.zip' })).success, false);
});

test('restoreVersion restores the version from before an edit made after a given time', async (t) => {
  const e = makeEnv({ files: { 'v.txt': 'v0' } }); t.after(e.cleanup);
  const p = path.join(e.root, 'v.txt');
  const before = new Date(Date.now() - 1000).toISOString();
  await e.fsx.edit({ path: 'v.txt', find: 'v0', replace: 'v1' });
  await e.fsx.edit({ path: 'v.txt', find: 'v1', replace: 'v2' });
  assert.equal(read(p), 'v2');
  const r = await e.fsx.restoreVersion({ path: 'v.txt', asOf: before });
  assert.equal(r.success, true, r.error); assert.equal(read(p), 'v0');
  assert.equal((await e.fsx.undoLast()).success, true); assert.equal(read(p), 'v2'); // the restore itself was checkpointed
  assert.equal((await e.fsx.restoreVersion({ path: 'v.txt', asOf: 'garbage' })).success, false);
  const hist = await e.fsx.fileHistory({ path: 'v.txt' });
  assert.ok(hist.data.operations.length >= 4);
});

test('watch reports real filesystem events and can be stopped', async (t) => {
  const e = makeEnv(); t.after(e.cleanup);
  const w = await e.fsx.startWatch({ path: '.' });
  assert.equal(w.success, true);
  fs.writeFileSync(path.join(e.root, 'watched.txt'), 'x');
  let events = [];
  for (let i = 0; i < 30 && !events.length; i++) { await new Promise((r) => setTimeout(r, 100)); events = (await e.fsx.pollWatch({ watchId: w.data.watchId })).data.events; }
  assert.ok(events.some((ev) => ev.path.endsWith('watched.txt')));
  assert.equal((await e.fsx.stopWatch({ watchId: w.data.watchId })).success, true);
  assert.equal((await e.fsx.pollWatch({ watchId: w.data.watchId })).success, false);
});
