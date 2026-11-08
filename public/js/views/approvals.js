import { api } from '../api.js';
import { card, badge, rows, fmtTime, esc, toast, guarded, onDelegate, debounce } from '../dom.js';
import { onEvent } from '../ws.js';

export const title = 'Approvals';
export let cleanup = null;

export async function render(container) {
  const pending = await api.get('/api/approvals');
  container.innerHTML = card(`Pending (${pending.length})`, rows(pending, approvalRow, 'Nothing waiting on you.'));

  onDelegate(container, 'click', '[data-approve]', async (el) => {
    await guarded(() => api.post(`/api/approvals/${el.dataset.approve}/approve`), 'Approve');
    toast('Approved', 'ok');
    render(container);
  });
  onDelegate(container, 'click', '[data-reject]', async (el) => {
    await guarded(() => api.post(`/api/approvals/${el.dataset.reject}/reject`), 'Reject');
    toast('Rejected', '');
    render(container);
  });

  // Live: a new approval can be requested by a background workflow/monitor
  // while this page is open elsewhere — surface it immediately.
  const refresh = debounce(() => render(container), 400);
  cleanup = onEvent(['approval_required'], () => { toast('New approval requested', 'warn'); refresh(); });
}

function approvalRow(a) {
  return `
    <div class="row" style="flex-direction:column; align-items:stretch;">
      <div style="display:flex; justify-content:space-between; gap:8px;">
        <span class="main">${esc(a.toolName)}</span>
        ${badge('risk ' + a.riskLevel, a.riskLevel >= 2 ? 'err' : 'warn')}
      </div>
      <pre style="margin:4px 0;">${esc(JSON.stringify(a.input, null, 2)).slice(0, 400)}</pre>
      <div class="muted" style="margin-bottom:4px;">requested ${fmtTime(a.createdAt)}</div>
      <div class="inline" style="gap:6px;">
        <button data-approve="${a.id}" class="primary">Approve</button>
        <button data-reject="${a.id}" class="danger">Reject</button>
      </div>
    </div>
  `;
}
