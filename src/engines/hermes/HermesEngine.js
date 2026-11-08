import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Availability, Capability, ENGINE_AUTONOMY_LABELS, EngineError, EngineEvent, EngineStatus, ErrorCode } from '../constants.js';
import { Engine } from '../Engine.js';
import { deniedPermissions, grantedPermissions, isBridgedTool, parseToolPreview } from '../EnginePermissions.js';
import { redactString } from '../redact.js';
import { HermesClient } from './HermesClient.js';
import { resolveHermesSettings, publicHermesSettings } from './hermesConfig.js';
import {
  EngineSecretStore, HERMES_DOCS, HermesProcess, applyBridgeConfig, bridgeConfigSnippet, buildManagedEnv, detectEnvironment, installGuidance, readRssMb,
} from './HermesRuntime.js';

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(resolve, ms); // ref'd on purpose: an awaited wait must keep the process alive
  signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

const FS_CAPS = [Capability.FILESYSTEM, Capability.TERMINAL, Capability.CODING];
const OK_WORDS = new Set(['ok', 'pass', 'passed', 'healthy', 'ready', 'configured', 'true', 'up']);
const BAD_WORDS = new Set(['fail', 'failed', 'error', 'missing', 'unconfigured', 'not_configured', 'down', 'false', 'unhealthy', 'critical']);

/** Hermes' readiness payload is documented only loosely ("bounded status for config, model, disk…"), so this reads it defensively. */
export function readinessFlag(detail, pattern) {
  const checks = detail?.readiness?.checks ?? detail?.checks ?? null;
  if (!checks) return null;
  const entries = Array.isArray(checks) ? checks.map((c) => [c.name ?? c.id ?? '', c.status ?? c.ok ?? c.state]) : Object.entries(checks).map(([k, v]) => [k, typeof v === 'object' && v !== null ? (v.status ?? v.ok ?? v.state) : v]);
  const hit = entries.find(([name]) => pattern.test(String(name)));
  if (!hit) return null;
  const v = String(hit[1]).toLowerCase();
  if (hit[1] === true || OK_WORDS.has(v)) return true;
  if (hit[1] === false || BAD_WORDS.has(v)) return false;
  return null;
}

/** Which native capabilities the enabled toolsets provide. Returns null when the toolset list could not be read. */
export function capabilitiesFromToolsets(toolsets) {
  const list = Array.isArray(toolsets) ? toolsets : (Array.isArray(toolsets?.toolsets) ? toolsets.toolsets : (Array.isArray(toolsets?.data) ? toolsets.data : null));
  if (!list) return null;
  const names = [];
  for (const ts of list) {
    if (ts?.enabled === false || ts?.configured === false) continue;
    for (const t of ts?.tools ?? []) names.push(String(t?.name ?? t));
    names.push(String(ts?.name ?? ''));
  }
  const has = (re) => names.some((n) => re.test(n));
  return { terminal: has(/^(terminal|shell|bash|execute|process)/i), filesystem: has(/(read_file|write_file|patch|file)/i), browser: has(/browser/i), web_search: has(/web_search|web_extract|search/i), memory: has(/memory/i) };
}

/**
 * HermesEngine — Hermes Agent (Nous Research) as a pluggable Xoft engine. All Hermes-specific code lives in this folder.
 * Hermes is reached ONLY through its documented HTTP API server (POST /v1/runs + SSE events); Xoft never imports Hermes code,
 * never shares a Python environment with it, and works fully without it.
 */
export class HermesEngine extends Engine {
  constructor({ settingsStore, secretStore = null, activityLog = null, eventBus = null, bridge = null, dataDir = './data', env = process.env, fetchImpl = globalThis.fetch, spawnImpl, execFileImpl, platform = process.platform, startTimeoutMs = 45000 } = {}) {
    super({
      id: 'hermes', name: 'Hermes', kind: 'agent',
      description: 'Autonomous multi-step agent (Nous Research Hermes Agent): coding, terminal, files, web and long-running tasks.',
      capabilities: [],
    });
    Object.assign(this, { settingsStore, activityLog, eventBus, bridge, dataDir, env, fetchImpl, spawnImpl, execFileImpl, platform, startTimeoutMs });
    this.secretStore = secretStore ?? new EngineSecretStore({ dataDir });
    this.bridgeName = 'xoft';
    this.settings = resolveHermesSettings({ env, saved: settingsStore?.load?.() ?? {} });
    this.client = new HermesClient({ baseUrl: this.settings.baseUrl, apiKey: this._resolveApiKey().key, fetchImpl });
    this.proc = null;
    this.managed = false;
    this._envCache = null;
    this._memTimer = null;
    this._lastHealth = null;
    this._capsFromServer = null;
    this.setStatus(this.settings.enabled ? EngineStatus.OFFLINE : EngineStatus.DISABLED, this.settings.enabled ? 'not checked yet' : 'disabled in settings');
  }

  // ---- settings & secrets -------------------------------------------------------------------------------------

  _resolveApiKey() {
    if (this.env.HERMES_API_KEY) return { key: this.env.HERMES_API_KEY, source: 'env' };
    const stored = this.secretStore?.get?.('hermes-api-key');
    return stored ? { key: stored, source: 'managed' } : { key: '', source: 'none' };
  }

  getSettings() { return publicHermesSettings(this.settings); }

  /** Validates, persists and applies a settings change. Throws Error (message safe to show) on invalid input. */
  async updateSettings(partial) {
    const saved = this.settingsStore.update(partial);
    this.settings = resolveHermesSettings({ env: this.env, saved });
    this.client = new HermesClient({ baseUrl: this.settings.baseUrl, apiKey: this._resolveApiKey().key, fetchImpl: this.fetchImpl });
    this._envCache = null;
    if (!this.settings.enabled) { this.setStatus(EngineStatus.DISABLED, 'disabled in settings'); if (this.managed) await this.stop(); }
    this.activityLog?.log({ type: 'engine_settings_changed', detail: { engineId: this.id, keys: Object.keys(partial ?? {}) } });
    return this.getSettings();
  }

  taskPolicy() {
    const s = this.settings;
    return {
      maxConcurrentTasks: s.maxConcurrentTasks, timeoutMs: s.timeoutMs, maxToolCalls: s.maxToolCalls, maxRetries: s.maxRetries,
      allowedRoots: s.allowedRoots, defaultWorkingDirectory: s.workingDirectory || null, permissionProfile: s.permissionProfile,
      defaultAutonomy: s.defaultAutonomy, nativeToolPolicy: s.nativeToolPolicy, workspaceMode: s.workspaceMode,
      requiresWorkingDirectory: (a) => (a?.requiredCapabilities ?? []).some((c) => FS_CAPS.includes(c)),
    };
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------------

  async initialize() {
    if (!this.settings.enabled) { this.setStatus(EngineStatus.DISABLED, 'disabled in settings'); return this.describe(); }
    try {
      let health = await this.healthCheck();
      if (!health.available && this.settings.autoStart && health.dependencies.runtime) { try { await this.start(); } catch (err) { this.activityLog?.log({ type: 'engine_autostart_failed', detail: { engineId: this.id, error: err.message } }); } }
    } catch { /* initialize must never throw */ }
    return this.describe();
  }

  async _environment(force = false) {
    if (!force && this._envCache && Date.now() - this._envCache.at < 60000) return this._envCache.value;
    const value = await detectEnvironment({ settings: this.settings, env: this.env, platform: this.platform, ...(this.execFileImpl ? { execFileImpl: this.execFileImpl } : {}), apiKeySource: this._resolveApiKey().source });
    this._envCache = { at: Date.now(), value };
    return value;
  }

  async environment() { return this._environment(true); }
  installGuidance() { return installGuidance({ platform: this.platform, wsl: Boolean((this._envCache?.value ?? {}).os?.wsl) }); }

  async healthCheck() {
    const now = () => new Date().toISOString();
    if (!this.settings.enabled) {
      this.capabilities = [];
      return this._remember({ available: false, level: Availability.DISABLED, status: EngineStatus.DISABLED, reason: 'Hermes is disabled in settings', dependencies: { runtime: null, api: null, api_key: null, model: null, filesystem: null, terminal: null, browser: null, bridge: null }, capabilities: [], fallback: 'xoft-core', checkedAt: now() });
    }
    const env = await this._environment();
    const probe = await this.client.health();
    const deps = { runtime: env.hermes.installed || probe.ok, api: probe.ok, api_key: null, model: null, filesystem: null, terminal: null, browser: null, bridge: null, git: env.git.found };
    const notes = [];

    if (!probe.ok) {
      const starting = this.proc?.running;
      const reason = starting ? 'Hermes is starting…' : env.hermes.installed
        ? `Hermes is installed but its API server is not reachable at ${this.settings.baseUrl}. Start it with \`hermes gateway\` (with API_SERVER_ENABLED=true and an API_SERVER_KEY), or enable auto-start.`
        : `Hermes is not installed on this machine (or its API server is not running at ${this.settings.baseUrl}). See the install guidance.`;
      this.capabilities = [];
      if (this.status !== EngineStatus.STARTING || !starting) this.setStatus(starting ? EngineStatus.STARTING : EngineStatus.OFFLINE, reason);
      return this._remember({ available: false, level: Availability.OFFLINE, status: this.status, reason, dependencies: deps, capabilities: [], fallback: 'xoft-core', notes, checkedAt: now() });
    }

    // Reachable. Now check what only an authenticated call can tell us.
    let caps = null;
    try { caps = await this.client.capabilities(); deps.api_key = true; } catch (err) {
      if (err.code === ErrorCode.UNAUTHORIZED) deps.api_key = false;
      else if (err.code === ErrorCode.NOT_FOUND) { deps.api_key = this._resolveApiKey().key ? null : false; notes.push('this Hermes version has no /v1/capabilities endpoint; using documented defaults'); }
      else deps.api_key = null;
    }
    if (deps.api_key === false) {
      const keyState = this._resolveApiKey().source === 'none' ? 'HERMES_API_KEY is not set in Xoft' : 'Hermes rejected the configured API key';
      this.capabilities = [];
      const reason = `Hermes is running, but ${keyState}. Set HERMES_API_KEY to Hermes' API_SERVER_KEY.`;
      this.setStatus(EngineStatus.ERROR, reason);
      return this._remember({ available: false, level: Availability.ERROR, status: EngineStatus.ERROR, reason, dependencies: deps, capabilities: [], fallback: 'xoft-core', notes, checkedAt: now() });
    }
    this._capsFromServer = caps;

    let detail = null; try { detail = await this.client.detailedHealth(); } catch { /* optional */ }
    deps.model = readinessFlag(detail, /model/i);
    if (deps.model === null && env.hermes.homeExists) deps.model = env.hermes.configuredProviders.length > 0 ? true : null;

    let toolsets = null; try { toolsets = await this.client.toolsets(); } catch { notes.push('toolsets could not be listed; assuming Hermes defaults (terminal, files, web, memory)'); }
    const native = capabilitiesFromToolsets(toolsets) ?? { terminal: true, filesystem: true, browser: null, web_search: true, memory: true };
    deps.terminal = native.terminal; deps.filesystem = native.filesystem;

    const bridgeInfo = this.bridge?.status?.() ?? { enabled: false, connected: false };
    deps.bridge = this.settings.bridgeEnabled ? (bridgeInfo.connected ? true : null) : false;
    const bridgeBrowser = Boolean(bridgeInfo.connected && bridgeInfo.deviceOnline);
    deps.browser = native.browser === true || bridgeBrowser ? true : (native.browser === null ? null : false);

    const features = caps?.features ?? {};
    const cs = new Set([Capability.CHAT, Capability.PLANNING, Capability.AUTONOMOUS_TASKS, Capability.MULTI_STEP, Capability.LONG_RUNNING, Capability.STREAMING, Capability.CANCEL, Capability.PAUSE, Capability.RESUME]);
    if (caps ? features.run_approval !== false : true) cs.add(Capability.APPROVALS);
    if (native.terminal) { cs.add(Capability.TERMINAL); cs.add(Capability.CODING); if (env.git.found) cs.add(Capability.GIT); }
    if (native.filesystem) cs.add(Capability.FILESYSTEM);
    if (native.web_search) cs.add(Capability.WEB_SEARCH);
    if (native.memory) cs.add(Capability.MEMORY);
    if (deps.browser === true) cs.add(Capability.BROWSER);
    if (bridgeInfo.connected) { cs.add(Capability.TOOL_BRIDGE); if (bridgeInfo.deviceOnline) cs.add(Capability.PC_CONTROL); }
    this.capabilities = [...cs];

    const missing = [];
    if (deps.model === false) missing.push('no model provider is configured in Hermes (run `hermes setup`)');
    let level = Availability.READY; let available = true;
    if (deps.model === false) { level = Availability.PARTIAL; available = false; }
    // Terminal/file backends are core to what Hermes is for → PARTIAL if one is down. A missing OPTIONAL capability (browser) just isn't claimed.
    else if (deps.terminal === false || deps.filesystem === false) { level = Availability.PARTIAL; missing.push(`Hermes' ${[deps.terminal === false ? 'terminal' : null, deps.filesystem === false ? 'file' : null].filter(Boolean).join(' and ')} toolset is not enabled`); }
    const reason = missing.length ? missing.join('; ') : null;
    const status = available ? ((this._active ?? 0) > 0 ? EngineStatus.BUSY : EngineStatus.ONLINE) : EngineStatus.ERROR;
    this.setStatus(status, reason);
    return this._remember({ available, level, status, reason, dependencies: deps, capabilities: this.capabilities, fallback: available ? null : 'xoft-core', version: probe.body?.version ?? null, notes, checkedAt: now() });
  }

  _remember(h) { this._lastHealth = h; return h; }

  canServe(analysis, health) {
    if (!health?.available) return false;
    const need = analysis?.requiredCapabilities ?? [];
    if (!this.supportsAll(need)) return false;
    if (need.some((c) => FS_CAPS.includes(c)) && !analysis?.workingDirectory && !this.settings.workingDirectory) return false; // reported in routing reasons
    return true;
  }

  routingWeight(analysis) {
    let w = 0;
    if (analysis?.autonomous) w += 25;
    if (analysis?.longRunning) w += 15;
    if (analysis?.requiredCapabilities?.includes(Capability.CODING)) w += 15;
    if (analysis?.requiredCapabilities?.includes(Capability.TERMINAL)) w += 5;
    if (analysis?.simple) w -= 30;
    if ((analysis?.requiredCapabilities ?? []).every((c) => c === Capability.CHAT)) w -= 35;
    return w;
  }

  describe() {
    return { ...super.describe(), url: this.settings.baseUrl, managed: this.managed, pid: this.proc?.pid ?? null, enabled: this.settings.enabled, apiKey: { configured: Boolean(this.client.apiKey), source: this._resolveApiKey().source } };
  }

  // ---- managed process --------------------------------------------------------------------------------------------

  /** Starts `hermes gateway` as a Xoft-supervised child with the API server enabled. Reuses an already-running Hermes. */
  async start() {
    if (!this.settings.enabled) throw new EngineError(ErrorCode.DISABLED, 'Hermes is disabled in settings');
    if (this.proc?.running) return { started: false, reason: 'already running (managed by Xoft)', pid: this.proc.pid };
    const probe = await this.client.health();
    if (probe.ok) { this.managed = false; return { started: false, reason: 'a Hermes API server is already reachable — reusing it (Xoft did not start it)' }; }

    const env = await this._environment(true);
    if (!env.hermes.installed) throw new EngineError(ErrorCode.UNAVAILABLE, 'Hermes is not installed — nothing to start. See the install guidance.', { details: { guidance: this.installGuidance() } });
    let url; try { url = new URL(this.settings.baseUrl); } catch { throw new EngineError(ErrorCode.INVALID, 'Invalid Hermes API URL'); }
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) throw new EngineError(ErrorCode.POLICY_DENIED, `Xoft only starts Hermes bound to loopback; ${url.hostname} is not loopback. Start Hermes yourself for a remote/LAN setup.`);

    const resolved = this._resolveApiKey();
    const apiKey = resolved.key || this.secretStore.ensure('hermes-api-key');
    this.client.setApiKey(apiKey);
    const bridgeToken = this.settings.bridgeEnabled ? this.bridge?.token?.() ?? null : null;
    const managedEnv = buildManagedEnv({ base: this.env, extra: { ...this.settings.environment, ...(this.settings.hermesHome ? { HERMES_HOME: this.settings.hermesHome } : {}) }, apiKey, port: Number(url.port || 8642), host: '127.0.0.1', bridgeToken });
    this.proc = new HermesProcess({
      command: env.hermes.path, args: ['gateway'], cwd: os.homedir(), env: managedEnv, platform: this.platform,
      ...(this.spawnImpl ? { spawnImpl: this.spawnImpl } : {}),
      onExit: ({ code, signal, expected }) => {
        this._stopMemoryMonitor();
        if (expected) return;
        const reason = `Hermes process exited unexpectedly (code ${code ?? 'n/a'}${signal ? `, signal ${signal}` : ''})`;
        this.setStatus(EngineStatus.ERROR, reason);
        this.activityLog?.log({ type: 'engine_process_exited', detail: { engineId: this.id, code, signal } });
        this.eventBus?.emitEvent(EngineEvent.ENGINE_ERROR, { engineId: this.id, reason });
      },
    });
    this.setStatus(EngineStatus.STARTING, 'starting Hermes…');
    this.eventBus?.emitEvent(EngineEvent.ENGINE_STARTED, { engineId: this.id });
    try { await this.proc.start(); } catch (err) { this.setStatus(EngineStatus.ERROR, err.message); throw err; }
    this.managed = true;
    if (this.settings.lowPriority && this.proc.pid) { try { os.setPriority(this.proc.pid, 10); } catch { /* not permitted — fine */ } }

    const deadline = Date.now() + this.startTimeoutMs;
    for (;;) {
      if ((await this.client.health()).ok) break;
      if (!this.proc.running) { const tail = this.proc.logs(8).join(' | '); this.setStatus(EngineStatus.ERROR, 'Hermes exited during start-up'); throw new EngineError(ErrorCode.UNAVAILABLE, `Hermes exited during start-up. Last output: ${tail || '(none)'}`); }
      if (Date.now() > deadline) { await this.proc.stop(); this.setStatus(EngineStatus.ERROR, 'Hermes did not become ready in time'); throw new EngineError(ErrorCode.TIMEOUT, `Hermes did not answer /health within ${Math.round(this.startTimeoutMs / 1000)}s. Last output: ${this.proc.logs(8).join(' | ')}`, { retryable: true }); }
      await sleep(400);
    }
    this._startMemoryMonitor();
    this.activityLog?.log({ type: 'engine_started', detail: { engineId: this.id, pid: this.proc.pid, managed: true } });
    await this.healthCheck();
    return { started: true, pid: this.proc.pid };
  }

  async stop() {
    if (this.proc) await this.proc.stop();
    this._stopMemoryMonitor();
    const was = this.managed; this.managed = false;
    this.setStatus(EngineStatus.OFFLINE, 'stopped');
    if (was) this.activityLog?.log({ type: 'engine_stopped', detail: { engineId: this.id } });
    return { stopped: was };
  }

  _startMemoryMonitor() {
    this._stopMemoryMonitor();
    if (!this.settings.maxMemoryMb) return;
    this._memTimer = setInterval(async () => {
      const rss = await readRssMb(this.proc?.pid, { platform: this.platform });
      if (rss !== null && rss > this.settings.maxMemoryMb) {
        const reason = `Hermes used ${rss} MB, above the configured limit of ${this.settings.maxMemoryMb} MB — stopped (running tasks go into recovery)`;
        this.activityLog?.log({ type: 'engine_memory_limit', detail: { engineId: this.id, rssMb: rss, limitMb: this.settings.maxMemoryMb } });
        this.eventBus?.emitEvent(EngineEvent.ENGINE_ERROR, { engineId: this.id, reason });
        this._stopMemoryMonitor();
        await this.stop(); this.setStatus(EngineStatus.ERROR, reason);
      }
    }, 10000);
    this._memTimer.unref?.();
  }

  _stopMemoryMonitor() { if (this._memTimer) clearInterval(this._memTimer); this._memTimer = null; }

  logs(n = 100) { return this.proc?.logs(n) ?? []; }
  processStatus() { return { managed: this.managed, ...(this.proc?.status() ?? { running: false, pid: null, startedAt: null, exit: null }) }; }

  async ensureAvailable() {
    this._envCache = null;
    let h = await this.healthCheck();
    if (h.available) return true;
    if (this.managed || this.settings.autoStart) {
      try { if (this.proc?.running) await this.proc.stop(); await this.start(); h = await this.healthCheck(); } catch (err) { this.activityLog?.log({ type: 'engine_restart_failed', detail: { engineId: this.id, error: err.message } }); return false; }
    }
    return h.available;
  }

  async shutdown() { this._stopMemoryMonitor(); if (this.managed && this.proc) await this.proc.stop(); }

  // ---- bridge (Tool Gateway) info ---------------------------------------------------------------------------------

  bridgeInfo({ baseUrl = null } = {}) {
    const st = this.bridge?.status?.() ?? { enabled: false };
    const url = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/engine-bridge/mcp` : (st.url ?? null);
    const home = this.settings.hermesHome || (this._envCache?.value?.hermes?.home) || '';
    let configured = null;
    try { if (home) configured = new RegExp(`^\\s{2}${this.bridgeName}:`, 'm').test(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')); } catch { configured = home ? false : null; }
    return { ...st, url, serverName: this.bridgeName, tokenEnvVar: 'XOFT_TOOL_TOKEN', snippet: url ? bridgeConfigSnippet({ bridgeUrl: url, serverName: this.bridgeName }) : null, hermesConfigHasServer: configured, hermesHome: home || null, docs: HERMES_DOCS.mcp };
  }

  /** Writes the MCP server entry into Hermes' config.yaml when that is unambiguous (see applyBridgeConfig). */
  applyBridge({ baseUrl }) {
    const info = this.bridgeInfo({ baseUrl });
    if (!info.url) throw new EngineError(ErrorCode.UNAVAILABLE, 'The Xoft Tool Gateway is not enabled');
    const home = info.hermesHome;
    if (!home) throw new EngineError(ErrorCode.INVALID, 'Hermes home directory is unknown — set hermesHome in the settings');
    return { ...applyBridgeConfig({ hermesHome: home, snippet: info.snippet, serverName: this.bridgeName }), restartRequired: true };
  }

  // ---- execution --------------------------------------------------------------------------------------------------

  _prompt(task, { continuation = false } = {}) {
    const cwd = task.workspace?.cwd ?? task.workingDirectory;
    const granted = grantedPermissions(task.permissions);
    const denied = deniedPermissions(task.permissions);
    const bridgeUp = Boolean(this.bridge?.status?.().connected);
    const lines = [
      `You are working on a task delegated by Xoft (task id: ${task.id}).`,
      cwd ? `Working directory: ${cwd}. Keep every file change inside this directory and use absolute paths.` : 'No working directory was assigned; do not modify files on this machine.',
      `Autonomy level ${task.autonomy}: ${ENGINE_AUTONOMY_LABELS[task.autonomy] ?? ''}`,
      `Permissions granted by Xoft: ${granted.join(', ') || 'none'}.`,
      denied.length ? `NOT granted (do not attempt): ${denied.join(', ')}.` : null,
      'Xoft enforces these limits and stops the task if they are violated. Never read or modify credentials (.env files, SSH/cloud keys, browser profiles, tokens).',
      'For destructive actions (deleting files, force-pushing, dropping data) ask for approval instead of proceeding.',
      bridgeUp ? `Xoft's own tools (journaled file operations, browser, devices, memory, web search, …) are available through the "${this.bridgeName}" MCP server. When you call one of them, pass "task_id": "${task.id}" so Xoft applies this task's permissions.` : null,
      'When you finish: summarise what you changed, list the commands/tests you ran and their real results. Do not claim tests passed unless you ran them and saw them pass.',
    ].filter(Boolean);
    const input = continuation
      ? `Continue the task you were working on — it was interrupted. Inspect the current state of the work first and do not redo steps that are already done.\n\nOriginal goal:\n${task.goal}`
      : task.goal;
    return { input, instructions: lines.join('\n') };
  }

  _modelArgs() {
    const s = this.settings;
    return { ...(s.model ? { model: s.model } : {}), ...(s.provider ? { provider: s.provider } : {}) };
  }

  async execute(task, ctx = {}) { return this._start(task, ctx, { continuation: false }); }

  /** "Resume" = a fresh run inside the SAME Hermes session, so the agent keeps its context (Hermes has no native pause). */
  async resume(task, ctx = {}) { return this._start(task, ctx, { continuation: true }); }

  async _start(task, ctx, { continuation }) {
    const emit = ctx.onEvent ?? (() => {});
    const generation = (task.engineRef?.generation ?? 0) + 1;
    const sessionId = task.engineRef?.sessionId ?? `xoft-${task.id}`;
    const { input, instructions } = this._prompt(task, { continuation });
    emit({ type: EngineEvent.TASK_PROGRESS, step: 'start', note: continuation ? 'Resuming in the same Hermes session…' : 'Handing the task to Hermes…' });
    const created = await this.client.createRun({ input, instructions, sessionId, ...this._modelArgs() }, { idempotencyKey: `xoft:${task.id}:${generation}`, sessionKey: `xoft:${task.id}`, signal: ctx.signal });
    ctx.setEngineRef?.({ engine: 'hermes', runId: created.runId, sessionId, generation });
    emit({ type: EngineEvent.TASK_PROGRESS, step: 'running', note: `Hermes run ${created.runId} started${created.replayed ? ' (re-attached to an existing run)' : ''}` });
    return this._follow(task, created.runId, ctx);
  }

  /** Re-attach to a run that was in flight when Xoft (or the connection) went away. Never starts duplicate work while the run is alive. */
  async recover(task, ctx = {}) {
    const runId = task.engineRef?.runId;
    if (!runId) return this.execute(task, ctx);
    let run;
    try { run = await this.client.getRun(runId); } catch (err) {
      if (err.code === ErrorCode.NOT_FOUND) return this.resume(task, ctx);
      throw err;
    }
    const status = String(run.status ?? '').toLowerCase();
    ctx.onEvent?.({ type: EngineEvent.TASK_RECOVERY, runId, hermesStatus: status });
    if (status === 'completed') return { status: 'completed', output: run.output ?? '', usage: run.usage ?? null, runtime: run.runtime ?? null };
    if (status === 'failed') return { status: 'failed', error: run.error ?? 'Hermes run failed' };
    if (status === 'cancelled' || status === 'interrupted') return this.resume(task, ctx);
    return this._follow(task, runId, ctx);
  }

  async _follow(task, runId, ctx) {
    const emit = ctx.onEvent ?? (() => {});
    const state = { pending: [], buffer: '', lastEmit: 0, terminal: null };
    const onAbort = () => { if (ctx.abortReason?.() !== 'shutdown') this._requestStop(runId).catch(() => {}); };
    ctx.signal?.addEventListener?.('abort', onAbort, { once: true });
    let reconnects = 0;
    try {
      for (;;) {
        try {
          for await (const ev of this.client.events(runId, { signal: ctx.signal })) {
            for (const m of this._mapEvent(ev, state)) emit(m);
            if (state.terminal) break;
          }
        } catch (err) {
          if (ctx.signal?.aborted) return { status: 'cancelled', error: 'aborted' };
          if (!(err.retryable || err.code === ErrorCode.UNAVAILABLE) || reconnects >= 3) throw err;
          reconnects += 1;
          // Is the run still alive? If it finished while we were disconnected, take its final state.
          const run = await this.client.getRun(runId).catch(() => null);
          const st = String(run?.status ?? '').toLowerCase();
          if (['completed', 'failed', 'cancelled', 'interrupted'].includes(st)) state.terminal = { status: st, output: run.output, error: run.error, usage: run.usage, runtime: run.runtime };
          else { await sleep(1000 * reconnects, ctx.signal); continue; }
        }
        if (state.terminal) break;
        if (ctx.signal?.aborted) return { status: 'cancelled', error: 'aborted' };
        // The stream closed without a terminal event — ask Hermes what actually happened.
        const run = await this.client.getRun(runId);
        const st = String(run.status ?? '').toLowerCase();
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(st)) { state.terminal = { status: st, output: run.output, error: run.error, usage: run.usage, runtime: run.runtime }; break; }
        if (++reconnects > 6) throw new EngineError(ErrorCode.UNAVAILABLE, 'Hermes event stream keeps closing while the run is still active', { retryable: true });
        await sleep(1000, ctx.signal);
      }
    } finally {
      ctx.signal?.removeEventListener?.('abort', onAbort);
      // When Xoft aborted, don't report the run as ended until Hermes has actually been told to stop (a task must not look
      // finished while its agent is still running).
      if (ctx.signal?.aborted && ctx.abortReason?.() !== 'shutdown') await this._stops?.get(runId)?.catch(() => {});
    }

    this._flushMessage(state, emit, true);
    const t = state.terminal;
    if (t.status === 'completed') return { status: 'completed', output: String(t.output ?? state.buffer ?? ''), usage: t.usage ?? null, runtime: t.runtime ?? null };
    if (t.status === 'failed') return { status: 'failed', error: String(t.error ?? 'Hermes run failed'), output: String(state.buffer ?? '') };
    if (t.status === 'cancelled') return { status: 'cancelled', error: 'the Hermes run was cancelled' };
    // interrupted: the Hermes gateway shut down mid-run. Treat as an engine failure so Xoft's recovery restarts it in-session.
    throw new EngineError(ErrorCode.UNAVAILABLE, 'The Hermes run was interrupted (its gateway shut down)', { retryable: true });
  }

  _flushMessage(state, emit, force = false) {
    const now = Date.now();
    if (!state.buffer || (!force && now - state.lastEmit < 2000)) return;
    state.lastEmit = now;
    emit({ type: EngineEvent.MESSAGE, text: state.buffer.slice(-600), kind: 'assistant' });
  }

  /** Maps one Hermes SSE frame to zero or more normalised engine events. Unknown frames are ignored, never guessed at. */
  _mapEvent(ev, state) {
    const d = ev.data && typeof ev.data === 'object' ? ev.data : { text: ev.data };
    const name = String(ev.event ?? d.event ?? d.type ?? '').toLowerCase();
    const tool = d.tool ?? d.name ?? d.tool_name ?? null;
    const out = [];
    const emit = (e) => out.push(e);
    switch (name) {
      case 'tool.started': case 'tool_started': case 'hermes.tool.progress': {
        const preview = d.preview ?? d.arguments ?? d.args ?? d.input ?? null;
        const callId = d.call_id ?? d.id ?? null;
        state.pending.push({ tool, preview, callId });
        emit({ type: EngineEvent.TOOL_STARTED, tool, preview: typeof preview === 'string' ? redactString(preview).slice(0, 1500) : preview, callId, via: isBridgedTool(tool, this.bridgeName) ? 'bridge' : 'native' });
        break;
      }
      case 'tool.completed': case 'tool_completed': case 'tool.failed': {
        const i = state.pending.findIndex((p) => (d.call_id ?? d.id) ? p.callId === (d.call_id ?? d.id) : p.tool === tool);
        const started = i >= 0 ? state.pending.splice(i, 1)[0] : null;
        const failed = name === 'tool.failed' || Boolean(d.error);
        const { command } = parseToolPreview(started?.preview);
        emit({ type: failed ? EngineEvent.TOOL_FAILED : EngineEvent.TOOL_COMPLETED, tool: tool ?? started?.tool, input: started?.preview ?? null, command, duration: d.duration ?? null, error: failed ? (typeof d.error === 'string' ? d.error : (d.preview ?? 'tool reported an error')).toString().slice(0, 500) : null, resultPreview: typeof d.preview === 'string' ? redactString(d.preview).slice(0, 500) : null, via: isBridgedTool(tool, this.bridgeName) ? 'bridge' : 'native' });
        break;
      }
      case 'message.delta': case 'assistant.delta': {
        state.buffer += String(d.text ?? d.delta ?? d.content ?? '');
        if (state.buffer.length > 20000) state.buffer = state.buffer.slice(-20000);
        this._flushMessage(state, emit);
        break;
      }
      case 'message.interim': case 'assistant.commentary': emit({ type: EngineEvent.MESSAGE, text: String(d.text ?? ''), kind: 'commentary' }); break;
      case 'approval.request': case 'approval.requested': {
        const id = d.approval_id ?? d.id ?? null;
        emit({ type: EngineEvent.APPROVAL_REQUESTED, approvalKey: id ?? d.call_id ?? `${tool ?? 'action'}:${Date.now()}`, engineApprovalId: id, tool, command: d.command ?? parseToolPreview(d.preview ?? d.arguments).command ?? null, description: d.description ?? d.message ?? d.reason ?? null, input: d.preview ?? d.arguments ?? null });
        break;
      }
      case 'subagent.start': case 'subagent.complete': emit({ type: EngineEvent.MESSAGE, kind: 'subagent', text: `${name === 'subagent.start' ? 'Delegated to a sub-agent' : 'Sub-agent finished'}${d.summary ? `: ${String(d.summary).slice(0, 200)}` : ''}` }); break;
      case 'run.completed': state.terminal = { status: 'completed', output: d.output ?? d.text, usage: d.usage, runtime: d.runtime }; break;
      case 'run.failed': state.terminal = { status: 'failed', error: d.error?.message ?? d.error ?? d.message }; break;
      case 'run.cancelled': state.terminal = { status: 'cancelled' }; break;
      case 'run.interrupted': state.terminal = { status: 'interrupted', error: d.error }; break;
      default: break; // reasoning.*, run.started, keepalives, future events
    }
    return out;
  }

  // ---- control ----------------------------------------------------------------------------------------------------

  /** Idempotent: the abort handler, cancel() and pause() can all ask for the same stop; Hermes is told once and every caller awaits that one request. */
  _requestStop(runId) {
    this._stops ??= new Map();
    if (this._stops.has(runId)) return this._stops.get(runId);
    const p = this.client.stopRun(runId).catch((err) => { if (err.code !== ErrorCode.NOT_FOUND) { this._stops.delete(runId); throw err; } });
    this._stops.set(runId, p);
    return p;
  }

  async _stop(task) {
    const runId = task?.engineRef?.runId;
    if (runId) await this._requestStop(runId);
  }

  async cancel(task) { return this._stop(task); }
  /** Pause = interrupt the run at Hermes' next safe point; resume() continues in the same session. */
  async pause(task) { return this._stop(task); }

  async resolveApproval(task, key, decision, { approvalId = null } = {}) {
    const runId = task?.engineRef?.runId;
    if (!runId) throw new EngineError(ErrorCode.NOT_FOUND, 'No Hermes run to deliver the approval to');
    return this.client.approveRun(runId, decision, approvalId);
  }

  async shutdownRunsDetached() { /* runs keep going on Hermes; Xoft re-attaches via recover() on its next start */ }
}
