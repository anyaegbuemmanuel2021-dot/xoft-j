import { NAV_ITEMS } from './logic.js';

export function mountNavigation(el, store) {
  el.innerHTML = `<ul>${NAV_ITEMS.map((n) => `<li><a href="#${n.route}" data-nav-id="${n.id}" ${n.id === 'command' ? 'aria-current="page"' : ''}><span class="cc-nav-icon" aria-hidden="true">${n.icon}</span><span>${n.label}</span><span class="cc-badge" data-badge="${n.id}" hidden></span></a></li>`).join('')}</ul>`;
  function badges() {
    const running = store.get('tasks').data.filter((t) => t.status === 'running' || t.status === 'waiting_approval').length;
    const b = el.querySelector('[data-badge="tasks"]');
    b.hidden = !running; b.textContent = running || '';
  }
  badges();
  return store.subscribe('tasks', badges);
}
