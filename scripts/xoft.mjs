#!/usr/bin/env node
// xoft — command-line interface for XOFT's execution engines (Hermes, Xoft Core, …) and engine tasks.
// A thin client over the HTTP API: it adds no behaviour of its own, so permissions, approvals and the emergency stop apply
// exactly as in the dashboard. (Xoft had no CLI before; this is the first one — scripts/*.mjs stay separate local tools.)
//
//   xoft engines                              list engines, status and capabilities
//   xoft engine status <id>                   one engine in detail (health, dependencies, fallback)
//   xoft engine start|stop hermes             start / stop a Hermes that Xoft manages
//   xoft engine detect                        what is installed on this machine
//   xoft engine install hermes [--run --yes]  show (or, only with --run --yes, execute) the official installer
//   xoft engine bridge [--apply] [--show-token]   Tool Gateway info / write Hermes' MCP config / print the bearer token
//   xoft engine settings [key=value …]        show or change Hermes settings
//   xoft route "<goal>" [--dir <path>]        preview which engine would run a goal
//   xoft task run [--engine hermes] [--dir <path>] [--profile developer] [--autonomy 3] [--wait] "<goal>"
//   xoft task list | status <id> | stop <id> | pause <id> | resume <id> | logs <id> [--follow] | report <id>
//   xoft task approve|reject <taskId> <approvalId>
//   xoft task rollback <id>
//
// Environment: XOFT_URL (default http://127.0.0.1:3000), XOFT_API_KEY, XOFT_DATA_DIR (for --show-token; default ./data)

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function parseArgs(argv) {
  const positional = []; const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (['wait', 'follow', 'yes', 'run', 'apply', 'show-token', 'json', 'help', 'refresh'].includes(a.slice(2))) flags[a.slice(2)] = true;
      else { flags[a.slice(2)] = argv[i + 1]; i += 1; }
    } else positional.push(a);
  }
  return { positional, flags };
}

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, Math.max(n, String(s ?? '').length));
const short = (id) => String(id ?? '').slice(0, 8);

export const HELP = `xoft — engines & engine tasks

  xoft engines
  xoft engine status <id>
  xoft engine start|stop hermes
  xoft engine detect
  xoft engine install hermes [--run --yes]
  xoft engine bridge [--apply] [--show-token]
  xoft engine settings [key=value …]
  xoft route "<goal>" [--dir <path>]
  xoft task run [--engine hermes] [--dir <path>] [--profile standard|developer|full|observe] [--autonomy 0-5] [--wait] "<goal>"
  xoft task list | status <id> | stop <id> | pause <id> | resume <id> | logs <id> [--follow] | report <id> | rollback <id>
  xoft task approve|reject <taskId> <approvalId>

Environment: XOFT_URL (default http://127.0.0.1:3000), XOFT_API_KEY, XOFT_DATA_DIR`;

/**
 * @param {string[]} argv
 * @param {{fetchImpl?:typeof fetch, out?:(s:string)=>void, err?:(s:string)=>void, env?:object, spawnImpl?:Function, sleep?:(ms:number)=>Promise<void>, platform?:string}} [io]
 * @returns {Promise<number>} process exit code
 */
export async function run(argv, io = {}) {
  const { fetchImpl = globalThis.fetch, out = (s) => console.log(s), err = (s) => console.error(s), env = process.env, spawnImpl = spawn, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), platform = process.platform } = io;
  const { positional, flags } = parseArgs(argv);
  const base = String(flags.url ?? env.XOFT_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const apiKey = flags.key ?? env.XOFT_API_KEY ?? '';
  const json = Boolean(flags.json);
  const show = (o) => out(json ? JSON.stringify(o, null, 2) : null);

  async function call(method, route, body) {
    let res;
    try {
      res = await fetchImpl(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'X-API-Key': apiKey } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (e) { throw new Error(`Cannot reach Xoft at ${base} (${e.cause?.code ?? e.message}). Is it running? Set XOFT_URL if it is elsewhere.`); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const hint = res.status === 401 ? ' (set XOFT_API_KEY)' : res.status === 403 ? ' (an admin API key is required for this)' : '';
      throw new Error(`${data.error ?? `HTTP ${res.status}`}${hint}`);
    }
    return data;
  }
  const emit = (data, human) => { if (json) out(JSON.stringify(data, null, 2)); else human(); };

  const [cmd, sub, ...rest] = positional;
  try {
    if (!cmd || flags.help || cmd === 'help') { out(HELP); return cmd || flags.help ? 0 : 1; }

    // ---- engines ----
    if (cmd === 'engines') {
      const d = await call('GET', `/api/engines${flags.refresh ? '?refresh=true' : ''}`);
      emit(d, () => {
        out(`${pad('ENGINE', 12)} ${pad('STATUS', 10)} ${pad('LEVEL', 9)} CAPABILITIES / REASON`);
        for (const e of d.engines) out(`${pad(e.id, 12)} ${pad(e.status, 10)} ${pad(e.health?.level ?? '-', 9)} ${e.health?.available ? `${(e.capabilities ?? []).length} capabilities` : (e.health?.reason ?? e.statusReason ?? '')}`);
        out(`\nQueue: ${d.queue.running.length} running, ${d.queue.pending.length} waiting (limit ${d.queue.maxConcurrent}).`);
      });
      return 0;
    }

    if (cmd === 'engine') {
      if (sub === 'status') {
        const id = rest[0]; if (!id) throw new Error('usage: xoft engine status <id>');
        const e = await call('GET', `/api/engines/${encodeURIComponent(id)}?refresh=true`);
        emit(e, () => {
          out(`${e.name} (${e.id}) — ${e.status}${e.managed ? ' · started by Xoft' : ''}`);
          out(`Availability: ${e.health?.level ?? 'unknown'}${e.health?.reason ? ` — ${e.health.reason}` : ''}`);
          if (e.health && !e.health.available && e.health.fallback) out(`Fallback: ${e.health.fallback}`);
          const deps = Object.entries(e.health?.dependencies ?? {}); if (deps.length) out(`Dependencies: ${deps.map(([k, v]) => `${k}=${v === true ? 'yes' : v === false ? 'NO' : '?'}`).join('  ')}`);
          out(`Capabilities: ${(e.capabilities ?? []).join(', ') || '(none available)'}`);
          for (const n of e.health?.notes ?? []) out(`Note: ${n}`);
        });
        return 0;
      }
      if (sub === 'start' || sub === 'stop') {
        if (rest[0] !== 'hermes') throw new Error(`xoft engine ${sub} supports: hermes`);
        const r = await call('POST', `/api/engines/hermes/${sub}`);
        emit(r, () => out(sub === 'start' ? (r.started ? `Hermes started (pid ${r.pid}).` : r.reason) : (r.stopped ? 'Hermes stopped.' : 'Nothing to stop — Xoft did not start Hermes.')));
        return 0;
      }
      if (sub === 'detect') {
        const r = await call('GET', '/api/engines/hermes/environment');
        emit(r, () => {
          out(`OS: ${r.os.platform} ${r.os.arch}${r.os.wsl ? ' (WSL2)' : ''}   Node: ${r.node.version}   Python: ${r.python.found ? r.python.version : 'not found'}   Git: ${r.git.found ? r.git.version : 'not found'}`);
          out(`Package managers: ${Object.entries(r.packageManagers).filter(([, v]) => v.found).map(([k]) => k).join(', ') || 'none'}`);
          out(r.hermes.installed ? `Hermes: ${r.hermes.version ?? 'installed'} at ${r.hermes.path}` : 'Hermes: NOT INSTALLED  (run: xoft engine install hermes)');
          out(`Hermes home: ${r.hermes.home}  config.yaml: ${r.hermes.hasConfig ? 'yes' : 'no'}  providers: ${r.hermes.configuredProviders.join(', ') || 'none found'}`);
          out(`Xoft → Hermes API key: ${r.api.keyConfigured ? `set (${r.api.keySource})` : 'not set (HERMES_API_KEY)'}`);
        });
        return 0;
      }
      if (sub === 'install') {
        if (rest[0] !== 'hermes') throw new Error('usage: xoft engine install hermes [--run --yes]');
        const win = platform === 'win32';
        const g = { title: win ? 'Official PowerShell installer (native Windows)' : 'Official install script (Linux, macOS, WSL2)', cmd: win ? 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)' : 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash' };
        out(`${g.title}:\n  ${g.cmd}\n\nThen:\n  hermes setup\n  hermes doctor\n  (add API_SERVER_ENABLED=true and API_SERVER_KEY=<secret> to Hermes' .env; set HERMES_API_KEY to the same value for Xoft)\n  xoft engine start hermes      # or run \`hermes gateway\` yourself\n\nDocs: https://hermes-agent.nousresearch.com/docs`);
        if (flags.run) {
          if (!flags.yes) { err('\nRefusing to run a remote install script without --yes. Review the command above, then re-run with: --run --yes'); return 2; }
          out('\nRunning the installer…');
          const child = spawnImpl(win ? 'powershell' : 'bash', win ? ['-NoProfile', '-Command', g.cmd] : ['-c', g.cmd], { stdio: 'inherit' });
          return await new Promise((resolve) => { child.on('exit', (code) => resolve(code ?? 1)); child.on('error', (e) => { err(e.message); resolve(1); }); });
        }
        return 0;
      }
      if (sub === 'bridge') {
        if (flags.apply) { const r = await call('POST', '/api/engines/hermes/bridge/apply'); emit(r, () => out(r.applied ? `Added the Xoft MCP server to ${r.file} (backup: ${r.backup ?? 'none needed'}). Restart Hermes to load it.` : `Not changed: ${r.reason}`)); return 0; }
        const r = await call('GET', '/api/engines/hermes/bridge');
        emit(r, () => {
          out(`Tool Gateway: ${r.enabled ? 'enabled' : 'DISABLED'} · ${r.connected ? `Hermes connected (last seen ${r.lastSeenAt})` : 'no client has connected yet'} · ${r.tools} tools`);
          out(`Endpoint: ${r.url}`);
          out(`Hermes config.yaml ${r.hermesConfigHasServer === true ? 'already has' : r.hermesConfigHasServer === false ? 'does NOT have' : 'could not be checked for'} the "${r.serverName}" server (${r.hermesHome ?? 'unknown home'})`);
          out(`\nAdd to ${r.hermesHome ?? '~/.hermes'}/config.yaml (or run: xoft engine bridge --apply):\n\n${r.snippet}\n\nand export ${r.tokenEnvVar} in Hermes' environment (xoft engine bridge --show-token). A Xoft-managed Hermes gets it automatically.`);
        });
        if (flags['show-token']) {
          const file = path.join(env.XOFT_DATA_DIR ?? env.MEMORY_DATA_DIR ?? './data', 'engines', 'engine-secrets.json');
          let token = null; try { token = JSON.parse(fs.readFileSync(file, 'utf8'))['xoft-tool-token']?.value; } catch { /* not created yet */ }
          err(token ? `\n${r.tokenEnvVar}=${token}\n(keep this secret; anyone who has it can call your Xoft tools through the gateway)` : `\nNo token yet (it is created the first time the gateway is used) — looked in ${file}`);
        }
        return 0;
      }
      if (sub === 'settings') {
        const pairs = rest.filter((x) => x.includes('='));
        if (!pairs.length) { const r = await call('GET', '/api/engines/hermes/settings'); emit(r, () => { for (const [k, v] of Object.entries(r.settings)) if (k !== 'permissionProfileResolved') out(`${pad(k, 22)} ${typeof v === 'object' ? JSON.stringify(v) : v}`); out(`\nAPI key: ${r.apiKey.configured ? `set (${r.apiKey.source})` : 'not set'}`); }); return 0; }
        const body = {};
        for (const p of pairs) {
          const i = p.indexOf('='); const k = p.slice(0, i); let v = p.slice(i + 1);
          if (v === 'true') v = true; else if (v === 'false') v = false; else if (/^-?\d+$/.test(v)) v = Number(v); else if (k === 'allowedRoots') v = v.split(',').filter(Boolean);
          body[k] = v;
        }
        const r = await call('PUT', '/api/engines/hermes/settings', body);
        emit(r, () => out(`Saved: ${Object.keys(body).join(', ')}`));
        return 0;
      }
      throw new Error('usage: xoft engine status|start|stop|detect|install|bridge|settings');
    }

    if (cmd === 'route') {
      const goal = [sub, ...rest].filter(Boolean).join(' '); if (!goal) throw new Error('usage: xoft route "<goal>" [--dir <path>]');
      const r = await call('POST', '/api/engines/route', { goal, workingDirectory: flags.dir, engine: flags.engine });
      emit(r, () => {
        out(r.engine ? `→ ${r.engine}${r.chain.length > 1 ? `   (fallback chain: ${r.chain.join(' → ')})` : ''}` : '→ no engine can run this');
        out(r.reason ?? ''); out(`Needs: ${r.analysis.requiredCapabilities.join(', ')}${r.analysis.autonomous ? ' · autonomous' : ''}`);
        for (const c of r.candidates) out(`  ${c.serveable ? '✓' : '✗'} ${pad(c.engineId, 12)} ${c.reasons.join('; ')}`);
      });
      return r.engine ? 0 : 3;
    }

    // ---- tasks ----
    if (cmd === 'task') {
      const line = (t) => `${short(t.id)}  ${pad(t.state, 12)} ${pad(t.engine, 10)} ${String(t.goal ?? '').replace(/\s+/g, ' ').slice(0, 70)}`;
      const needId = (what) => { if (!rest[0]) throw new Error(`usage: xoft task ${what} <id>`); return rest[0]; };
      const fullId = async (idOrPrefix) => {
        if (idOrPrefix.length >= 32) return idOrPrefix;
        const { tasks } = await call('GET', '/api/engine-tasks?limit=500');
        const m = tasks.filter((t) => t.id.startsWith(idOrPrefix));
        if (m.length !== 1) throw new Error(m.length ? `'${idOrPrefix}' matches ${m.length} tasks; use more characters` : `no task starts with '${idOrPrefix}'`);
        return m[0].id;
      };

      if (sub === 'run') {
        const goal = rest.filter(Boolean).join(' ').trim(); if (!goal) throw new Error('usage: xoft task run [--engine hermes] [--dir <path>] "<goal>"');
        const body = { goal, ...(flags.engine ? { engine: flags.engine } : {}), ...(flags.dir ? { workingDirectory: path.resolve(flags.dir) } : {}), ...(flags.profile ? { permissions: flags.profile } : {}), ...(flags.autonomy !== undefined ? { autonomy: Number(flags.autonomy) } : {}), ...(flags.workspace ? { workspaceMode: flags.workspace } : {}) };
        const { task } = await call('POST', '/api/engine-tasks', body);
        emit({ task }, () => { out(`Task ${task.id}\nEngine: ${task.engine}${task.routing.fallbackFrom ? ` (fell back from ${task.routing.fallbackFrom})` : ''} — ${task.routing.reason}\nAutonomy: ${task.autonomy}   Permissions: ${task.grantedPermissions.join(', ') || 'none'}`); });
        if (!flags.wait) return 0;
        return await follow(task.id, true);
      }
      if (sub === 'list') {
        const { tasks } = await call('GET', `/api/engine-tasks?limit=${flags.limit ?? 30}${flags.state ? `&state=${flags.state}` : ''}`);
        emit({ tasks }, () => { if (!tasks.length) out('No engine tasks.'); for (const t of tasks) out(line(t)); });
        return 0;
      }
      if (sub === 'status') {
        const id = await fullId(needId('status')); const { task: t } = await call('GET', `/api/engine-tasks/${id}`);
        emit({ task: t }, () => {
          out(`${t.id}\nGoal: ${t.goal}\nEngine: ${t.engine}   State: ${t.state}${t.stateReason ? ` (${t.stateReason})` : ''}   Autonomy: ${t.autonomy}`);
          if (t.progress?.currentActivity && ['running', 'initializing', 'waiting'].includes(t.state)) out(`Activity: ${t.progress.currentActivity}`);
          out(`Progress: ${t.progress?.toolCalls ?? 0} tool calls, ${(t.progress?.filesChanged ?? []).length} files changed, ${(t.progress?.commands ?? []).length} commands`);
          for (const a of t.pendingApprovals ?? []) out(`AWAITING APPROVAL ${a.approvalId}: ${a.summary}\n  → xoft task approve ${short(t.id)} ${a.approvalId}   |   xoft task reject ${short(t.id)} ${a.approvalId}`);
          if (t.result) out(`Result: ${t.result.summary}\n${t.result.verification?.statement ?? ''}`);
          if (t.error) out(`Error: ${t.error}`);
        });
        return 0;
      }
      if (sub === 'stop') { const id = await fullId(needId('stop')); const { task } = await call('POST', `/api/engine-tasks/${id}/cancel`, {}); emit({ task }, () => out(`Task ${short(id)} is now ${task.state}.`)); return 0; }
      if (sub === 'pause') { const id = await fullId(needId('pause')); const { task } = await call('POST', `/api/engine-tasks/${id}/pause`, {}); emit({ task }, () => out(`Task ${short(id)} is now ${task.state}.`)); return 0; }
      if (sub === 'resume') { const id = await fullId(needId('resume')); const { task } = await call('POST', `/api/engine-tasks/${id}/resume`, {}); emit({ task }, () => out(`Task ${short(id)} is now ${task.state}.`)); return 0; }
      if (sub === 'report') { const id = await fullId(needId('report')); const r = await call('GET', `/api/engine-tasks/${id}/report`); out(JSON.stringify(r, null, 2)); return 0; }
      if (sub === 'rollback') { const id = await fullId(needId('rollback')); const r = await call('POST', `/api/engine-tasks/${id}/rollback`, {}); emit(r, () => out(`${r.rolledBack ? 'Rolled back' : 'Not rolled back'}: ${r.how}`)); return r.rolledBack ? 0 : 1; }
      if (sub === 'approve' || sub === 'reject') {
        if (rest.length < 2) throw new Error(`usage: xoft task ${sub} <taskId> <approvalId>`);
        const id = await fullId(rest[0]); const r = await call('POST', `/api/engine-tasks/${id}/approvals/${rest[1]}`, { decision: sub });
        emit(r, () => out(`${sub === 'approve' ? 'Approved' : 'Rejected'}${r.delivered ? '' : ' (could not be delivered to the engine — check the task)'}.`));
        return 0;
      }
      if (sub === 'logs') { const id = await fullId(needId('logs')); return follow(id, Boolean(flags.follow)); }
      throw new Error('usage: xoft task run|list|status|stop|pause|resume|logs|report|rollback|approve|reject');

      async function follow(id, untilDone) {
        let after = 0; let lastState = null;
        for (;;) {
          const { events } = await call('GET', `/api/engine-tasks/${id}/events?after=${after}&limit=500`);
          for (const e of events) {
            after = Math.max(after, e.seq);
            const bits = [e.tool, e.command ?? e.preview ?? e.text ?? e.summary ?? e.reason ?? e.message ?? e.error ?? e.state].filter(Boolean).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
            out(json ? JSON.stringify(e) : `${e.ts.slice(11, 19)}  ${pad(e.type, 28)} ${bits.join(' · ').replace(/\s+/g, ' ').slice(0, 200)}`);
          }
          const { task } = await call('GET', `/api/engine-tasks/${id}`);
          if (task.state !== lastState) { lastState = task.state; if (!json) err(`[${task.state}]${task.stateReason ? ` ${task.stateReason}` : ''}`); }
          for (const a of task.pendingApprovals ?? []) if (!json) err(`APPROVAL NEEDED ${a.approvalId}: ${a.summary}  → xoft task approve ${short(id)} ${a.approvalId}`);
          if (['completed', 'failed', 'cancelled'].includes(task.state)) { if (!json) { if (task.result) out(`\n${task.result.summary}\n${task.result.verification?.statement ?? ''}`); if (task.error) err(`Error: ${task.error}`); } return task.state === 'completed' ? 0 : 1; }
          if (!untilDone) return 0;
          await sleep(1500);
        }
      }
    }
    err(`Unknown command '${cmd}'.\n\n${HELP}`);
    return 1;
  } catch (e) {
    err(`xoft: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
