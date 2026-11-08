export function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

export function badge(text, kind) {
  return `<span class="badge ${kind || ''}">${esc(text)}</span>`;
}

export function card(title, innerHtml, { span2 = false, id = '' } = {}) {
  return `<div class="card${span2 ? ' span2' : ''}"${id ? ` id="${id}"` : ''}><h2>${esc(title)}</h2>${innerHtml}</div>`;
}

export function rows(items, renderRow, emptyText = 'nothing here yet') {
  if (!items || !items.length) return `<div class="empty">${esc(emptyText)}</div>`;
  return items.map(renderRow).join('');
}

export function toast(msg, kind = '') {
  let wrap = document.getElementById('toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toast-wrap';
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

/** Delegated click handler helper: container.on('click', '[data-action]', (el, e) => ...) */
export function onDelegate(container, event, selector, handler) {
  container.addEventListener(event, (e) => {
    const el = e.target.closest(selector);
    if (el && container.contains(el)) handler(el, e);
  });
}

export async function guarded(fn, label) {
  try {
    return await fn();
  } catch (err) {
    toast(`${label ? label + ': ' : ''}${err.message}`, 'err');
    throw err;
  }
}

/** Coalesces bursts of calls (e.g. several realtime events in quick succession) into one trailing call. */
export function debounce(fn, ms = 400) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
