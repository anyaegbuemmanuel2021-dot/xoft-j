// router.js — tiny hash router. No history API tricks, no build step: the
// URL hash IS the route ('#tasks', '#memory', ...), so refresh/bookmark/back
// all just work for free.

const routes = new Map();
let current = null;

export function registerRoute(name, module) {
  routes.set(name, module);
}

export function currentRoute() {
  return (location.hash.replace(/^#/, '') || 'command').split('?')[0];
}

async function render() {
  const name = currentRoute();
  const mod = routes.get(name) ?? routes.get('command') ?? routes.get('overview');
  const container = document.getElementById('content');

  if (current?.cleanup) {
    try { current.cleanup(); } catch { /* view cleanup must never block navigation */ }
  }
  current = mod;
  // CSS hook: the Command Center hides the legacy sidebar/topbar and uses its own chrome.
  document.body.dataset.route = routes.has(name) ? name : 'command';

  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  document.getElementById('page-title').textContent = mod.title ?? name;

  container.innerHTML = '<div class="empty">Loading…</div>';
  try {
    await mod.render(container);
  } catch (err) {
    container.innerHTML = `<div class="card"><h2>Error</h2><div class="empty">${err.message}</div></div>`;
  }
}

export function startRouter() {
  window.addEventListener('hashchange', render);
  render();
}
