// XoftCommandCenter.js — the primary post-login screen. Same contract as every
// other view (title / render(container) / cleanup) so it plugs into router.js
// without touching existing routes.
import { createStore } from './store.js';
import { startData, initialState } from './data.js';
import { mountTopBar } from './TopBar.js';
import { mountXoftCore } from './XoftCore.js';
import { mountCommandInput } from './CommandInput.js';
import { mountApprovals } from './ApprovalCard.js';
import { mountSystemStatus } from './SystemStatusPanel.js';
import { mountProviderStatus } from './ProviderStatusPanel.js';
import { mountMemory } from './MemoryPanel.js';
import { mountCurrentTask } from './CurrentTaskPanel.js';
import { mountActivity } from './ActivityPanel.js';
import { mountSystemLog } from './SystemLogPanel.js';
import { mountMissions } from './MissionsPanel.js';
import { mountAutonomy } from './AutonomyPanel.js';
import { mountDiagnostics } from './DiagnosticsPanel.js';
import { mountNavigation } from './DashboardNavigation.js';
import { runBoot } from './BootSequence.js';

export const title = 'Command Center';
export let cleanup = null;

const panel = (cls, id, heading, extra = '') => `<section class="cc-panel ${cls}" aria-labelledby="h-${id}"><h2 id="h-${id}"><span>${heading}</span>${extra}</h2><div class="cc-panel-body" data-mount="${id}"></div></section>`;

export async function render(container) {
  cleanup?.();
  container.innerHTML = `
    <div class="cc" data-cc>
      <a class="cc-skip" href="#cc-command">Skip to command input</a>
      <header class="cc-top" data-mount="top"></header>
      <main class="cc-main">
        <div class="cc-col cc-col-left">
          ${panel('cc-p-system', 'system', 'SYSTEM STATUS')}
          ${panel('cc-p-providers', 'providers', 'AI PROVIDERS')}
          ${panel('cc-p-diag', 'diagnostics', 'DIAGNOSTICS')}
          ${panel('cc-p-autonomy', 'autonomy', 'AUTONOMY')}
          ${panel('cc-p-memory', 'memory', 'MEMORY')}
        </div>
        <div class="cc-col cc-col-center">
          <section class="cc-p-core" aria-label="XOFT core" data-mount="core"></section>
          <section class="cc-p-cmd" id="cc-command" aria-label="Command input">
            <div data-mount="approvals" hidden></div>
            <div data-mount="cmd"></div>
          </section>
        </div>
        <div class="cc-col cc-col-right">
          ${panel('cc-p-task', 'task', 'CURRENT TASK')}
          ${panel('cc-p-missions', 'missions', 'ACTIVE MISSIONS')}
          ${panel('cc-p-activity', 'activity', 'LIVE ACTIVITY')}
          ${panel('cc-p-log', 'log', 'SYSTEM LOG')}
        </div>
      </main>
      <nav class="cc-nav" aria-label="XOFT navigation" data-mount="nav"></nav>
    </div>`;

  document.body.dataset.route = 'command';
  const store = createStore(initialState());
  const data = startData(store);
  const m = (name) => container.querySelector(`[data-mount="${name}"]`);

  const unmounts = [
    mountTopBar(m('top'), store, data),
    mountXoftCore(m('core'), store),
    mountApprovals(m('approvals'), store, data),
    mountCommandInput(m('cmd'), store, data),
    mountSystemStatus(m('system'), store),
    mountProviderStatus(m('providers'), store, data),
    mountMemory(m('memory'), store),
    mountMissions(m('missions'), store, data),
    mountAutonomy(m('autonomy'), store),
    mountDiagnostics(m('diagnostics'), store),
    mountCurrentTask(m('task'), store),
    mountActivity(m('activity'), store),
    mountSystemLog(m('log'), store),
    mountNavigation(m('nav'), store),
  ];

  cleanup = () => {
    unmounts.forEach((u) => { try { u?.(); } catch { /* ignore */ } });
    data.stop();
    cleanup = null;
  };

  // Boot overlay runs while live data loads underneath it. Data loading starts
  // only after the boot's first authenticated call, so an API-key prompt
  // (existing api.js behavior) appears once rather than once per widget.
  let first = Promise.resolve();
  await runBoot(container.querySelector('[data-cc]'), { onAuthChecked: () => { data.markReady(); first = data.refreshAll(); } });
  await first;
  data.recomputeCore();
  container.querySelector('#cc-input')?.focus({ preventScroll: true });
}
