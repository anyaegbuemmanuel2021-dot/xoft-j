import { api } from '../api.js';
import { card, badge, esc, toast, guarded, onDelegate } from '../dom.js';

export const title = 'Social Studio';
const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'facebook', 'linkedin', 'x', 'threads', 'pinterest'];
let loaded = false;

export async function render(container) {
  container.innerHTML = `
    <div class="grid">
      ${card('Social Studio', `
        <p class="muted">Manage multiple handles, keep an independent kill switch for every account, analyze the samples you provide, and create original drafts. New handles start paused.</p>
        <div class="form-row"><label>Platform</label><select id="social-platform">${PLATFORMS.map((p) => `<option value="${p}">${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select></div>
        <div class="form-row"><label>Handle (without @ is fine)</label><input id="social-handle" maxlength="80" placeholder="softly1810" /></div>
        <div class="form-row"><label>Public profile URL (optional; reference only)</label><input id="social-url" type="url" maxlength="500" placeholder="https://www.instagram.com/handle/" /></div>
        <div class="form-row"><label>Niche / topic</label><input id="social-niche" maxlength="160" placeholder="e.g. technology, education, business" /></div>
        <div class="form-row"><label>Target audience</label><input id="social-audience" maxlength="300" placeholder="Who is this account for?" /></div>
        <div class="form-row"><label>Notes about voice, goals, and boundaries</label><textarea id="social-notes" maxlength="3000" placeholder="Brand voice, topics to avoid, calls to action…"></textarea></div>
        <div class="form-row"><label>Sample posts (one per paragraph, up to 20)</label><textarea id="social-samples" placeholder="Paste public sample posts you are allowed to use for analysis. Separate posts with a blank line."></textarea></div>
        <button id="social-add" class="primary">Add handle</button>
      `, { span2: true })}
      <div id="social-handles" style="grid-column:1/-1"><div class="empty">Loading accounts…</div></div>
    </div>
    <p class="muted">Important: the profile URL is stored as a reference; XOFT does not scrape it in this version. Analysis uses the supplied notes and samples. Publishing is not connected; drafts are never sent automatically.</p>
  `;
  onDelegate(container, 'click', '#social-add', async () => {
    const value = (id) => container.querySelector('#' + id).value.trim();
    const samplePosts = value('social-samples').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    const payload = { platform: value('social-platform'), handle: value('social-handle'), profileUrl: value('social-url'), niche: value('social-niche'), audience: value('social-audience'), notes: value('social-notes'), samplePosts };
    await guarded(async () => { await api.post('/api/social/handles', payload); toast('Handle added and safely paused', 'ok'); await render(container); }, 'Add social handle');
  });
  onDelegate(container, 'click', '[data-social-action]', async (el) => {
    const cardNode = el.closest('[data-social-card]');
    const id = cardNode?.dataset.socialCard;
    if (!id) return;
    const action = el.dataset.socialAction;
    const call = async () => {
      if (action === 'save') {
        const value = (selector) => cardNode.querySelector(selector).value.trim();
        const samplePosts = value('[data-samples]').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
        await api.post(`/api/social/handles/${encodeURIComponent(id)}/update`, { profileUrl: value('[data-url]'), niche: value('[data-niche]'), audience: value('[data-audience]'), notes: value('[data-notes]'), samplePosts });
        toast('Handle settings saved', 'ok');
      } else if (action === 'kill') {
        await api.post(`/api/social/handles/${encodeURIComponent(id)}/kill`, { reason: 'Stopped from Social Studio' });
        toast('Kill switch activated for this handle', 'warn');
      } else if (action === 'arm') {
        await api.post(`/api/social/handles/${encodeURIComponent(id)}/arm`, {});
        toast('Workflow flag enabled; publishing is still not connected', 'ok');
      } else if (action === 'analyze') {
        await api.post(`/api/social/handles/${encodeURIComponent(id)}/analyze`, {});
        toast('Style analysis saved', 'ok');
      } else if (action === 'draft') {
        const goal = cardNode.querySelector('[data-goal]').value.trim();
        const format = cardNode.querySelector('[data-format]').value;
        if (!goal) throw new Error('Enter a content goal first.');
        await api.post(`/api/social/handles/${encodeURIComponent(id)}/drafts`, { goal, format });
        toast('Draft created — not published', 'ok');
      } else if (action === 'remove') {
        if (!window.confirm('Remove this handle and its saved analysis/drafts?')) return;
        await api.post(`/api/social/handles/${encodeURIComponent(id)}/remove`, {});
        toast('Handle removed', 'ok');
      }
      await render(container);
    };
    await guarded(call, action === 'kill' ? 'Stop handle' : action === 'remove' ? 'Remove handle' : 'Update handle');
  });
  await loadHandles(container);
}

async function loadHandles(container) {
  const root = container.querySelector('#social-handles');
  try {
    const handles = await api.get('/api/social/handles');
    if (!root) return;
    root.innerHTML = handles.length ? `<div class="grid">${handles.map(renderHandle).join('')}</div>` : '<div class="empty">No handles yet. Add one above to create a content workspace.</div>';
  } catch (error) {
    if (root) root.innerHTML = `<div class="empty">Could not load social handles: ${esc(error.message)}</div>`;
  }
}

function renderHandle(handle) {
  const state = handle.killSwitch ? 'KILLED / PAUSED' : handle.workflowEnabled ? 'WORKFLOW ENABLED' : 'PAUSED';
  const stateTone = handle.killSwitch ? 'err' : handle.workflowEnabled ? 'ok' : 'warn';
  const analysis = handle.analysis?.text ? `<details><summary>Style analysis</summary><pre class="social-output">${esc(handle.analysis.text)}</pre></details>` : '<p class="muted">No style analysis yet.</p>';
  const drafts = (handle.drafts ?? []).slice().reverse().map((draft) => `<details><summary>${esc(draft.format)} · ${esc(new Date(draft.createdAt).toLocaleString())}</summary><pre class="social-output">${esc(draft.text)}</pre><button type="button" data-copy-draft="${esc(draft.id)}">Copy draft</button></details>`).join('') || '<p class="muted">No drafts yet.</p>';
  return card(`${handle.platform} · @${handle.handle}`, `
    <div data-social-card="${esc(handle.id)}">
      <div class="inline">${badge(state, stateTone)}<span class="muted">${esc(handle.profileUrl || 'No profile URL')}</span></div>
      <div class="form-row"><label>Niche</label><input data-niche maxlength="160" value="${esc(handle.niche || '')}" /></div>
      <div class="form-row"><label>Audience</label><input data-audience maxlength="300" value="${esc(handle.audience || '')}" /></div>
      <div class="form-row"><label>Profile notes</label><textarea data-notes maxlength="3000">${esc(handle.notes || '')}</textarea></div>
      <div class="form-row"><label>Sample posts (separate with a blank line)</label><textarea data-samples>${esc((handle.samplePosts || []).join('\n\n'))}</textarea></div>
      <div class="inline">
        <button type="button" data-social-action="save">Save</button>
        <button type="button" data-social-action="analyze">Analyze style</button>
        <button type="button" data-social-action="kill" class="danger">KILL SWITCH</button>
        <button type="button" data-social-action="arm">Enable workflow</button>
        <button type="button" data-social-action="remove" class="danger">Remove</button>
      </div>
      <div class="form-row"><label>Content goal</label><input data-goal maxlength="1000" placeholder="e.g. explain a practical tip for small businesses" /></div>
      <div class="form-row"><label>Draft format</label><select data-format><option value="caption">Caption / post</option><option value="carousel">Carousel outline</option><option value="short-video-script">Short-video script</option><option value="thread">Thread</option><option value="content-plan">Content plan</option></select></div>
      <button type="button" data-social-action="draft" class="primary">Generate draft</button>
      <h4>Style analysis</h4>${analysis}
      <h4>Draft library</h4>${drafts}
    </div>
  `);
}
