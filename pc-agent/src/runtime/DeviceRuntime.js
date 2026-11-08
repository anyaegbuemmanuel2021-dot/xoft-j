'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { isSensitivePath } = require('./sensitive');
const { HaltGuard } = require('./HaltGuard');
const { ActionPolicy } = require('./ActionPolicy');
const { RuntimeGuard } = require('./RuntimeGuard');
const { OperationJournal } = require('./OperationJournal');
const { RecoveryStore } = require('./RecoveryStore');
const { WorkspaceRegistry } = require('./WorkspaceRegistry');
const { FileSystemService } = require('../services/FileSystemService');
const { TerminalService } = require('../services/TerminalService');
const { BrowserController } = require('../browser/BrowserController');

const EXECUTABLE_EXT = /\.(exe|bat|cmd|com|scr|msi|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|jar|reg|sh|bash|command|app|dll|cpl|pif)$/i;
const bad = (error) => ({ success: false, error });
const need = (p, ...keys) => { for (const k of keys) if (p?.[k] === undefined || p?.[k] === null) return `parameter '${k}' is required`; return null; };

/**
 * DeviceRuntime — the single bridge between XOFT's brain and this computer.
 * Owns: HaltGuard (kill switch), RuntimeGuard/ActionPolicy, OperationJournal, RecoveryStore,
 * WorkspaceRegistry, and the Browser / File / Terminal services. dispatch() is the ONLY entry
 * point index.js uses for the capabilities below; unknown actions are refused, never faked.
 *
 * Workspaces can only be added/removed by a human on this machine (CLI / config), never via a
 * remote command — otherwise the AI could widen its own sandbox.
 */
class DeviceRuntime {
  constructor({ config, logger = console, spawnImpl = spawn } = {}) {
    this.config = config; this.logger = logger; this.spawnImpl = spawnImpl;
    const stateDir = config.stateDir; fs.mkdirSync(stateDir, { recursive: true });
    this.stateDir = stateDir;
    this.halt = new HaltGuard({ stateDir });
    this.guard = new RuntimeGuard({ halt: this.halt, policy: new ActionPolicy(config.policy ?? {}), stateDir, maxMutationsPerMinute: config.maxMutationsPerMinute ?? 120 });
    this.journal = new OperationJournal({ stateDir });
    this.recovery = new RecoveryStore({ stateDir });
    this.workspaces = new WorkspaceRegistry({ stateDir, seed: config.workspaces ?? [] });
    this.files = new FileSystemService({ workspaces: this.workspaces, journal: this.journal, recovery: this.recovery, guard: this.guard, extraSensitive: [config.configPath, config.pairingPath].filter(Boolean) });
    this.terminal = new TerminalService({ workspaces: this.workspaces, journal: this.journal, guard: this.guard });
    const b = config.browser ?? {};
    this.browser = new BrowserController({ port: b.debugPort ?? 9222, autoLaunch: Boolean(b.autoLaunch), profileDir: b.profileDir ?? path.join(stateDir, 'browser-profile'), guard: this.guard, policy: { allowedHosts: b.allowedHosts ?? [], blockedHosts: b.blockedHosts ?? [] }, logger });
    this._recovery = { attempts: 0, lastAt: 0 };
    this.halt.start();
    this.halt.onHalt(() => { this.browser.close(); });
  }

  /** Capabilities this runtime genuinely implements (reported to core). */
  static CAPABILITIES = ['browser', 'files', 'terminal', 'workspace', 'operations', 'runtime'];

  _ctx(command) { const c = command?.parameters?._context ?? {}; return { missionId: c.missionId ?? null, agent: c.agent ?? 'xoft', reason: c.reason ?? null }; }

  async dispatch(command) {
    const { capability, action } = command; const p = command.parameters ?? {}; const ctx = this._ctx(command);
    const missing = (...k) => need(p, ...k);
    let m;
    switch (capability) {
      case 'browser': {
        const b = this.browser;
        switch (action) {
          case 'list_tabs': return b.listTabs();
          case 'attach_tab': return (m = missing('tabId')) ? bad(m) : b.attachTab(p.tabId);
          case 'new_tab': return b.newTab(p.url);
          case 'navigate': return (m = missing('url')) ? bad(m) : b.navigate(p.url);
          case 'back': return b.back(); case 'forward': return b.forward(); case 'reload': return b.reload();
          case 'get_page': return b.getPage();
          case 'get_dom': return b.getDom({ limit: p.limit });
          case 'query_selector': return (m = missing('locator')) ? bad(m) : b.querySelector(p.locator, { limit: p.limit });
          case 'click': return (m = missing('locator')) ? bad(m) : b.click(p.locator, { force: false }); // force is never remotely settable
          case 'type': return (m = missing('locator', 'text')) ? bad(m) : b.type(p.locator, p.text);
          case 'fill': return (m = missing('locator', 'text')) ? bad(m) : b.fill(p.locator, p.text);
          case 'press': return (m = missing('key')) ? bad(m) : b.press(p.key);
          case 'scroll': return b.scroll({ x: p.x, y: p.y, locator: p.locator ?? null });
          case 'wait_for': return (m = missing('locator')) ? bad(m) : b.waitFor(p.locator, { state: p.state, timeoutMs: Math.min(Number(p.timeoutMs) || 10000, 30000) });
          case 'wait_for_navigation': return b.waitForNavigation({ timeoutMs: Math.min(Number(p.timeoutMs) || 15000, 30000) });
          case 'get_text': return b.getText(p.locator ?? null, { maxChars: p.maxChars });
          case 'get_attribute': return (m = missing('locator', 'name')) ? bad(m) : b.getAttribute(p.locator, p.name);
          case 'screenshot': return b.screenshot({ fullPage: Boolean(p.fullPage) });
          case 'element_screenshot': return (m = missing('locator')) ? bad(m) : b.elementScreenshot(p.locator);
          case 'open_url': return null; // legacy OS-level open in the default browser — handled by executors/browser.js, unchanged
          default: return bad(`Agent does not implement browser.${action}.`);
        }
      }
      case 'files': {
        const f = this.files;
        switch (action) {
          case 'search': return (m = missing('query')) ? bad(m) : f.search(p);
          case 'locate': return (m = missing('query')) ? bad(m) : f.locate(p);
          case 'inspect': return (m = missing('path')) ? bad(m) : f.inspect(p);
          case 'read': return (m = missing('path')) ? bad(m) : f.read(p);
          case 'compare': return (m = missing('a', 'b')) ? bad(m) : f.compare(p);
          case 'list': return (m = missing('path')) ? bad(m) : f.list(p);
          case 'write': return (m = missing('path', 'content')) ? bad(m) : f.write(p, ctx);
          case 'create': return (m = missing('path', 'content')) ? bad(m) : f.create(p, ctx);
          case 'edit': return (m = missing('path')) ? bad(m) : f.edit(p, ctx);
          case 'delete': return (m = missing('path')) ? bad(m) : f.delete(p, ctx);
          case 'move': return (m = missing('from', 'to')) ? bad(m) : f.move(p, ctx);
          case 'copy': return (m = missing('from', 'to')) ? bad(m) : f.copy(p, ctx);
          case 'rename': return (m = missing('path', 'newName')) ? bad(m) : f.rename(p, ctx);
          case 'archive': return (m = missing('paths', 'dest')) ? bad(m) : f.archive(p, ctx);
          case 'extract': return (m = missing('archive', 'destDir')) ? bad(m) : f.extract(p, ctx);
          case 'history': return (m = missing('path')) ? bad(m) : f.fileHistory(p);
          case 'restore': return (m = missing('operationId')) ? bad(m) : f.restore({ operationId: p.operationId, force: false, reason: p.reason }, ctx); // force is never remotely settable
          case 'undo_last': return f.undoLast({ force: false }, ctx);
          case 'restore_version': return (m = missing('path', 'asOf')) ? bad(m) : f.restoreVersion({ path: p.path, asOf: p.asOf, force: false }, ctx);
          case 'record_tests': return (m = missing('operationId', 'tests')) ? bad(m) : { success: true, data: { operation: f.recordTests(Number(p.operationId), p.tests) } };
          case 'watch_start': return f.startWatch(p); case 'watch_poll': return f.pollWatch(p); case 'watch_stop': return f.stopWatch(p);
          default: return null; // fall through to legacy files.* actions handled by index.js
        }
      }
      case 'terminal':
        if (action !== 'run') return bad(`Agent does not implement terminal.${action}.`);
        return (m = missing('command')) ? bad(m) : this.terminal.run({ command: p.command, args: p.args ?? [], cwd: p.cwd ?? '.', timeoutMs: p.timeoutMs, reason: p.reason }, ctx);
      case 'workspace':
        try {
          switch (action) {
            case 'list': return { success: true, data: { workspaces: this.workspaces.list() } };
            case 'set_active': return (m = missing('name')) ? bad(m) : { success: true, data: { active: this.workspaces.setActive(p.name) } };
            case 'inspect_project': return { success: true, data: this.workspaces.inspectProject(p.name) };
            case 'locate_project': return (m = missing('query')) ? bad(m) : { success: true, data: { projects: this.workspaces.locateProject(p.query) } };
            default: return bad(`Agent does not implement workspace.${action}. (Adding or removing workspaces is only possible locally on the device.)`);
          }
        } catch (err) { return bad(err.message); }
      case 'applications':
        if (action !== 'open_file') return null; // list/open_application/close_application stay with the original executor
        return (m = missing('path')) ? bad(m) : this.openFile(p);
      case 'operations':
        switch (action) {
          case 'list': return { success: true, data: { operations: this.journal.list({ limit: Math.min(Number(p.limit) || 50, 200) }).map(({ previousState, newState, ...o }) => ({ ...o, previousState: previousState ? { sha256: previousState.sha256 ?? null } : null, newState })) } };
          case 'get': { const o = this.journal.get(p.operationId); return o ? { success: true, data: { operation: o } } : bad(`No operation #${p.operationId}`); }
          case 'interrupted': return { success: true, data: { operations: this.journal.interrupted() } };
          default: return bad(`Agent does not implement operations.${action}.`);
        }
      case 'runtime':
        switch (action) {
          case 'status': return { success: true, data: this.status() };
          case 'halt': this.halt.halt(`remote halt: ${p.reason ?? 'requested by xoft-core'}`); return { success: true, data: { halted: true } }; // stopping is always allowed; resuming never is
          case 'recover_browser': return this.recoverBrowser({ manual: true });
          default: return bad(`Agent does not implement runtime.${action}.`);
        }
      default: return null;
    }
  }

  /** Opens a workspace file in the OS default handler, or in an appAllowlist app. Never executes programs/scripts; no shell involved. */
  async openFile({ path: input, application = null }) {
    try { this.guard.assertAllowed('app.launch'); } catch (err) { return { success: false, blocked: true, error: err.message }; }
    let abs; try { ({ abs } = this.workspaces.resolve(input)); } catch (err) { return bad(err.message); }
    if (isSensitivePath(abs, [this.config.configPath, this.config.pairingPath].filter(Boolean))) return { success: false, sensitive: true, error: `Refusing to open protected file '${abs}'.` };
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return bad(`'${abs}' is not an existing file`);
    if (EXECUTABLE_EXT.test(abs)) return bad(`Refusing to open '${path.basename(abs)}': executable/script file types are never launched by open_file.`);
    let exe; let args;
    if (application) {
      const entry = (this.config.appAllowlist ?? {})[String(application).toLowerCase()];
      if (!entry) return bad(`'${application}' is not in appAllowlist (config.json).`);
      exe = entry.path; args = [abs];
    } else if (process.platform === 'win32') { exe = 'explorer.exe'; args = [abs]; }
    else { exe = process.platform === 'darwin' ? 'open' : 'xdg-open'; args = [abs]; }
    const journalId = this.journal.begin({ action: 'OPEN_FILE', target: abs, reason: application ? `open in ${application}` : 'default handler', agent: 'xoft' });
    try {
      await new Promise((resolve, reject) => { const c = this.spawnImpl(exe, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false }); c.once('error', reject); c.once('spawn', resolve); c.unref?.(); });
      this.journal.complete(journalId, { result: { success: true }, rollback: { available: false } });
      return { success: true, data: { opened: abs, with: application ?? 'default handler', operationId: journalId }, verification: { verified: false, evidence: { note: 'launcher process started; that a window actually appeared is NOT confirmed' } } };
    } catch (err) {
      this.journal.complete(journalId, { result: { success: false, error: err.message }, rollback: { available: false } });
      return bad(`Could not start '${exe}': ${err.message}`);
    }
  }

  status() {
    return { halted: this.halt.isHalted(), haltReason: this.halt.reason(), activeWorkspace: this.workspaces.active()?.name ?? null, workspaces: this.workspaces.list().map((w) => ({ name: w.name, active: w.active })), browser: this.browser.status(), interruptedOperations: this.journal.interrupted().length, policy: this.guard.policy.levels };
  }

  /** Cheap health snapshot for the periodic state report (feeds core's Watchdog). Never throws. */
  async health() {
    const browser = await this.browser.health();
    return { halted: this.halt.isHalted(), browser: { ok: browser.ok, attached: browser.attached, error: browser.error ?? null }, interruptedOperations: this.journal.interrupted().length, activeWorkspace: this.workspaces.active()?.name ?? null };
  }

  /** Bounded self-healing: at most 3 attempts per 10 minutes, then stop and let the Watchdog report it. */
  async recoverBrowser({ manual = false } = {}) {
    const now = Date.now();
    if (now - this._recovery.lastAt > 10 * 60 * 1000) this._recovery.attempts = 0;
    if (!manual && this._recovery.attempts >= 3) return bad('Browser recovery limit reached (3 attempts / 10 min) — needs human attention');
    this._recovery.attempts++; this._recovery.lastAt = now;
    this.browser.close();
    const h = await this.browser.health();
    if (!h.ok) return bad(`Browser debugging endpoint still unreachable: ${h.error}`);
    const r = await this.browser.listTabs();
    return r.success ? { success: true, data: { recovered: true, attempt: this._recovery.attempts } } : r;
  }

  stop() { this.halt.stop(); this.browser.close(); }
}

module.exports = { DeviceRuntime };
