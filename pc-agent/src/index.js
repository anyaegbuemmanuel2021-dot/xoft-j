const { loadConfig } = require('./config');
const { CoreClient } = require('./coreClient');
const { ensurePaired } = require('./pairing');
const { installStartup, uninstallStartup } = require('./startup');
const systemExec = require('./executors/system');
const appsExec = require('./executors/applications');
const browserExec = require('./executors/browser');
const filesExec = require('./executors/files');
const mediaExec = require('./executors/media');
const screenExec = require('./executors/screen');
const { DeviceRuntime } = require('./runtime/DeviceRuntime');

// The only capabilities this agent will ever claim — must match what
// dispatchCommand() actually handles below. Reported to core via
// POST /api/devices/:id/capabilities so commands for anything else are
// never even queued to us (DeviceManager.execute checks this server-side too).
const LEGACY_CAPABILITIES = ['system', 'applications', 'browser', 'files', 'media', 'screen'];
const CAPABILITIES = [...new Set([...LEGACY_CAPABILITIES, ...DeviceRuntime.CAPABILITIES])];

// Actions that stay available while halted (read-only status; a halt never blocks learning WHY it is halted).
const HALT_EXEMPT = new Set(['runtime.status', 'system.read_system_info']);

async function dispatchCommand(command, config, runtime) {
  const { capability, action, parameters } = command;
  const key = `${capability}.${action}`;
  if (runtime.halt.isHalted() && !HALT_EXEMPT.has(key)) {
    return { success: false, blocked: true, error: `HALTED: ${runtime.halt.reason()} — no actions are permitted until a human resumes the agent.` };
  }
  // New runtime capabilities (browser automation, file intelligence, terminal, workspaces, journal).
  // Returns null for anything it doesn't own, which falls through to the original handlers below unchanged.
  const runtimeResult = await runtime.dispatch(command);
  if (runtimeResult !== null && runtimeResult !== undefined) return runtimeResult;
  switch (`${capability}.${action}`) {
    case 'system.read_system_info':
      return systemExec.readSystemInfo();
    case 'applications.list':
      return appsExec.listApplications();
    case 'applications.open_application':
      return appsExec.openApplication(parameters.application, config.appAllowlist);
    case 'applications.close_application':
      return appsExec.closeApplication(parameters.application, config.appAllowlist);
    case 'browser.open_url':
      return browserExec.openUrl(parameters.url);
    case 'files.list_files':
      return filesExec.listFiles(parameters.path, config.allowedRoots);
    case 'files.prepare_transfer':
      return filesExec.prepareTransfer(parameters.path, config.allowedRoots);
    case 'files.receive_transfer':
      return filesExec.receiveTransfer(parameters.path, parameters.sourceData, config.allowedRoots);
    case 'screen.capture':
      return screenExec.capture();
    case 'screen.click':
    case 'screen.type':
    case 'screen.scroll':
      return screenExec.input(action, parameters);
    case 'media.play':
    case 'media.pause':
    case 'media.stop':
    case 'media.volume_up':
    case 'media.volume_down':
    case 'media.mute':
      return mediaExec.mediaControl(action);
    default:
      // Honest refusal — never a fabricated success for something we don't implement.
      return { success: false, error: `Agent does not implement ${capability}.${action}.` };
  }
}

async function readReportableState(runtime) {
  const info = await systemExec.readSystemInfo();
  if (!info.success) return {};
  return {
    runtime: await runtime.health(),
    cpu: info.data.loadAverage?.[0] ?? null,
    memory: info.data.memory?.usedPercent ?? null,
    network: info.data.network?.[0]?.address ?? null,
    battery: null, // desktops: no standard battery reading without extra native tooling — reported honestly as unknown, not faked
  };
}

async function syncHalt(client, runtime) {
  try {
    const es = await client.getEmergencyStop();
    runtime.halt.syncFromCore(Boolean(es.active));
  } catch { /* core unreachable: leave local state as is; local HALT sentinel still works */ }
}

async function pollLoop(client, deviceId, config, runtime) {
  await syncHalt(client, runtime);
  let pending;
  try {
    pending = await client.pullPendingCommands(deviceId);
  } catch (err) {
    console.error(`[poll] failed to reach core: ${err.message}`);
    return;
  }
  for (const command of pending) {
    console.log(`[command] ${command.capability}.${command.action} (${command.id})`);
    let result;
    try {
      result = await dispatchCommand(command, config, runtime);
    } catch (err) {
      result = { success: false, error: `Unhandled executor error: ${err.message}` };
    }
    try {
      await client.submitResult(deviceId, command.id, result);
    } catch (err) {
      console.error(`[command] failed to submit result for ${command.id}: ${err.message}`);
    }
  }
}

async function main() {
  // Explicit, opt-in startup registration — never runs as a side effect of
  // normal `node src/index.js`. Handled and exited here, before touching
  // config/pairing/network at all, so it works even before the agent has
  // ever been configured.
  if (process.argv.includes('--install-startup')) {
    const { taskName } = installStartup();
    console.log(`Installed: XOFT will now start automatically at login (Task Scheduler task "${taskName}").`);
    console.log('To undo this at any time: node src/index.js --uninstall-startup');
    return;
  }
  if (process.argv.includes('--uninstall-startup')) {
    const { taskName } = uninstallStartup();
    console.log(`Removed the "${taskName}" startup task. XOFT will no longer start automatically at login.`);
    return;
  }

  const config = loadConfig();

  // Local, human-only controls — none of these are reachable through xoft-core.
  const argAfter = (flag, n = 1) => { const i = process.argv.indexOf(flag); return i === -1 ? null : process.argv.slice(i + 1, i + 1 + n); };
  if (process.argv.includes('--halt') || process.argv.includes('--resume') || argAfter('--add-workspace', 2) || argAfter('--remove-workspace') || process.argv.includes('--workspaces')) {
    const local = new DeviceRuntime({ config });
    try {
      if (process.argv.includes('--halt')) { require('fs').writeFileSync(local.halt.sentinel, `halted locally ${new Date().toISOString()}\n`); console.log(`HALT written: ${local.halt.sentinel}\nThe running agent stops all actions within ~1s and kills any running terminal process.`); }
      else if (process.argv.includes('--resume')) { local.halt.resume(); console.log('HALT cleared. A running agent resumes accepting commands.'); }
      else if (argAfter('--add-workspace', 2)) { const [name, root] = argAfter('--add-workspace', 2); const w = local.workspaces.add(name, root); console.log(`Workspace '${w.name}' registered at ${w.root}. XOFT file/terminal work can now touch this folder (and only registered folders).`); }
      else if (argAfter('--remove-workspace')) { local.workspaces.remove(argAfter('--remove-workspace')[0]); console.log('Workspace removed.'); }
      else console.log(JSON.stringify(local.workspaces.list(), null, 2));
    } catch (err) { console.error(err.message); process.exitCode = 1; } finally { local.stop(); }
    return;
  }

  const runtime = new DeviceRuntime({ config });
  process.on('SIGINT', () => { runtime.stop(); process.exit(0); });
  const client = new CoreClient(config.coreUrl, config.apiKey, config.deviceToken);
  const deviceId = await ensurePaired(config);

  await client.reportCapabilities(deviceId, CAPABILITIES);
  console.log(`Reported capabilities: ${CAPABILITIES.join(', ')}`);
  console.log(`Runtime state dir: ${runtime.stateDir} | workspaces: ${runtime.workspaces.list().map((w) => w.name).join(', ') || '(none — file/terminal work is disabled until you add one with --add-workspace <name> <path>)'}`);

  const heartbeatTick = async () => {
    try {
      await client.heartbeat(deviceId);
    } catch (err) {
      console.error(`[heartbeat] ${err.message}`);
    }
  };
  const stateTick = async () => {
    try {
      await client.reportState(deviceId, await readReportableState(runtime));
    } catch (err) {
      console.error(`[state] ${err.message}`);
    }
  };
  const pollTick = () => pollLoop(client, deviceId, config, runtime);
  // Bounded browser self-healing: only if a browser was previously in use and is now unreachable; DeviceRuntime caps attempts.
  const healTick = async () => { try { const h = await runtime.health(); if (!h.halted && runtime.browser.status().attachedTabId && !h.browser.ok) await runtime.recoverBrowser(); } catch { /* reported via state */ } };

  await heartbeatTick();
  await stateTick();
  setInterval(heartbeatTick, config.heartbeatIntervalMs);
  setInterval(stateTick, config.stateReportIntervalMs);
  setInterval(pollTick, config.pollIntervalMs);
  setInterval(healTick, 30000);

  console.log(`\nXOFT Windows agent running. Device id: ${deviceId}`);
  console.log(`Polling ${config.coreUrl} every ${config.pollIntervalMs}ms. Ctrl+C to stop.\n`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error starting agent:', err.message);
    process.exit(1);
  });
}

module.exports = { dispatchCommand, CAPABILITIES };
