'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { sha256File, movePath } = require('../runtime/RecoveryStore');
const { isSensitivePath, redactSecrets } = require('../runtime/sensitive');
const { detectProject, within } = require('../runtime/WorkspaceRegistry');

const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git', '.xoft', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target', '.gradle', '.idea']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.py', '.go', '.rs', '.java', '.css', '.html', '.md', '.txt', '.yml', '.yaml', '.toml', '.sh', '.ps1', '.sql', '.xml', '.csv']);
const TAR_EXCLUDES = ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', '.ssh', '.aws', '.npmrc', '.netrc', '*.pfx', '*.p12', '*.kdbx', 'credentials.json'];
const fail = (error, extra = {}) => ({ success: false, error, ...extra });
const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

const PUBLIC_METHODS = ['list', 'search', 'locate', 'inspect', 'read', 'compare', 'startWatch', 'pollWatch', 'stopWatch', 'write', 'create', 'edit', 'delete', 'move', 'rename', 'copy', 'archive', 'extract', 'fileHistory', 'restore', 'undoLast', 'restoreVersion'];

class FileSystemService {
  constructor({ workspaces, journal, recovery, guard, extraSensitive = [], agent = 'xoft' }) {
    Object.assign(this, { ws: workspaces, journal, recovery, guard, extraSensitive, agent });
    this._watchers = new Map(); this._watchSeq = 1;
    guard.halt.onHalt(() => this._closeAllWatchers());
    // One consistent contract: guard/halt/policy denials and unexpected errors come back as {success:false}, never as throws.
    for (const name of PUBLIC_METHODS) {
      const orig = this[name].bind(this);
      this[name] = async (...args) => { try { return await orig(...args); } catch (err) { return fail(err.message, { blocked: /^HALTED|denied by local policy|requires human approval|Rate limit|not a recognised action/.test(err.message) }); } };
    }
  }

  // ---------- resolution / safety ----------
  _r(p, opts) { return this.ws.resolve(p, opts); }
  _sensitive(abs) { return isSensitivePath(abs, this.extraSensitive); }
  _deny(action, abs) { return fail(`Refusing to ${action} '${abs}': it is a protected/sensitive file (credentials, keys, tokens).`, { sensitive: true }); }

  async _mutate({ guardAction, action, target, reason, ctx = {}, previousState = null }, run) {
    this.guard.assertAllowed(guardAction, { target });
    const track = this.guard.halt.track();
    const opId = this.journal.begin({ action, target, reason: reason ?? ctx.reason ?? null, missionId: ctx.missionId ?? null, agent: ctx.agent ?? this.agent, previousState });
    try {
      const out = await run(opId, track.signal);
      this.journal.complete(opId, { result: { success: true }, newState: out.newState ?? null, rollback: out.rollback ?? { available: false } });
      return { success: true, data: { ...out.data, operationId: opId, rollbackAvailable: Boolean(out.rollback?.available) }, verification: out.verification };
    } catch (err) {
      this.journal.complete(opId, { result: { success: false, error: err.message }, rollback: { available: false } });
      return fail(err.message, { operationId: opId });
    } finally { track.done(); }
  }

  async _atomicWrite(abs, buf) {
    const tmp = `${abs}.xoft-tmp-${process.pid}-${Date.now()}`;
    try { await fs.promises.writeFile(tmp, buf); await fs.promises.rename(tmp, abs); }
    catch (err) { await fs.promises.rm(tmp, { force: true }); throw err; }
  }

  async _verifyWritten(abs, buf) {
    const size = (await fs.promises.stat(abs)).size; const sha = await sha256File(abs);
    const want = require('node:crypto').createHash('sha256').update(buf).digest('hex');
    if (size !== buf.length || sha !== want) throw new Error('Post-write verification failed (on-disk content differs from what was written)');
    return { sha256: sha, size };
  }

  // ---------- read-only ----------
  async list({ path: p, limit = 500 }) {
    this.guard.assertAllowed('file.list');
    try {
      const { abs } = this._r(p);
      const entries = await fs.promises.readdir(abs, { withFileTypes: true });
      const items = [];
      for (const e of entries.slice(0, limit)) {
        const full = path.join(abs, e.name); let st = null; try { st = await fs.promises.lstat(full); } catch { /* raced */ }
        items.push({ name: e.name, type: e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'dir' : 'file', size: st?.size ?? null, modified: st?.mtime.toISOString() ?? null, sensitive: this._sensitive(full) });
      }
      return { success: true, data: { path: abs, items, truncated: entries.length > limit }, verification: { verified: true, evidence: { source: 'fs.readdir' } } };
    } catch (err) { return fail(err.message); }
  }

  async search({ query, path: scope = null, kind = 'name', extensions = null, maxResults = 50, maxDepth = 8, timeBudgetMs = 5000, signal }) {
    this.guard.assertAllowed('file.search');
    if (typeof query !== 'string' || !query.trim() || query.length > 200) return fail('query must be a non-empty string up to 200 chars');
    try {
      const roots = scope ? [this._r(scope).abs] : this.ws.list().map((w) => w.root);
      const q = query.toLowerCase(); const glob = /[*?]/.test(query) ? globToRe(query) : null;
      const exts = extensions ? new Set(extensions.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase())) : null;
      const matches = []; const deadline = Date.now() + timeBudgetMs; let scanned = 0; let stopped = null;
      const wantName = kind === 'name' || kind === 'both'; const wantContent = kind === 'content' || kind === 'both';
      const walk = async (dir, depth) => {
        if (stopped || depth > maxDepth) return;
        let entries; try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (signal?.aborted) { stopped = 'aborted'; return; }
          if (Date.now() > deadline) { stopped = 'time_budget'; return; }
          if (matches.length >= maxResults) { stopped = 'max_results'; return; }
          if (e.isSymbolicLink()) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) { if (wantName && (glob ? glob.test(e.name) : e.name.toLowerCase().includes(q))) matches.push({ path: full, type: 'dir', match: 'name' }); await walk(full, depth + 1); } continue; }
          if (exts && !exts.has(path.extname(e.name).toLowerCase())) continue;
          const sens = this._sensitive(full);
          if (wantName && (glob ? glob.test(e.name) : e.name.toLowerCase().includes(q))) { matches.push({ path: full, type: 'file', match: 'name', sensitive: sens }); continue; }
          if (wantContent && !sens && CODE_EXT.has(path.extname(e.name).toLowerCase()) && scanned < 5000) {
            scanned++;
            try {
              const st = await fs.promises.stat(full); if (st.size > MAX_READ_BYTES) continue;
              const buf = await fs.promises.readFile(full); if (isBinary(buf)) continue;
              const lines = buf.toString('utf8').split('\n'); const hits = [];
              for (let i = 0; i < lines.length && hits.length < 3; i++) if (lines[i].toLowerCase().includes(q)) hits.push({ line: i + 1, snippet: redactSecrets(lines[i].trim().slice(0, 200)).text });
              if (hits.length) matches.push({ path: full, type: 'file', match: 'content', hits });
            } catch { /* unreadable file: skip */ }
          }
        }
      };
      for (const r of roots) await walk(r, 0);
      return { success: true, data: { matches, filesScanned: scanned, truncated: Boolean(stopped), stoppedReason: stopped }, verification: { verified: true, evidence: { source: 'directory walk (symlinks not followed)' } } };
    } catch (err) { return fail(err.message); }
  }

  /** "Open the browser executor" → ranks paths whose relative path contains every word of the query. */
  async locate({ query, limit = 10 }) {
    this.guard.assertAllowed('file.locate');
    if (typeof query !== 'string' || !query.trim()) return fail('query is required');
    const tokens = query.toLowerCase().split(/[\s/\\._-]+/).filter(Boolean);
    const projects = this.ws.locateProject(query);
    const files = []; const deadline = Date.now() + 5000;
    const walk = async (dir, root, depth) => {
      if (depth > 8 || Date.now() > deadline) return;
      let entries; try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue; const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(full, root, depth + 1); continue; }
        const rel = path.relative(root, full).toLowerCase(); const base = e.name.toLowerCase();
        if (!tokens.every((t) => rel.includes(t))) continue;
        files.push({ path: full, sensitive: this._sensitive(full), score: tokens.filter((t) => base.includes(t)).length * 10 + (tokens.length === 1 && path.parse(base).name === tokens[0] ? 20 : 0) - Math.min(rel.length / 100, 5) });
      }
    };
    try { for (const w of this.ws.list()) await walk(w.root, w.root, 0); } catch (err) { return fail(err.message); }
    files.sort((a, b) => b.score - a.score);
    return { success: true, data: { projects: projects.slice(0, limit), files: files.slice(0, limit).map(({ path: p, sensitive }) => ({ path: p, sensitive })) }, verification: { verified: true, evidence: { source: 'workspace walk' } } };
  }

  async inspect({ path: p }) {
    this.guard.assertAllowed('file.inspect');
    try {
      const { abs, workspace, relative } = this._r(p);
      const lst = await fs.promises.lstat(abs); const st = lst.isSymbolicLink() ? await fs.promises.stat(abs) : lst;
      const data = { path: abs, workspace: workspace.name, relativePath: relative, type: lst.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file', size: st.size, modified: st.mtime.toISOString(), created: st.birthtime.toISOString(), extension: path.extname(abs).toLowerCase() || null, sensitive: this._sensitive(abs) };
      let dir = st.isDirectory() ? abs : path.dirname(abs);
      while (within(dir, workspace.root)) { const proj = detectProject(dir); if (proj.type && proj.type !== 'git') { data.project = { root: dir, type: proj.type, name: proj.name ?? path.basename(dir), packageManager: proj.packageManager }; break; } if (dir === workspace.root) break; dir = path.dirname(dir); }
      if (st.isFile() && !data.sensitive && st.size <= MAX_READ_BYTES && ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(data.extension)) {
        const src = await fs.promises.readFile(abs, 'utf8');
        data.lines = src.split('\n').length;
        const specs = new Set(); for (const m of src.matchAll(/(?:require\(\s*|from\s+|import\s+|import\(\s*)['"]([^'"]+)['"]/g)) specs.add(m[1]);
        const rel = []; const pkgs = [];
        for (const s of specs) { if (s.startsWith('.')) { const base = path.resolve(path.dirname(abs), s); const cand = [base, base + '.js', base + '.mjs', base + '.cjs', base + '.ts', base + '.json', path.join(base, 'index.js')].find((c) => fs.existsSync(c) && fs.statSync(c).isFile()); rel.push({ specifier: s, resolved: cand ?? null }); } else if (!s.startsWith('node:')) pkgs.push(s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]); }
        data.structure = { relatedFiles: rel, packageDependencies: [...new Set(pkgs)], exports: [...new Set([...src.matchAll(/exports\.(\w+)\s*=|export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/g)].map((m) => m[1] ?? m[2]))], note: 'heuristic static scan (regex), not a full parser' };
      }
      return { success: true, data, verification: { verified: true, evidence: { source: 'fs.stat' } } };
    } catch (err) { return fail(err.message); }
  }

  async read({ path: p, startLine = 1, endLine = null, maxBytes = MAX_READ_BYTES }) {
    this.guard.assertAllowed('file.read');
    try {
      const { abs } = this._r(p);
      if (this._sensitive(abs)) return this._deny('read', abs);
      const st = await fs.promises.stat(abs);
      if (!st.isFile()) return fail(`'${abs}' is not a file`);
      const cap = Math.min(maxBytes, MAX_READ_BYTES);
      const fh = await fs.promises.open(abs, 'r');
      let buf; try { buf = Buffer.alloc(Math.min(st.size, cap)); await fh.read(buf, 0, buf.length, 0); } finally { await fh.close(); }
      if (isBinary(buf)) return fail('Binary file — use file.inspect for metadata.', { binary: true });
      const lines = buf.toString('utf8').split('\n'); const from = Math.max(1, startLine); const to = endLine ? Math.min(endLine, lines.length) : lines.length;
      const { text, redactions } = redactSecrets(lines.slice(from - 1, to).join('\n'));
      return { success: true, data: { path: abs, content: text, startLine: from, endLine: to, totalLinesRead: lines.length, truncated: st.size > cap, redactions, sha256: await sha256File(abs) }, verification: { verified: true, evidence: { source: 'fs.read', bytesRead: buf.length } } };
    } catch (err) { return fail(err.message); }
  }

  async compare({ a, b }) {
    this.guard.assertAllowed('file.compare');
    try {
      const ra = this._r(a).abs; const rb = this._r(b).abs;
      if (this._sensitive(ra) || this._sensitive(rb)) return this._deny('compare', this._sensitive(ra) ? ra : rb);
      const [ha, hb] = await Promise.all([sha256File(ra), sha256File(rb)]);
      if (ha === hb) return { success: true, data: { identical: true }, verification: { verified: true, evidence: { sha256: ha } } };
      const A = (await fs.promises.readFile(ra, 'utf8')).split('\n'); const B = (await fs.promises.readFile(rb, 'utf8')).split('\n');
      if (A.length > 2000 || B.length > 2000) return { success: true, data: { identical: false, linesA: A.length, linesB: B.length, note: 'files too large for line diff (>2000 lines)' }, verification: { verified: true, evidence: { sha256A: ha, sha256B: hb } } };
      const n = A.length, m = B.length; const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      const diff = []; let i = 0, j = 0;
      while (i < n && j < m) { if (A[i] === B[j]) { i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) diff.push({ type: '-', line: i + 1, text: A[i++] }); else diff.push({ type: '+', line: j + 1, text: B[j++] }); }
      while (i < n) diff.push({ type: '-', line: i + 1, text: A[i++] }); while (j < m) diff.push({ type: '+', line: j + 1, text: B[j++] });
      const red = diff.slice(0, 400).map((d) => ({ ...d, text: redactSecrets(d.text.slice(0, 300)).text }));
      return { success: true, data: { identical: false, removed: diff.filter((d) => d.type === '-').length, added: diff.filter((d) => d.type === '+').length, diff: red, truncated: diff.length > 400 }, verification: { verified: true, evidence: { sha256A: ha, sha256B: hb } } };
    } catch (err) { return fail(err.message); }
  }

  // ---------- watch ----------
  startWatch({ path: p, recursive = false }) {
    this.guard.assertAllowed('file.watch');
    try {
      if (this._watchers.size >= 10) return fail('Too many active watchers (max 10)');
      const { abs } = this._r(p); const id = `w${this._watchSeq++}`; const events = [];
      const w = fs.watch(abs, { recursive }, (type, name) => { const full = name ? path.join(abs, String(name)) : abs; events.push({ ts: new Date().toISOString(), type, path: full, sensitive: this._sensitive(full) }); if (events.length > 500) events.shift(); });
      this._watchers.set(id, { w, events, path: abs });
      return { success: true, data: { watchId: id, path: abs }, verification: { verified: true, evidence: { source: 'fs.watch handle opened' } } };
    } catch (err) { return fail(err.message); }
  }
  pollWatch({ watchId }) { const x = this._watchers.get(watchId); if (!x) return fail(`No watcher '${watchId}'`); return { success: true, data: { events: x.events.splice(0) } }; }
  stopWatch({ watchId }) { const x = this._watchers.get(watchId); if (!x) return fail(`No watcher '${watchId}'`); x.w.close(); this._watchers.delete(watchId); return { success: true, data: { stopped: watchId } }; }
  _closeAllWatchers() { for (const [, x] of this._watchers) { try { x.w.close(); } catch { /* ignore */ } } this._watchers.clear(); }

  // ---------- mutations ----------
  async write({ path: p, content, overwrite = false, createDirs = false, reason }, ctx) {
    let abs; try { ({ abs } = this._r(p)); } catch (err) { return fail(err.message); }
    if (this._sensitive(abs)) return this._deny('write', abs);
    if (typeof content !== 'string') return fail('content must be a string');
    const buf = Buffer.from(content, 'utf8'); if (buf.length > MAX_TEXT_BYTES) return fail('content exceeds the 5MB limit');
    return this._mutate({ guardAction: 'file.write', action: overwrite ? 'WRITE' : 'CREATE', target: abs, reason, ctx }, async (opId) => {
      const existed = fs.existsSync(abs);
      if (existed && !overwrite) throw new Error(`'${abs}' already exists — pass overwrite:true (a checkpoint will be taken) or use file.edit`);
      if (!fs.existsSync(path.dirname(abs))) { if (!createDirs) throw new Error('Parent directory does not exist (pass createDirs:true)'); await fs.promises.mkdir(path.dirname(abs), { recursive: true }); }
      const cp = existed ? await this.recovery.checkpoint(opId, abs) : null;
      if (cp) this.journal.patch(opId, { previousState: { sha256: cp.sha256, size: cp.size, checkpoint: cp.ref } });
      await this._atomicWrite(abs, buf);
      const ns = await this._verifyWritten(abs, buf);
      return { data: { path: abs, ...ns, created: !existed }, newState: ns, rollback: { available: true, kind: existed ? 'restore_checkpoint' : 'trash_created', path: abs, ref: cp?.ref ?? null, expectSha: ns.sha256 }, verification: { verified: true, evidence: { source: 'read-back sha256 + size', ...ns } } };
    });
  }
  create(args, ctx) { return this.write({ ...args, overwrite: false, createDirs: args.createDirs ?? true }, ctx); }

  /** Targeted edit. find/replace must match exactly `expectedCount` times (default 1) — no blind rewrites. */
  async edit({ path: p, find, replace, startLine, endLine, replacement, expectedCount = 1, reason }, ctx) {
    let abs; try { ({ abs } = this._r(p)); } catch (err) { return fail(err.message); }
    if (this._sensitive(abs)) return this._deny('edit', abs);
    return this._mutate({ guardAction: 'file.write', action: 'EDIT', target: abs, reason, ctx }, async (opId) => {
      const st = await fs.promises.stat(abs); if (!st.isFile() || st.size > MAX_TEXT_BYTES) throw new Error('Not an editable text file (missing, directory or >5MB)');
      const raw = await fs.promises.readFile(abs); if (isBinary(raw)) throw new Error('Binary file — cannot edit as text');
      const before = raw.toString('utf8'); let after;
      if (find !== undefined) {
        if (typeof find !== 'string' || !find || typeof replace !== 'string') throw new Error('edit needs non-empty find and a string replace');
        const count = before.split(find).length - 1;
        if (count !== expectedCount) throw new Error(`find text matched ${count} time(s), expected ${expectedCount} — refusing an ambiguous edit`);
        after = before.split(find).join(replace);
      } else if (startLine !== undefined) {
        const lines = before.split('\n'); const e = endLine ?? startLine;
        if (!Number.isInteger(startLine) || !Number.isInteger(e) || startLine < 1 || e < startLine || e > lines.length) throw new Error(`Invalid line range ${startLine}-${e} (file has ${lines.length} lines)`);
        after = [...lines.slice(0, startLine - 1), ...String(replacement ?? '').split('\n'), ...lines.slice(e)].join('\n');
      } else throw new Error('edit needs either {find, replace} or {startLine, endLine, replacement}');
      if (after === before) throw new Error('Edit would not change the file');
      const cp = await this.recovery.checkpoint(opId, abs);
      this.journal.patch(opId, { previousState: { sha256: cp.sha256, size: cp.size, checkpoint: cp.ref } });
      const mode = st.mode; const buf = Buffer.from(after, 'utf8');
      await this._atomicWrite(abs, buf); await fs.promises.chmod(abs, mode & 0o777).catch(() => {});
      const ns = await this._verifyWritten(abs, buf);
      return { data: { path: abs, ...ns, linesBefore: before.split('\n').length, linesAfter: after.split('\n').length, checkpoint: cp.ref }, newState: ns, rollback: { available: true, kind: 'restore_checkpoint', path: abs, ref: cp.ref, expectSha: ns.sha256 }, verification: { verified: true, evidence: { source: 'read-back sha256 + size', ...ns } } };
    });
  }

  async delete({ path: p, reason }, ctx) {
    let r; try { r = this._r(p); } catch (err) { return fail(err.message); }
    if (this._sensitive(r.abs)) return this._deny('delete', r.abs);
    if (r.abs === r.workspace.root) return fail('Refusing to delete a workspace root');
    return this._mutate({ guardAction: 'file.delete', action: 'DELETE', target: r.abs, reason, ctx }, async (opId) => {
      if (!fs.existsSync(r.abs)) throw new Error(`'${r.abs}' does not exist`);
      const t = await this.recovery.trash(opId, r.abs);
      if (fs.existsSync(r.abs) || !fs.existsSync(t.ref)) throw new Error('Delete verification failed');
      return { data: { path: r.abs, movedToTrash: t.ref }, newState: { trash: t.ref }, rollback: { available: true, kind: 'restore_trash', ref: t.ref, originalPath: r.abs }, verification: { verified: true, evidence: { source: 'original gone + trash entry present' } } };
    });
  }

  async move({ from, to, overwrite = false, reason }, ctx) { return this._moveLike('MOVE', { from, to, overwrite, reason }, ctx); }
  async rename({ path: p, newName, reason }, ctx) {
    if (typeof newName !== 'string' || !newName || /[\\/]/.test(newName) || newName === '.' || newName === '..') return fail('newName must be a plain file name (no path separators)');
    let abs; try { ({ abs } = this._r(p)); } catch (err) { return fail(err.message); }
    return this._moveLike('RENAME', { from: abs, to: path.join(path.dirname(abs), newName), overwrite: false, reason }, ctx);
  }
  async _moveLike(action, { from, to, overwrite, reason }, ctx) {
    let src, dst; try { src = this._r(from); dst = this._r(to); } catch (err) { return fail(err.message); }
    for (const x of [src.abs, dst.abs]) if (this._sensitive(x)) return this._deny(action.toLowerCase(), x);
    if (src.abs === src.workspace.root) return fail('Refusing to move a workspace root');
    return this._mutate({ guardAction: 'file.move', action, target: `${src.abs} -> ${dst.abs}`, reason, ctx }, async (opId) => {
      if (!fs.existsSync(src.abs)) throw new Error(`'${src.abs}' does not exist`);
      if (fs.existsSync(dst.abs) && !overwrite) throw new Error(`'${dst.abs}' already exists (pass overwrite:true; the old file goes to recovery)`);
      const displaced = fs.existsSync(dst.abs) ? await this.recovery.trash(opId, dst.abs) : null;
      await movePath(src.abs, dst.abs);
      if (fs.existsSync(src.abs) || !fs.existsSync(dst.abs)) throw new Error('Move verification failed');
      return { data: { from: src.abs, to: dst.abs, displaced: displaced?.ref ?? null }, newState: { path: dst.abs }, rollback: { available: true, kind: 'move_back', from: dst.abs, to: src.abs, displaced }, verification: { verified: true, evidence: { source: 'source gone + destination present' } } };
    });
  }

  async copy({ from, to, overwrite = false, reason }, ctx) {
    let src, dst; try { src = this._r(from); dst = this._r(to); } catch (err) { return fail(err.message); }
    for (const x of [src.abs, dst.abs]) if (this._sensitive(x)) return this._deny('copy', x);
    return this._mutate({ guardAction: 'file.write', action: 'COPY', target: `${src.abs} -> ${dst.abs}`, reason, ctx }, async (opId) => {
      const st = await fs.promises.stat(src.abs);
      if (fs.existsSync(dst.abs) && !overwrite) throw new Error(`'${dst.abs}' already exists (pass overwrite:true)`);
      const displaced = fs.existsSync(dst.abs) ? await this.recovery.trash(opId, dst.abs) : null;
      await fs.promises.mkdir(path.dirname(dst.abs), { recursive: true });
      await fs.promises.cp(src.abs, dst.abs, { recursive: true, errorOnExist: true, filter: (s) => !this._sensitive(s) });
      let evidence = { source: 'destination present' };
      if (st.isFile()) { const [a, b] = await Promise.all([sha256File(src.abs), sha256File(dst.abs)]); if (a !== b) throw new Error('Copy verification failed (hash mismatch)'); evidence = { sha256: a }; }
      else if (!fs.existsSync(dst.abs)) throw new Error('Copy verification failed');
      return { data: { from: src.abs, to: dst.abs, note: st.isDirectory() ? 'sensitive files inside the directory were skipped' : undefined }, newState: { path: dst.abs }, rollback: { available: true, kind: 'trash_created', path: dst.abs, displaced }, verification: { verified: true, evidence } };
    });
  }

  _tar(args, { cwd, signal, timeout = 120000 } = {}) {
    return new Promise((resolve, reject) => execFile('tar', args, { cwd, signal, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(`tar failed: ${(stderr || err.message).toString().slice(0, 300)}`)) : resolve(stdout.toString()))));
  }

  async archive({ paths, dest, reason }, ctx) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 50) return fail('paths must be an array of 1-50 paths');
    let srcs, out; try { srcs = paths.map((x) => this._r(x)); out = this._r(dest); } catch (err) { return fail(err.message); }
    if (!/\.(tar\.gz|tgz)$/i.test(out.abs)) return fail('dest must end in .tar.gz or .tgz');
    for (const s of srcs) if (this._sensitive(s.abs)) return this._deny('archive', s.abs);
    return this._mutate({ guardAction: 'file.write', action: 'ARCHIVE', target: out.abs, reason, ctx }, async (opId, signal) => {
      if (fs.existsSync(out.abs)) throw new Error(`'${out.abs}' already exists`);
      const parent = path.dirname(srcs[0].abs);
      if (!srcs.every((s) => path.dirname(s.abs) === parent)) throw new Error('All archived paths must share the same parent directory');
      await fs.promises.mkdir(path.dirname(out.abs), { recursive: true });
      await this._tar(['-czf', out.abs, ...TAR_EXCLUDES.flatMap((e) => ['--exclude', e]), '-C', parent, ...srcs.map((s) => path.basename(s.abs))], { signal });
      const listing = (await this._tar(['-tzf', out.abs], { signal })).split('\n').filter(Boolean);
      if (!listing.length) throw new Error('Archive verification failed (empty listing)');
      const sha = await sha256File(out.abs);
      return { data: { archive: out.abs, entries: listing.length, sha256: sha, note: 'files matching secret/credential patterns were excluded' }, newState: { sha256: sha }, rollback: { available: true, kind: 'trash_created', path: out.abs }, verification: { verified: true, evidence: { source: 'tar -tzf listing', entries: listing.length } } };
    });
  }

  async extract({ archive, destDir, reason }, ctx) {
    let a, d; try { a = this._r(archive); d = this._r(destDir); } catch (err) { return fail(err.message); }
    return this._mutate({ guardAction: 'file.write', action: 'EXTRACT', target: d.abs, reason, ctx }, async (opId, signal) => {
      if (fs.existsSync(d.abs) && fs.readdirSync(d.abs).length) throw new Error('destDir must not exist or must be empty');
      const names = (await this._tar(['-tzf', a.abs], { signal })).split('\n').filter(Boolean);
      const verbose = (await this._tar(['-tvzf', a.abs], { signal })).split('\n').filter(Boolean);
      for (const n of names) { if (path.isAbsolute(n) || /^[A-Za-z]:/.test(n) || n.split(/[\\/]/).includes('..')) throw new Error(`Unsafe archive entry '${n}' (absolute or path traversal) — refusing to extract`); }
      if (verbose.some((l) => /^[lh]/.test(l))) throw new Error('Archive contains symlinks/hardlinks — refusing to extract');
      await fs.promises.mkdir(d.abs, { recursive: true });
      await this._tar(['-xzf', a.abs, '-C', d.abs], { signal });
      const missing = names.filter((n) => !n.endsWith('/') && !fs.existsSync(path.join(d.abs, n)));
      if (missing.length) throw new Error(`Extraction verification failed: ${missing.length} expected file(s) missing`);
      return { data: { extractedTo: d.abs, entries: names.length }, newState: { path: d.abs }, rollback: { available: true, kind: 'trash_created', path: d.abs }, verification: { verified: true, evidence: { source: 'every listed file exists on disk', entries: names.length } } };
    });
  }

  // ---------- history / restore / undo ----------
  fileHistory({ path: p }) {
    this.guard.assertAllowed('file.list');
    try {
      const { abs } = this._r(p);
      const ops = this.journal.list({ limit: 1000 }).filter((o) => String(o.target).split(' -> ').includes(abs)).map((o) => ({ id: o.id, ts: o.ts, action: o.action, status: o.status, reason: o.reason, hasCheckpoint: Boolean(o.previousState?.checkpoint), rollbackAvailable: Boolean(o.rollback?.available && !o.rolledBackBy) }));
      return { success: true, data: { path: abs, operations: ops } };
    } catch (err) { return fail(err.message); }
  }

  /** Undo one journaled operation. Refuses if the file changed since (unless force). Itself journaled. */
  async restore({ operationId, force = false, reason }, ctx) {
    const op = this.journal.get(operationId);
    if (!op) return fail(`No operation #${operationId}`);
    if (!op.rollback?.available) return fail(`Operation #${operationId} has no rollback available`);
    if (op.rolledBackBy) return fail(`Operation #${operationId} was already rolled back by #${op.rolledBackBy}`);
    const rb = op.rollback;
    return this._mutate({ guardAction: 'file.restore', action: 'RESTORE', target: op.target, reason: reason ?? `undo operation #${op.id}`, ctx }, async (newOpId) => {
      if (rb.kind === 'restore_checkpoint') {
        if (!force && (await sha256File(rb.path)) !== rb.expectSha) throw new Error('File has changed since that operation — restoring would discard newer changes (pass force:true)');
        const cur = await this.recovery.checkpoint(newOpId, rb.path); // undoing is itself recoverable
        await this.recovery.restoreCheckpoint(rb.ref, rb.path);
        this.journal.patch(op.id, { rolledBackBy: newOpId });
        return { data: { restored: rb.path, previousVersionSavedAs: cur.ref }, newState: { sha256: await sha256File(rb.path) }, rollback: { available: true, kind: 'restore_checkpoint', path: rb.path, ref: cur.ref, expectSha: await sha256File(rb.path) }, verification: { verified: true, evidence: { source: 'checkpoint copied back + hashed' } } };
      }
      if (rb.kind === 'trash_created') {
        if (!fs.existsSync(rb.path)) throw new Error(`'${rb.path}' no longer exists`);
        const t = await this.recovery.trash(newOpId, rb.path);
        if (rb.displaced) await this.recovery.restoreFromTrash(rb.displaced.ref, rb.displaced.originalPath);
        this.journal.patch(op.id, { rolledBackBy: newOpId });
        return { data: { removed: rb.path, movedToTrash: t.ref, displacedRestored: Boolean(rb.displaced) }, newState: { trash: t.ref }, rollback: { available: true, kind: 'restore_trash', ref: t.ref, originalPath: rb.path }, verification: { verified: true, evidence: { source: 'path gone + trash entry present' } } };
      }
      if (rb.kind === 'restore_trash') {
        await this.recovery.restoreFromTrash(rb.ref, rb.originalPath);
        this.journal.patch(op.id, { rolledBackBy: newOpId });
        return { data: { restored: rb.originalPath }, newState: { path: rb.originalPath }, rollback: { available: false }, verification: { verified: fs.existsSync(rb.originalPath), evidence: { source: 'path exists again' } } };
      }
      if (rb.kind === 'move_back') {
        if (fs.existsSync(rb.to)) throw new Error(`'${rb.to}' exists now — cannot move back`);
        await movePath(rb.from, rb.to);
        if (rb.displaced) await this.recovery.restoreFromTrash(rb.displaced.ref, rb.displaced.originalPath);
        this.journal.patch(op.id, { rolledBackBy: newOpId });
        return { data: { movedBack: rb.to }, newState: { path: rb.to }, rollback: { available: true, kind: 'move_back', from: rb.to, to: rb.from }, verification: { verified: fs.existsSync(rb.to) && !fs.existsSync(rb.from), evidence: { source: 'source restored, destination gone' } } };
      }
      throw new Error(`Unknown rollback kind '${rb.kind}'`);
    });
  }

  undoLast(args = {}, ctx) {
    const op = this.journal.latestRollbackable();
    if (!op) return Promise.resolve(fail('Nothing to undo — no recent operation has rollback available'));
    return this.restore({ operationId: op.id, ...args }, ctx);
  }

  /** "Restore browser.js to yesterday's version": restores the checkpoint captured by the first edit after `asOf`. */
  async restoreVersion({ path: p, asOf, force = false }, ctx) {
    let abs; try { ({ abs } = this._r(p)); } catch (err) { return fail(err.message); }
    const t = Date.parse(asOf); if (!Number.isFinite(t)) return fail('asOf must be an ISO date/time');
    const candidate = this.journal.list({ limit: 5000 }).filter((o) => o.target === abs && o.previousState?.checkpoint && o.status === 'completed' && Date.parse(o.ts) >= t).sort((x, y) => x.id - y.id)[0];
    if (!candidate) return fail(`No recorded version of '${abs}' from before an edit made after ${asOf}`);
    return this._mutate({ guardAction: 'file.restore', action: 'RESTORE_VERSION', target: abs, reason: `restore version as of ${asOf} (checkpoint from operation #${candidate.id})`, ctx }, async (opId) => {
      const saved = fs.existsSync(abs) ? await this.recovery.checkpoint(opId, abs) : null;
      await this.recovery.restoreCheckpoint(candidate.previousState.checkpoint, abs);
      const sha = await sha256File(abs);
      if (sha !== candidate.previousState.sha256) throw new Error('Restore verification failed (hash differs from recorded checkpoint)');
      return { data: { path: abs, restoredFromOperation: candidate.id, sha256: sha }, newState: { sha256: sha }, rollback: saved ? { available: true, kind: 'restore_checkpoint', path: abs, ref: saved.ref, expectSha: sha } : { available: false }, verification: { verified: true, evidence: { source: 'hash matches checkpoint record', sha256: sha } } };
    });
  }

  /** Lets the mission layer attach test results to an operation ("Tests: PASSED"). */
  recordTests(operationId, tests) { return this.journal.patch(operationId, { tests }); }
}

module.exports = { FileSystemService };
