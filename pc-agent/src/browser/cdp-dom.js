'use strict';
const { CdpError } = require('./cdp-connection');

const MAX_SELECTOR = 500;
const MAX_TEXT = 200;

/** Page-side helper. Fixed source; ALL caller-supplied values are passed as JSON literals, never concatenated as code. */
const PRELUDE = `
const xVisible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
const xSecret = (e) => { const t = (e.getAttribute('type') || '').toLowerCase(); const ac = (e.getAttribute('autocomplete') || '').toLowerCase(); return t === 'password' || ac.startsWith('cc-') || ac === 'one-time-code'; };
const xTxt = (e) => ((e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '') + '').trim();
const xFind = (loc) => {
  if (loc.selector) { try { return [...document.querySelectorAll(loc.selector)]; } catch (err) { throw new Error('Invalid selector: ' + err.message); } }
  const q = loc.text.trim().toLowerCase();
  const cand = [...document.querySelectorAll('a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[onclick],h1,h2,h3,h4,li,p,span,div')];
  const exact = cand.filter((e) => xTxt(e).toLowerCase() === q);
  return exact.length ? exact : cand.filter((e) => xTxt(e).toLowerCase().includes(q)).sort((a, b) => xTxt(a).length - xTxt(b).length);
};
const xHint = (e) => e.id ? '#' + CSS.escape(e.id) : e.getAttribute('name') ? e.tagName.toLowerCase() + '[name=' + JSON.stringify(e.getAttribute('name')) + ']' : e.tagName.toLowerCase();
const xDescribe = (e) => { const r = e.getBoundingClientRect(); return {
  tag: e.tagName.toLowerCase(), id: e.id || null, name: e.getAttribute('name'), type: e.getAttribute('type'),
  text: xTxt(e).slice(0, 120), href: e.getAttribute('href'), role: e.getAttribute('role'),
  value: xSecret(e) ? '[redacted]' : ('value' in e && typeof e.value === 'string' ? e.value.slice(0, 200) : null),
  visible: xVisible(e), disabled: !!e.disabled, checked: typeof e.checked === 'boolean' ? e.checked : null,
  rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }, hint: xHint(e) }; };
`;

function normalizeLocator(loc) {
  if (!loc || typeof loc !== 'object') throw new CdpError('A locator is required: { selector } or { text }');
  const { selector, text } = loc;
  if ((selector == null) === (text == null)) throw new CdpError('Provide exactly one of { selector } or { text }');
  if (selector != null && (typeof selector !== 'string' || !selector.trim() || selector.length > MAX_SELECTOR)) throw new CdpError(`selector must be a non-empty string up to ${MAX_SELECTOR} chars`);
  if (text != null && (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT)) throw new CdpError(`text must be a non-empty string up to ${MAX_TEXT} chars`);
  const index = Number.isInteger(loc.index) && loc.index >= 0 ? loc.index : 0;
  return { selector: selector ?? null, text: text ?? null, index };
}

const expr = (tag, loc, body) => `/*xoft:${tag}*/(() => { ${PRELUDE} const loc = ${JSON.stringify(loc)}; const els = xFind(loc); ${body} })()`;

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' }, Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 }, Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 }, Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 }, ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 }, ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 }, End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 }, PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
};

/** CdpDom — element-level operations (query, click, type, fill, press, scroll, wait, text, attributes, element screenshots). */
class CdpDom {
  constructor(page) { this.page = page; this.conn = page.conn; }

  async query(locator, { limit = 20, signal } = {}) {
    const loc = normalizeLocator(locator);
    const max = Math.min(Math.max(1, limit), 100);
    return this.page.evaluate(expr('query', loc, `return { count: els.length, items: els.slice(0, ${max}).map(xDescribe) };`), { signal });
  }

  /** Compact structured snapshot of interactive elements — deliberately NOT raw outerHTML. */
  async snapshot({ limit = 150, signal } = {}) {
    const max = Math.min(Math.max(1, limit), 400);
    return this.page.evaluate(`/*xoft:snapshot*/(() => { ${PRELUDE}
      const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[onclick]';
      const all = [...document.querySelectorAll(sel)];
      return { url: location.href, title: document.title,
        counts: { links: document.querySelectorAll('a[href]').length, buttons: document.querySelectorAll('button,[role=button],input[type=submit],input[type=button]').length, forms: document.forms.length, inputs: document.querySelectorAll('input,select,textarea').length },
        interactive: all.slice(0, ${max}).map(xDescribe), truncated: all.length > ${max},
        forms: [...document.forms].slice(0, 20).map((f) => ({ id: f.id || null, action: f.getAttribute('action'), method: (f.getAttribute('method') || 'get').toLowerCase(), fields: [...f.elements].slice(0, 40).map((x) => ({ name: x.getAttribute('name'), type: x.getAttribute('type') || x.tagName.toLowerCase() })) })) }; })()`, { signal });
  }

  /** Scrolls into view, refuses if hidden/disabled/covered by another element, then dispatches real mouse input at the element's center. */
  async click(locator, { force = false, signal } = {}) {
    const loc = normalizeLocator(locator);
    const prep = await this.page.evaluate(expr('prepClick', loc, `
      const el = els[loc.index]; if (!el) return { ok: false, error: 'not_found', matches: els.length };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      if (!xVisible(el)) return { ok: false, error: 'not_visible' };
      if (el.disabled) return { ok: false, error: 'disabled' };
      const r = el.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const top = document.elementFromPoint(x, y);
      const covered = !!top && top !== el && !el.contains(top) && !top.contains(el);
      return { ok: true, x, y, covered, coveredBy: covered ? top.tagName.toLowerCase() : null, target: xDescribe(el) };`), { signal });
    if (!prep.ok) throw new CdpError(`Cannot click: ${prep.error}${prep.matches !== undefined ? ` (${prep.matches} matches)` : ''}`);
    if (prep.covered && !force) throw new CdpError(`Cannot click: element is covered by <${prep.coveredBy}> (pass force to override)`);
    const base = { x: prep.x, y: prep.y, button: 'left', clickCount: 1 };
    await this.conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: prep.x, y: prep.y }, { signal });
    await this.conn.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, { signal });
    await this.conn.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, { signal });
    return { clickedAt: { x: Math.round(prep.x), y: Math.round(prep.y) }, target: prep.target };
  }

  async _focus(locator, { clear = false, signal } = {}) {
    const loc = normalizeLocator(locator);
    const r = await this.page.evaluate(expr('focus', loc, `
      const el = els[loc.index]; if (!el) return { ok: false, error: 'not_found', matches: els.length };
      if (el.disabled || el.readOnly) return { ok: false, error: 'not_editable' };
      el.scrollIntoView({ block: 'center' }); el.focus();
      ${clear ? "if ('value' in el) { el.select && el.select(); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } else if (el.isContentEditable) { el.textContent = ''; }" : ''}
      return { ok: true, secret: xSecret(el), target: xDescribe(el) };`), { signal });
    if (!r.ok) throw new CdpError(`Cannot focus element: ${r.error}${r.matches !== undefined ? ` (${r.matches} matches)` : ''}`);
    return r;
  }

  /** Types into the focused element without clearing. */
  async type(locator, text, { signal } = {}) {
    if (typeof text !== 'string' || text.length > 5000) throw new CdpError('text must be a string up to 5000 chars');
    const f = await this._focus(locator, { signal });
    await this.conn.send('Input.insertText', { text }, { signal });
    return { typedChars: text.length, target: f.target };
  }

  /** Clears then fills, fires change, and READS THE VALUE BACK — success is verified, not assumed. */
  async fill(locator, text, { signal } = {}) {
    if (typeof text !== 'string' || text.length > 5000) throw new CdpError('text must be a string up to 5000 chars');
    const loc = normalizeLocator(locator);
    const f = await this._focus(loc, { clear: true, signal });
    await this.conn.send('Input.insertText', { text }, { signal });
    const after = await this.page.evaluate(expr('fillVerify', loc, `
      const el = els[loc.index]; if (!el) return { ok: false };
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const v = 'value' in el ? el.value : el.textContent; return { ok: true, length: v.length, matches: v === ${JSON.stringify(text)} };`), { signal });
    if (!after.ok || !after.matches) throw new CdpError(`Fill verification failed: field length ${after.length ?? '?'} vs expected ${text.length}`);
    return { filledChars: text.length, verified: true, secretField: f.secret, target: f.target };
  }

  async press(key, { signal } = {}) {
    const k = KEYS[key];
    if (!k) throw new CdpError(`Unsupported key '${key}'. Supported: ${Object.keys(KEYS).join(', ')}`);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await this.conn.send('Input.dispatchKeyEvent', { ...base, type: k.text ? 'keyDown' : 'rawKeyDown', ...(k.text ? { text: k.text } : {}) }, { signal });
    await this.conn.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, { signal });
    return { pressed: key };
  }

  /** Scrolls the page (or an element into view) and reports scroll position before/after so movement is verifiable. */
  async scroll({ x = 0, y = 0, locator = null, signal } = {}) {
    if (locator) {
      const loc = normalizeLocator(locator);
      const r = await this.page.evaluate(expr('scrollTo', loc, `const el = els[loc.index]; if (!el) return { ok: false }; el.scrollIntoView({ block: 'center' }); return { ok: true, scrollY: Math.round(scrollY) };`), { signal });
      if (!r.ok) throw new CdpError('Cannot scroll: element not found');
      return { scrollY: r.scrollY };
    }
    const dx = Math.max(-20000, Math.min(20000, Number(x) || 0));
    const dy = Math.max(-20000, Math.min(20000, Number(y) || 0));
    const r = await this.page.evaluate(`/*xoft:scrollBy*/(() => { const b = { x: scrollX, y: scrollY }; scrollBy(${dx}, ${dy}); return { before: b, after: { x: scrollX, y: scrollY } }; })()`, { signal });
    return { ...r, moved: r.before.x !== r.after.x || r.before.y !== r.after.y };
  }

  /** Polls until the element reaches `state` (attached | visible | hidden | detached) or the timeout elapses. */
  async waitFor(locator, { state = 'visible', timeoutMs = 10000, intervalMs = 100, signal } = {}) {
    const loc = normalizeLocator(locator);
    if (!['attached', 'visible', 'hidden', 'detached'].includes(state)) throw new CdpError(`Invalid wait state '${state}'`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) throw new CdpError('wait aborted');
      const r = await this.page.evaluate(expr('waitProbe', loc, `const el = els[loc.index]; return { exists: !!el, visible: !!el && xVisible(el) };`), { signal });
      const ok = state === 'attached' ? r.exists : state === 'detached' ? !r.exists : state === 'visible' ? r.visible : (!r.exists || !r.visible);
      if (ok) return { state, waitedMs: timeoutMs - (deadline - Date.now()) };
      if (Date.now() >= deadline) throw new CdpError(`Timed out after ${timeoutMs}ms waiting for element to be ${state}`);
      await new Promise((res) => setTimeout(res, intervalMs));
    }
  }

  /** Visible text of an element (or the whole page body). Password/one-time-code fields are never read. */
  async getText(locator = null, { maxChars = 20000, signal } = {}) {
    const cap = Math.min(Math.max(1, maxChars), 100000);
    if (!locator) return this.page.evaluate(`/*xoft:pageText*/(() => { const t = (document.body ? document.body.innerText : ''); return { text: t.slice(0, ${cap}), truncated: t.length > ${cap} }; })()`, { signal });
    const loc = normalizeLocator(locator);
    const r = await this.page.evaluate(expr('text', loc, `const el = els[loc.index]; if (!el) return { ok: false }; if (xSecret(el)) return { ok: true, text: '[redacted]', truncated: false }; const t = xTxt(el); return { ok: true, text: t.slice(0, ${cap}), truncated: t.length > ${cap} };`), { signal });
    if (!r.ok) throw new CdpError('Cannot read text: element not found');
    return { text: r.text, truncated: r.truncated };
  }

  async getAttribute(locator, name, { signal } = {}) {
    if (typeof name !== 'string' || !/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(name)) throw new CdpError('Invalid attribute name');
    const loc = normalizeLocator(locator);
    const r = await this.page.evaluate(expr('attr', loc, `const el = els[loc.index]; if (!el) return { ok: false }; if (xSecret(el) && ['value'].includes(${JSON.stringify(name.toLowerCase())})) return { ok: true, value: '[redacted]' }; return { ok: true, value: el.getAttribute(${JSON.stringify(name)}) };`), { signal });
    if (!r.ok) throw new CdpError('Cannot read attribute: element not found');
    return { name, value: r.value };
  }

  /** Page-coordinate rect (viewport rect + scroll offset) for an element screenshot clip. */
  async elementClip(locator, { signal } = {}) {
    const loc = normalizeLocator(locator);
    const r = await this.page.evaluate(expr('clip', loc, `const el = els[loc.index]; if (!el) return { ok: false }; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { ok: true, x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height };`), { signal });
    if (!r.ok) throw new CdpError('Cannot screenshot: element not found');
    if (r.width < 1 || r.height < 1) throw new CdpError('Cannot screenshot: element has no visible area');
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  /** Cheap fingerprint used to detect that a page really changed after an action. */
  async fingerprint({ signal } = {}) {
    return this.page.evaluate(`/*xoft:fingerprint*/({ url: location.href, title: document.title, textLen: (document.body ? document.body.innerText.length : 0), nodes: document.getElementsByTagName('*').length })`, { signal });
  }

  static changed(a, b) { return a.url !== b.url || a.title !== b.title || a.textLen !== b.textLen || a.nodes !== b.nodes; }
}

module.exports = { CdpDom, normalizeLocator, KEYS };
