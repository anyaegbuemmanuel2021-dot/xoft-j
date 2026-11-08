/**
 * Hermes runtime layer: environment detection, install guidance, the managed-process supervisor, and the
 * Xoft ⇄ Hermes bridge configuration helpers. Everything Hermes-process-specific lives here or in this folder.
 *
 * Nothing in this file installs software on its own. Detection is read-only; `installGuidance()` only *describes*
 * the official install commands (verified against the Hermes docs); the CLI runs one only when a human passes --yes.
 */
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineError, ErrorCode } from '../constants.js';
import { redactString } from '../redact.js';

export const HERMES_DOCS = Object.freeze({
  home: 'https://hermes-agent.nousresearch.com/docs',
  apiServer: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server',
  mcp: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp',
  repo: 'https://github.com/NousResearch/hermes-agent',
});

const isWin = (platform) => platform === 'win32';

/** Where Hermes keeps its data. HERMES_HOME wins; native Windows uses %LOCALAPPDATA%\hermes, everything else ~/.hermes. */
export function hermesHomeDir({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (env.HERMES_HOME) return env.HERMES_HOME;
  if (isWin(platform) && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'hermes');
  return path.join(homedir, '.hermes');
}

/** PATH lookup without shelling out (`which`/`where` differ per OS). Returns an absolute path or null. */
export function findExecutable(name, { env = process.env, platform = process.platform, extraDirs = [] } = {}) {
  if (!name) return null;
  if (path.isAbsolute(name) || name.includes(path.sep)) return isExecutableFile(name, platform) ? path.resolve(name) : null;
  const exts = isWin(platform) ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  const dirs = [...(env.PATH ?? env.Path ?? '').split(path.delimiter), ...extraDirs].filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, isWin(platform) && path.extname(name) ? name : `${name}${ext}`);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

function isExecutableFile(p, platform = process.platform) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (!isWin(platform)) fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

const run = (file, args, { timeout = 4000, execFileImpl = execFile } = {}) => new Promise((resolve) => {
  try {
    execFileImpl(file, args, { timeout, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim(), error: err?.message ?? null });
    });
  } catch (err) { resolve({ ok: false, stdout: '', stderr: '', error: err.message }); }
});

const PROVIDER_VAR = /^(OPENROUTER|OPENAI|ANTHROPIC|NOUS|GEMINI|GOOGLE|MINIMAX|KIMI|MOONSHOT|GLM|ZAI|Z_AI|HF|HUGGINGFACE|NOVITA|NVIDIA|XIAOMI|MIMO|DEEPSEEK|XAI|MISTRAL|GROQ|TOGETHER|FIREWORKS)[A-Z0-9_]*(KEY|TOKEN)$/;

/** Names (never values) of model-provider credentials present in Hermes' own .env. */
export function readConfiguredProviders(hermesHome) {
  try {
    const text = fs.readFileSync(path.join(hermesHome, '.env'), 'utf8');
    const names = [];
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && PROVIDER_VAR.test(m[1]) && m[2] && !/^["']{0,2}$/.test(m[2])) names.push(m[1]);
    }
    return names;
  } catch { return []; }
}

/**
 * Reports whether Hermes has an OS-level terminal sandbox available.
 *
 * This is deliberately separate from Git worktree isolation: a worktree protects the
 * checkout, but it is not a kernel security boundary. Even when Docker is reachable,
 * Xoft currently cannot bind each task's dynamically-created worktree into Hermes'
 * long-lived terminal container, so "isolated" remains false until that hand-off exists.
 */
export async function detectExecutionSandbox({ settings = {}, env = process.env, platform = process.platform, execFileImpl = execFile } = {}) {
  const configured = settings.environment ?? {};
  const backend = String(configured.TERMINAL_ENV ?? env.TERMINAL_ENV ?? 'local').toLowerCase();
  if (backend === 'local') {
    return { backend, runtimeAvailable: false, taskWorkspaceBinding: false, isolated: false, reason: 'Hermes terminal is using the local host backend; Git worktrees are not an OS security boundary.' };
  }
  if (backend === 'docker') {
    const binaryName = configured.HERMES_DOCKER_BINARY ?? env.HERMES_DOCKER_BINARY ?? 'docker';
    const binary = findExecutable(binaryName, { env, platform })
      ?? (binaryName === 'docker' ? findExecutable('podman', { env, platform }) : null);
    if (!binary) return { backend, runtimeAvailable: false, taskWorkspaceBinding: false, isolated: false, reason: 'Docker/Podman executable was not found.' };
    const result = await run(binary, ['info', '--format', '{{.ServerVersion}}'], { timeout: 5000, execFileImpl });
    if (!result.ok || !result.stdout) return { backend, runtimeAvailable: false, taskWorkspaceBinding: false, isolated: false, reason: 'Docker/Podman CLI exists, but its daemon is not reachable.' };
    return { backend, runtimeAvailable: true, taskWorkspaceBinding: false, isolated: false, runtimeVersion: result.stdout.slice(0, 80), reason: 'Container runtime is reachable, but XOFT does not yet mount each task worktree into its own Hermes execution container.' };
  }
  if (backend === 'daytona') {
    const configuredKey = Boolean(configured.DAYTONA_API_KEY || env.DAYTONA_API_KEY);
    return { backend, runtimeAvailable: configuredKey, taskWorkspaceBinding: false, isolated: false, reason: configuredKey ? 'Daytona credentials are present, but per-task XOFT workspace binding is not implemented.' : 'DAYTONA_API_KEY is not configured.' };
  }
  if (backend === 'modal') {
    const configuredKey = Boolean((configured.MODAL_TOKEN_ID || env.MODAL_TOKEN_ID) && (configured.MODAL_TOKEN_SECRET || env.MODAL_TOKEN_SECRET));
    return { backend, runtimeAvailable: configuredKey, taskWorkspaceBinding: false, isolated: false, reason: configuredKey ? 'Modal credentials are present, but per-task XOFT workspace binding is not implemented.' : 'Modal credentials are not configured.' };
  }
  if (backend === 'ssh') {
    const configuredHost = Boolean(configured.TERMINAL_SSH_HOST || env.TERMINAL_SSH_HOST);
    const configuredUser = Boolean(configured.TERMINAL_SSH_USER || env.TERMINAL_SSH_USER);
    return { backend, runtimeAvailable: configuredHost && configuredUser, taskWorkspaceBinding: false, isolated: false, reason: 'SSH execution is not treated as isolated until XOFT can provision and bind a task-specific remote workspace.' };
  }
  return { backend, runtimeAvailable: false, taskWorkspaceBinding: false, isolated: false, reason: `Unsupported or unverified Hermes terminal backend '${backend}'.` };
}

/**
 * Read-only survey of the machine (spec section 6). Used by health checks, the UI and `xoft engine detect`.
 * @param {{settings?:object, env?:object, platform?:string, execFileImpl?:Function, apiKeySource?:string}} [opts]
 */
export async function detectEnvironment({ settings = {}, env = process.env, platform = process.platform, execFileImpl = execFile, apiKeySource = 'none' } = {}) {
  const home = settings.hermesHome || hermesHomeDir({ env, platform });
  const executionSandbox = await detectExecutionSandbox({ settings, env, platform, execFileImpl });
  const extraDirs = [path.join(os.homedir(), '.local', 'bin'), ...(isWin(platform) && env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'hermes'), path.join(env.LOCALAPPDATA, 'hermes', 'bin'), path.join(env.LOCALAPPDATA, 'hermes', 'Scripts')] : [])];
  const hermesPath = findExecutable(settings.runtimePath || 'hermes', { env, platform, extraDirs });

  const probe = async (cmd, args = ['--version']) => {
    const p = findExecutable(cmd, { env, platform });
    if (!p) return { found: false };
    const r = await run(p, args, { execFileImpl });
    return { found: true, path: p, version: (r.stdout || r.stderr).split('\n')[0].slice(0, 80) || null };
  };
  const [python, git, npm, pnpm, yarn, uv, pip] = await Promise.all([
    probe(isWin(platform) ? 'python' : 'python3'), probe('git'), probe('npm'), probe('pnpm'), probe('yarn'), probe('uv'), probe(isWin(platform) ? 'pip' : 'pip3'),
  ]);
  let hermesVersion = null;
  if (hermesPath) hermesVersion = ((await run(hermesPath, ['--version'], { timeout: 6000, execFileImpl })).stdout || '').split('\n')[0].slice(0, 80) || null;

  let wsl = false;
  try { wsl = platform === 'linux' && /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { /* not linux */ }

  return {
    os: { platform, arch: process.arch, release: os.release(), wsl },
    node: { version: process.version },
    python, git, packageManagers: { npm, pnpm, yarn, uv, pip },
    virtualEnv: env.VIRTUAL_ENV ? path.basename(env.VIRTUAL_ENV) : null,
    hermes: {
      installed: Boolean(hermesPath),
      path: hermesPath,
      version: hermesVersion,
      home,
      homeExists: fs.existsSync(home),
      hasConfig: fs.existsSync(path.join(home, 'config.yaml')),
      hasEnvFile: fs.existsSync(path.join(home, '.env')),
      configuredProviders: readConfiguredProviders(home),
    },
    api: { baseUrl: settings.baseUrl ?? null, keyConfigured: apiKeySource !== 'none', keySource: apiKeySource },
    executionSandbox,
  };
}

/**
 * The official install routes for this OS — commands verified against the Hermes README/docs. NOT executed here.
 * @returns {{recommended:object, alternatives:object[], afterInstall:string[], notes:string[], docs:object}}
 */
export function installGuidance({ platform = process.platform, wsl = false } = {}) {
  const posix = { id: 'install-script', title: 'Official install script (Linux, macOS, WSL2)', shell: 'bash', commands: ['curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash'] };
  const windows = { id: 'install-ps1', title: 'Official PowerShell installer (native Windows)', shell: 'powershell', commands: ['iex (irm https://hermes-agent.nousresearch.com/install.ps1)'] };
  const source = { id: 'from-source', title: 'From source (requires git and uv)', shell: 'bash', commands: ['git clone https://github.com/NousResearch/hermes-agent.git', 'cd hermes-agent', 'curl -LsSf https://astral.sh/uv/install.sh | sh', 'uv pip install -e ".[all,dev]"'] };
  const recommended = isWin(platform) ? windows : posix;
  return {
    recommended,
    alternatives: isWin(platform) ? [{ ...posix, title: 'Inside WSL2 (Linux command)' }, source] : [source],
    afterInstall: [
      'hermes setup            # configure a model provider (or: hermes setup --portal)',
      'hermes doctor           # diagnose the installation',
      'Add to Hermes\' .env:   API_SERVER_ENABLED=true  and  API_SERVER_KEY=<long random secret>',
      'hermes gateway          # starts the API server on http://127.0.0.1:8642',
      'Set HERMES_API_KEY in Xoft\'s .env to the same key (or let Xoft manage the process: HERMES_AUTO_START=true).',
    ],
    notes: [
      'Xoft never runs these for you automatically: the installer is a remote script, so a human must choose to run it (`npm run xoft -- engine install hermes --run --yes`).',
      isWin(platform) ? 'Native Windows installs live under %LOCALAPPDATA%\\hermes; WSL2 installs under ~/.hermes.' : 'Hermes keeps its data in ~/.hermes (override with HERMES_HOME).',
      wsl ? 'You are running inside WSL2: Hermes started here listens on the WSL loopback; a Xoft running on the Windows side usually reaches it through localhost forwarding.' : null,
      'Hermes is optional. Xoft keeps working without it and falls back to the Xoft Core engine.',
    ].filter(Boolean),
    docs: HERMES_DOCS,
  };
}

/** Random, URL-safe secret. */
export const randomSecret = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/**
 * Persists small secrets (managed-runtime API key, bridge token) with owner-only permissions, like GatewaySettingsStore does.
 * The values are only ever returned to in-process callers — never logged and never put in an API response by default.
 */
export class EngineSecretStore {
  constructor({ dataDir = './data', fileName = 'engine-secrets.json', sqliteStore = null } = {}) {
    this.dir = path.join(dataDir, 'engines');
    this.file = path.join(this.dir, fileName);
    this.sqliteStore = sqliteStore;
    this.sqliteKey = `secrets:${fileName}`;
  }

  _read() {
    if (this.sqliteStore) {
      let data = this.sqliteStore.get(this.sqliteKey);
      if (data === null && fs.existsSync(this.file)) {
        try {
          data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
          this.sqliteStore.set(this.sqliteKey, data);
        } catch { data = {}; }
      }
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    }
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
  }

  _write(data) {
    if (this.sqliteStore) {
      this.sqliteStore.set(this.sqliteKey, data);
      return;
    }
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort on Windows */ }
  }

  get(name) { return this._read()[name]?.value ?? null; }
  has(name) { return Boolean(this.get(name)); }

  ensure(name, generate = () => randomSecret()) {
    const data = this._read();
    if (!data[name]?.value) { data[name] = { value: generate(), createdAt: new Date().toISOString() }; this._write(data); }
    return data[name].value;
  }

  rotate(name, generate = () => randomSecret()) {
    const data = this._read();
    data[name] = { value: generate(), createdAt: new Date().toISOString() };
    this._write(data);
    return data[name].value;
  }

  info(name) { const e = this._read()[name]; return e ? { exists: true, createdAt: e.createdAt } : { exists: false, createdAt: null }; }
}

/**
 * YAML for Hermes' ~/.hermes/config.yaml that makes Hermes consume Xoft's tools through the Tool Gateway
 * (`mcp_servers`, HTTP transport, `${VAR}` interpolated from Hermes' environment — documented MCP client format).
 */
export function bridgeConfigSnippet({ bridgeUrl, serverName = 'xoft', tokenEnvVar = 'XOFT_TOOL_TOKEN' } = {}) {
  return [
    'mcp_servers:',
    `  ${serverName}:`,
    `    url: "${bridgeUrl}"`,
    '    headers:',
    `      Authorization: "Bearer \${${tokenEnvVar}}"`,
  ].join('\n');
}

/**
 * Applies the snippet to config.yaml ONLY in the unambiguous case (no `mcp_servers:` key yet), after taking a backup.
 * Merging into an existing mcp_servers block by text would be guesswork, so that case returns instructions instead.
 */
export function applyBridgeConfig({ hermesHome, snippet, serverName = 'xoft' }) {
  const file = path.join(hermesHome, 'config.yaml');
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') return { applied: false, reason: `cannot read ${file}: ${err.message}` }; }
  if (new RegExp(`^\\s{2}${serverName}:`, 'm').test(current)) return { applied: false, reason: `config.yaml already defines an '${serverName}' MCP server`, file };
  if (/^mcp_servers:/m.test(current)) return { applied: false, reason: "config.yaml already has an mcp_servers block — add the snippet's server entry to it by hand", file };
  fs.mkdirSync(hermesHome, { recursive: true });
  let backup = null;
  if (current) { backup = `${file}.xoft-backup`; fs.copyFileSync(file, backup); }
  fs.writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}\n${snippet}\n`);
  return { applied: true, file, backup };
}

/** Resident memory of a process in MB, or null where it cannot be read cheaply (Windows, or the process is gone). */
export async function readRssMb(pid, { platform = process.platform, execFileImpl = execFile } = {}) {
  if (!pid) return null;
  try {
    if (platform === 'linux') {
      const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)\s+kB/);
      return m ? Math.round(Number(m[1]) / 1024) : null;
    }
    if (platform === 'darwin') {
      const r = await run('ps', ['-o', 'rss=', '-p', String(pid)], { execFileImpl });
      return r.ok && r.stdout ? Math.round(Number(r.stdout) / 1024) : null;
    }
  } catch { /* fall through */ }
  return null;
}

/** Environment variables a Xoft-managed Hermes process may inherit. Xoft's own provider keys and secrets are NOT passed on. */
const INHERITED = ['PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'HERMES_HOME', 'VIRTUAL_ENV', 'UV_CACHE_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];
export function buildManagedEnv({ base = process.env, extra = {}, apiKey, port, host, bridgeToken = null, bridgeTokenVar = 'XOFT_TOOL_TOKEN' }) {
  const env = {};
  for (const k of INHERITED) if (base[k] !== undefined) env[k] = base[k];
  Object.assign(env, extra);
  Object.assign(env, { API_SERVER_ENABLED: 'true', API_SERVER_KEY: apiKey, API_SERVER_HOST: host, API_SERVER_PORT: String(port) });
  if (bridgeToken) env[bridgeTokenVar] = bridgeToken;
  return env;
}

/** Supervises one `hermes gateway` child process started by Xoft. Xoft never touches a Hermes it did not start. */
export class HermesProcess {
  constructor({ command, args = ['gateway'], cwd, env, spawnImpl = spawn, maxLogLines = 400, onExit = null, onLog = null, platform = process.platform }) {
    Object.assign(this, { command, args, cwd, env, spawnImpl, maxLogLines, onExit, onLog, platform });
    this.child = null;
    this.startedAt = null;
    this.exit = null;
    this._logs = [];
    this._stopping = false;
  }

  get running() { return Boolean(this.child) && this.exit === null; }
  get pid() { return this.child?.pid ?? null; }

  logs(n = 100) { return this._logs.slice(-n); }

  _push(stream, chunk) {
    for (const raw of String(chunk).split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const line = `${new Date().toISOString()} [${stream}] ${redactString(raw).slice(0, 600)}`;
      this._logs.push(line);
      if (this._logs.length > this.maxLogLines) this._logs.shift();
      try { this.onLog?.(line); } catch { /* logging must never break supervision */ }
    }
  }

  async start() {
    if (this.running) return this.pid;
    this.exit = null; this._stopping = false;
    const useCmdShim = isWin(this.platform) && /\.(cmd|bat)$/i.test(this.command);
    const file = useCmdShim ? (this.env.ComSpec ?? 'cmd.exe') : this.command;
    const args = useCmdShim ? ['/d', '/s', '/c', this.command, ...this.args] : this.args;
    await new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnImpl(file, args, { cwd: this.cwd || undefined, env: this.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !isWin(this.platform) });
      } catch (err) { reject(new EngineError(ErrorCode.UNAVAILABLE, `Could not start Hermes: ${err.message}`, { cause: err })); return; }
      this.child = child;
      child.once('error', (err) => { this.exit = { code: null, signal: null, error: err.message }; reject(new EngineError(ErrorCode.UNAVAILABLE, err.code === 'ENOENT' ? `Hermes executable not found: ${this.command}` : `Could not start Hermes: ${err.message}`, { cause: err })); });
      child.once('spawn', () => { this.startedAt = new Date().toISOString(); resolve(); });
      child.stdout?.on('data', (d) => this._push('out', d));
      child.stderr?.on('data', (d) => this._push('err', d));
      child.once('exit', (code, signal) => {
        this.exit = { code, signal, at: new Date().toISOString() };
        try { this.onExit?.({ code, signal, expected: this._stopping }); } catch { /* supervision callbacks must not throw */ }
      });
    });
    return this.pid;
  }

  async stop({ graceMs = 8000 } = {}) {
    if (!this.child || this.exit) return;
    this._stopping = true;
    const pid = this.child.pid;
    const exited = new Promise((resolve) => this.child.once('exit', resolve));
    if (isWin(this.platform)) {
      await new Promise((resolve) => execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { this.child.kill('SIGTERM'); } catch { /* already gone */ } }
    }
    const timer = setTimeout(() => { if (!isWin(this.platform)) { try { process.kill(-pid, 'SIGKILL'); } catch { try { this.child.kill('SIGKILL'); } catch { /* gone */ } } } }, graceMs);
    timer.unref?.();
    await Promise.race([exited, new Promise((r) => setTimeout(r, graceMs + 2000).unref?.())]);
    clearTimeout(timer);
  }

  status() { return { running: this.running, pid: this.pid, startedAt: this.startedAt, exit: this.exit }; }
}
