// XOFT Command Center — focused home screen. Detailed tools remain available from the bottom navigation.
import { createStore } from './store.js';
import { startData, initialState } from './data.js';
import { mountTopBar } from './TopBar.js';
import { mountXoftCore } from './XoftCore.js';
import { mountCommandInput } from './CommandInput.js';
import { mountApprovals } from './ApprovalCard.js';
import { mountNavigation } from './DashboardNavigation.js';
import { currentModel } from './logic.js';
import { esc } from '../dom.js';
import { runBoot } from './BootSequence.js';

export const title = 'Command Center';
export let cleanup = null;

function mountModelStrip(el, store) {
  function paint() {
    const providerData = store.get('providers')?.data;
    const providers = Array.isArray(providerData) ? providerData.filter((p) => p && typeof p === 'object') : [];
    const active = currentModel(providers);
    const activeProvider = providers.find((p) => p.label === active?.provider);
    const activeState = activeProvider?.status || 'UNKNOWN';
    const samples = providers.filter((p) => p.configured).map((p) => ({
      name: p.label || p.id,
      model: p.model || 'model not reported',
      status: p.status || 'UNKNOWN',
    }));
    const statusLabel = (status) => status === 'AVAILABLE' ? 'READY' : status === 'UNKNOWN' ? 'UNVERIFIED' : status;
    el.innerHTML = `
      <div class="cc-model-head">
        <span class="cc-model-kicker">INTELLIGENCE</span>
        <span class="cc-model-active"><i data-state="${esc(activeState)}"></i><span>ACTIVE MODEL</span><strong title="${esc(active?.model || 'No active model reported')}">${esc(active?.model || 'No active model')}</strong></span>
      </div>
      <div class="cc-model-list" aria-label="Configured model availability">
        ${samples.length ? samples.map((p) => `<span class="cc-model-chip" data-state="${esc(p.status)}"><b>${esc(p.name)}</b><span>${esc(p.model)}</span><em>${esc(statusLabel(p.status))}</em></span>`).join('') : '<span class="cc-model-empty">No configured provider reported yet. Open Runtime Settings to connect a model.</span>'}
      </div>
      <div class="cc-model-foot">Provider state is live status from XOFT · models shown here are configured, not a guarantee of current quota.</div>`;
    el.classList.toggle('has-active-model', Boolean(active?.model));
  }
  paint();
  return store.subscribe(['providers'], paint);
}

export async function render(container) {
  cleanup?.();
  container.innerHTML = `
    <div class="cc cc-home" data-cc>
      <a class="cc-skip" href="#cc-command">Skip to command input</a>
      <header class="cc-top" data-mount="top"></header>
      <main class="cc-main cc-main-home">
        <section class="cc-home-core" aria-label="XOFT voice and chat command centre">
          <section class="cc-p-core" aria-label="XOFT core" data-mount="core"></section>
          <section class="cc-model-strip" aria-label="Active and configured AI models" data-mount="models"></section>
          <section class="cc-p-cmd" id="cc-command" aria-label="XOFT voice and chat">
            <div data-mount="approvals" hidden></div>
            <div data-mount="cmd"></div>
          </section>
        </section>
      </main>
      <nav class="cc-nav" aria-label="XOFT pages" data-mount="nav"></nav>
    </div>`;

  document.body.dataset.route = 'command';
  const store = createStore(initialState());
  const data = startData(store);
  const m = (name) => container.querySelector(`[data-mount="${name}"]`);
  const unmounts = [
    mountTopBar(m('top'), store, data),
    mountXoftCore(m('core'), store),
    mountModelStrip(m('models'), store),
    mountApprovals(m('approvals'), store, data),
    mountCommandInput(m('cmd'), store, data),
    mountNavigation(m('nav'), store),
  ];
  cleanup = () => {
    unmounts.forEach((u) => { try { u?.(); } catch { /* ignore */ } });
    data.stop();
    cleanup = null;
  };
  let first = Promise.resolve();
  await runBoot(container.querySelector('[data-cc]'), { onAuthChecked: () => { data.markReady(); first = data.refreshAll(); } });
  await first;
  data.recomputeCore();
  container.querySelector('#cc-input')?.focus({ preventScroll: true });
}
