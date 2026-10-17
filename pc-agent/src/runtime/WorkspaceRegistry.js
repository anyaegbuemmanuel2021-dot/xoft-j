'use strict';
const fs = require('node:fs');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';
const norm = (p) => (IS_WIN ? p.toLowerCase() : p);
const within = (child, root) => norm(child) === norm(root) || norm(child).startsWith(norm(root) + path.sep);
const slug = (s) => String(s).toLowerCase().replace(/[\s\-_.]+/g, '');

/** realpath of the deepest existing ancestor + the not-yet-existing remainder (so new files are still symlink-checked). */
function realResolve(abs) {
  let cur = abs; const rest = [];
  while (!fs.existsSync(cur)) { const parent = path.dirname(cur); if (parent === cur) break; rest.unshift(path.basename(cur)); cur = parent; }
  return path.join(fs.realpathSync(cur), ...rest);
}

function detectProject(root) {
  const has = (f) => fs.existsSync(path.join(root, f));
  const info = { root, type: null, packageManager: null, scripts: {}, entryPoints: [], commands: {}, hasGit: has('.git') };
  if (has('package.json')) {
    info.type = 'node';
    info.packageManager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') ? 'bun' : 'npm';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      info.name = pkg.name ?? null;
      info.scripts = pkg.scripts ?? {};
      if (pkg.main) info.entryPoints.push(pkg.main);
      info.dependencies = Object.keys(pkg.dependencies ?? {}); info.devDependencies = Object.keys(pkg.devDependencies ?? {});
    } catch { info.packageJsonUnreadable = true; }
    for (const s of ['test', 'build', 'start', 'lint']) if (info.scripts[s]) info.commands[s] = `${info.packageManager} ${s === 'test' || s === 'start' ? s : `run ${s}`}`;
  } else if (has('pyproject.toml') || has('requirements.txt')) { info.type = 'python'; info.packageManager = has('poetry.lock') ? 'poetry' : 'pip'; info.commands.test = 'python -m pytest'; }
  else if (has('Cargo.toml')) { info.type = 'rust'; info.packageManager = 'cargo'; info.commands = { test: 'cargo test', build: 'cargo build' }; }
  else if (has('go.mod')) { info.type = 'go'; info.packageManager = 'go'; info.commands = { test: 'go test ./...', build: 'go build ./...' }; }
  else if (has('pom.xml')) { info.type = 'java'; info.packageManager = 'maven'; info.commands = { test: 'mvn test', build: 'mvn package' }; }
  else if (info.hasGit) info.type = 'git';
  return info;
}

/**
 * WorkspaceRegistry — named project roots. It is the ONLY path resolver for file/terminal work:
 * every path becomes an absolute REAL path (symlinks resolved) that must sit inside a registered
 * workspace, or resolve() throws. Relative paths resolve against the active workspace.
 */
class WorkspaceRegistry {
  constructor({ stateDir, seed = [] } = {}) {
    if (!stateDir) throw new Error('WorkspaceRegistry: stateDir is required');
    this.file = path.join(stateDir, 'workspaces.json');
    fs.mkdirSync(stateDir, { recursive: true });
    this._data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { workspaces: [], active: null };
    for (const s of seed) if (!this._data.workspaces.some((w) => norm(w.root) === norm(path.resolve(s.root)))) this._data.workspaces.push({ name: s.name, root: fs.existsSync(s.root) ? fs.realpathSync(s.root) : path.resolve(s.root), addedAt: new Date().toISOString(), seeded: true });
    if (!this._data.active && this._data.workspaces.length === 1) this._data.active = this._data.workspaces[0].name;
    this._save();
  }

  _save() { fs.writeFileSync(this.file, JSON.stringify(this._data, null, 2)); }

  add(name, root) {
    if (!name || !/^[\w .-]{1,60}$/.test(name)) throw new Error('Workspace name must be 1-60 chars: letters, digits, space, _ . -');
    const abs = path.resolve(root);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`Workspace root '${root}' is not an existing directory`);
    const real = fs.realpathSync(abs);
    if (path.parse(real).root === real) throw new Error('Refusing to register a filesystem root as a workspace');
    if (norm(real) === norm(require('node:os').homedir())) throw new Error('Refusing to register the whole home directory — register a specific folder');
    if (this._data.workspaces.some((w) => w.name.toLowerCase() === name.toLowerCase())) throw new Error(`A workspace named '${name}' already exists`);
    this._data.workspaces.push({ name, root: real, addedAt: new Date().toISOString() });
    if (!this._data.active) this._data.active = name;
    this._save();
    return { name, root: real };
  }

  remove(name) {
    const before = this._data.workspaces.length;
    this._data.workspaces = this._data.workspaces.filter((w) => w.name !== name);
    if (this._data.workspaces.length === before) throw new Error(`No workspace named '${name}'`);
    if (this._data.active === name) this._data.active = null;
    this._save();
  }

  get(name) { return this._data.workspaces.find((w) => w.name.toLowerCase() === String(name).toLowerCase()) ?? null; }
  list() { return this._data.workspaces.map((w) => ({ ...w, active: w.name === this._data.active })); }
  active() { return this.get(this._data.active); }
  setActive(name) { const w = this.get(name); if (!w) throw new Error(`No workspace named '${name}'`); this._data.active = w.name; this._save(); return w; }

  /** Resolve to a real absolute path inside a workspace, or throw. */
  resolve(input, { workspace = null } = {}) {
    if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new Error('Invalid path');
    const base = workspace ? this.get(workspace) : this.active();
    if (!path.isAbsolute(input) && !base) throw new Error('Relative path given but no active workspace is set');
    const abs = path.resolve(path.isAbsolute(input) ? input : path.join(base.root, input));
    const real = realResolve(abs);
    const ws = this._data.workspaces.find((w) => within(real, w.root));
    if (!ws) throw new Error(`Path '${input}' is outside every registered workspace — refusing.`);
    return { abs: real, workspace: ws, relative: path.relative(ws.root, real) };
  }

  inspectProject(name) { const w = this.get(name) ?? this.active(); if (!w) throw new Error('No such workspace'); return { workspace: w.name, ...detectProject(w.root) }; }

  /** Finds a project directory by (fuzzy) name inside registered workspaces, depth <= 3. */
  locateProject(query, { maxDepth = 3 } = {}) {
    const q = slug(query); const found = [];
    const skip = new Set(['node_modules', '.git', '.xoft', 'dist', 'build', '.next', '__pycache__']);
    const walk = (dir, depth, ws) => {
      if (depth > maxDepth || found.length >= 20) return;
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (!e.isDirectory() || skip.has(e.name) || e.isSymbolicLink()) continue;
        const full = path.join(dir, e.name);
        const s = slug(e.name);
        if (s === q || s.includes(q)) { const p = detectProject(full); if (p.type) found.push({ name: e.name, path: full, workspace: ws.name, exact: s === q, type: p.type }); }
        walk(full, depth + 1, ws);
      }
    };
    for (const ws of this._data.workspaces) { const p = detectProject(ws.root); if (p.type && slug(path.basename(ws.root)).includes(q)) found.push({ name: ws.name, path: ws.root, workspace: ws.name, exact: slug(ws.name) === q, type: p.type }); walk(ws.root, 1, ws); }
    return found.sort((a, b) => Number(b.exact) - Number(a.exact));
  }
}

module.exports = { WorkspaceRegistry, detectProject, within };
