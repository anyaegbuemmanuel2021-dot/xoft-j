import { api } from '../api.js';
import { card, badge, rows, fmtTime, esc, toast, guarded, onDelegate } from '../dom.js';

export const title = 'Memory';
let filters = { category: '', textIncludes: '' };

export async function render(container) {
  const query = new URLSearchParams({ ...(filters.category && { category: filters.category }), ...(filters.textIncludes && { textIncludes: filters.textIncludes }) }).toString();
  const entries = await api.get(`/api/memory${query ? '?' + query : ''}`);

  container.innerHTML = `
    ${card('Remember something', `
      <div class="form-row"><label>Category</label><input id="mem-category" placeholder="fact, preference, person…" /></div>
      <div class="form-row"><label>Content</label><textarea id="mem-content" placeholder="what to remember"></textarea></div>
      <button id="mem-create" class="primary">Save</button>
    `)}
    ${card('Filter', `
      <div class="form-row"><label>Category</label><input id="filter-category" value="${esc(filters.category)}" /></div>
      <div class="form-row"><label>Text contains</label><input id="filter-text" value="${esc(filters.textIncludes)}" /></div>
      <button id="filter-apply">Apply</button>
    `)}
    ${card(`Entries (${entries.length})`, rows(entries.slice().reverse(), memoryRow, 'Nothing stored yet.'), { span2: true })}
  `;

  onDelegate(container, 'click', '#mem-create', async () => {
    const category = container.querySelector('#mem-category').value.trim();
    const content = container.querySelector('#mem-content').value.trim();
    if (!category || !content) return toast('Category and content are required', 'err');
    await guarded(() => api.post('/api/memory', { category, content }), 'Save memory');
    toast('Saved', 'ok');
    render(container);
  });

  onDelegate(container, 'click', '#filter-apply', () => {
    filters = { category: container.querySelector('#filter-category').value.trim(), textIncludes: container.querySelector('#filter-text').value.trim() };
    render(container);
  });

  onDelegate(container, 'click', '[data-correct]', async (el) => {
    const newContent = window.prompt('Corrected content:');
    if (!newContent) return;
    const reason = window.prompt('Reason (optional):') || undefined;
    await guarded(() => api.post(`/api/memory/${el.dataset.correct}/correct`, { content: newContent, reason }), 'Correct');
    toast('Corrected', 'ok');
    render(container);
  });

  onDelegate(container, 'click', '[data-delete]', async (el) => {
    if (!window.confirm('Delete this memory entry?')) return;
    await guarded(() => api.del(`/api/memory/${el.dataset.delete}`), 'Delete');
    toast('Deleted', 'ok');
    render(container);
  });
}

function sourceBadge(source) {
  if (!source) return badge('unspecified', '');
  const kind = { USER_STATED: 'ok', USER_CORRECTED: 'ok', SYSTEM_OBSERVED: '', AI_INFERRED: 'warn', API_RETURNED: '' }[source] ?? '';
  return badge(source, kind);
}

function memoryRow(e) {
  return `
    <div class="row" style="flex-direction:column; align-items:stretch;">
      <div style="display:flex; justify-content:space-between; gap:8px;">
        <span class="main">${esc(e.content)}</span>
        ${sourceBadge(e.source)}
      </div>
      <div class="muted" style="margin:4px 0;">${esc(e.category)}${e.confidence != null ? ' · confidence ' + e.confidence : ''} · ${fmtTime(e.createdAt)}${e.history?.length ? ' · corrected ' + e.history.length + 'x' : ''}</div>
      <div class="inline" style="gap:6px;">
        <button data-correct="${e.id}">Correct…</button>
        <button data-delete="${e.id}" class="danger">Delete</button>
      </div>
    </div>
  `;
}
