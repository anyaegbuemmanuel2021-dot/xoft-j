'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BrowserController } = require('../src/browser/BrowserController');
const { checkUrl } = require('../src/browser/url-policy');
const { buildLaunchArgs, findChrome } = require('../src/browser/chrome-launcher');
const { makeFakeWebSocket, makeFakeFetch } = require('./helpers/fakeCdp');

function fakeBrowser(cfg = {}) {
  const state = {
    url: 'https://a.test/', title: 'A', mouse: [], keys: [], inserted: [], evalTags: [],
    fp: { url: 'https://a.test/', title: 'A', textLen: 10, nodes: 5 },
    prep: { ok: true, x: 100, y: 50, covered: false, target: { tag: 'button' } },
    fillVerify: { ok: true, length: 3, matches: true }, clickChangesPage: true, closeOn: null, closeCount: 0,
    pages: [{ id: 'T1', type: 'page', title: 'A', url: 'https://a.test/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/T1' }],
    ...cfg,
  };
  const handler = {
    respond: async (method, params, ws) => {
      switch (method) {
        case 'Page.enable': case 'Runtime.enable': case 'DOM.enable': return {};
        case 'Page.navigate': state.url = params.url; setTimeout(() => ws.emit('Page.loadEventFired', {}), 1); return { frameId: 'F' };
        case 'Page.captureScreenshot': state.lastShot = params; return { data: 'UE5HREFUQQ==' };
        case 'Page.getLayoutMetrics': return { cssContentSize: { width: 800, height: 2400 } };
        case 'Input.dispatchMouseEvent':
          state.mouse.push(params);
          if (params.type === 'mousePressed' && state.clickChangesPage) state.fp = { ...state.fp, nodes: state.fp.nodes + 3 };
          return {};
        case 'Input.insertText': state.inserted.push(params.text); return {};
        case 'Input.dispatchKeyEvent': state.keys.push(params); return {};
        case 'Runtime.evaluate': {
          const tag = /\/\*xoft:(\w+)\*\//.exec(params.expression)?.[1] ?? 'info';
          state.evalTags.push(tag);
          if (state.closeOn === tag && state.closeCount++ < (cfg.closeTimes ?? 1)) { ws.close(); return new Promise(() => {}); }
          const v = { info: { url: state.url, title: state.title, readyState: 'complete' }, fingerprint: state.fp, prepClick: state.prep,
            focus: { ok: true, secret: false, target: { tag: 'input' } }, fillVerify: state.fillVerify,
            query: { count: 1, items: [{ tag: 'a' }] }, snapshot: { url: state.url, title: state.title, counts: { links: 1, buttons: 0, forms: 0, inputs: 0 }, interactive: [], forms: [] },
            clip: { ok: true, x: 10, y: 20, width: 100, height: 40 }, scrollBy: { before: { x: 0, y: 0 }, after: { x: 0, y: 300 } } }[tag];
          return { result: { value: v } };
        }
        default: throw new Error(`unscripted CDP method ${method}`);
      }
    },
  };
  const WebSocketImpl = makeFakeWebSocket(handler);
  const fetchImpl = makeFakeFetch({ '/json/version': { Browser: 'Chrome/FAKE' }, '/json/list': () => state.pages, '/json/activate/T1': {}, '/json/new': { id: 'T2', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/T2' } });
  const guardLog = [];
  const guard = { assertAllowed: (a) => { guardLog.push(a); if (cfg.deny?.has(a)) throw new Error(`denied: ${a}`); } };
  const b = new BrowserController({ fetchImpl, WebSocketImpl, guard, recoveryDelayMs: 1, settleMs: 1, logger: { warn() {} }, ...(cfg.ctl ?? {}) });
  return { b, state, WebSocketImpl, guardLog, fetchImpl };
}

test('list tabs then attach; auto-attaches to first tab when none attached', async () => {
  const { b } = fakeBrowser();
  const r = await b.listTabs();
  assert.equal(r.success, true);
  assert.deepEqual(r.data.tabs.map((t) => t.id), ['T1']);
  const a = await b.attachTab('T1');
  assert.equal(a.success, true);
  assert.equal(b.status().attachedTabId, 'T1');
});

test('attaching a stale tab id fails honestly', async () => {
  const { b } = fakeBrowser();
  const a = await b.attachTab('NOPE');
  assert.equal(a.success, false);
  assert.match(a.error, /stale/);
});

test('navigate waits for load and verifies final URL', async () => {
  const { b, state } = fakeBrowser();
  const r = await b.navigate('https://example.org/x');
  assert.equal(r.success, true);
  assert.equal(state.url, 'https://example.org/x');
  assert.equal(r.verification.evidence.finalUrl, 'https://example.org/x');
});

test('navigation policy blocks dangerous schemes, credentials and blocked hosts before touching the browser', async () => {
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'data:text/html,hi', 'https://user:pw@a.test/', 'not a url']) {
    assert.equal(checkUrl(bad).ok, false, bad);
  }
  assert.equal(checkUrl('https://evil.test/', { blockedHosts: ['evil.test'] }).ok, false);
  assert.equal(checkUrl('https://sub.evil.test/', { blockedHosts: ['evil.test'] }).ok, false);
  assert.equal(checkUrl('https://ok.test/', { allowedHosts: ['other.test'] }).ok, false);
  assert.equal(checkUrl('https://ok.test/').ok, true);
  const { b, state } = fakeBrowser();
  const r = await b.navigate('file:///etc/passwd');
  assert.equal(r.success, false);
  assert.notEqual(state.url, 'file:///etc/passwd');
});

test('click dispatches move+press+release at the element center and reports whether the page changed', async () => {
  const { b, state } = fakeBrowser();
  const r = await b.click({ selector: '#go' });
  assert.equal(r.success, true);
  assert.deepEqual(state.mouse.map((m) => m.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.equal(state.mouse[1].x, 100);
  assert.equal(r.data.pageChanged, true);
});

test('click reports pageChanged=false honestly when nothing changed', async () => {
  const { b } = fakeBrowser({ clickChangesPage: false });
  const r = await b.click({ selector: '#go' });
  assert.equal(r.success, true);
  assert.equal(r.data.pageChanged, false);
});

test('click refuses covered elements unless forced, and never sends input when refused', async () => {
  const { b, state } = fakeBrowser({ prep: { ok: true, x: 1, y: 1, covered: true, coveredBy: 'div', target: {} } });
  const r = await b.click({ selector: '#go' });
  assert.equal(r.success, false);
  assert.match(r.error, /covered by <div>/);
  assert.equal(state.mouse.length, 0);
  assert.equal((await b.click({ selector: '#go' }, { force: true })).success, true);
});

test('fill reads the value back and fails if the field does not hold the text', async () => {
  const ok = fakeBrowser();
  const r = await ok.b.fill({ selector: '#q' }, 'abc');
  assert.equal(r.success, true);
  assert.equal(r.verification.verified, true);
  assert.deepEqual(ok.state.inserted, ['abc']);
  const bad = fakeBrowser({ fillVerify: { ok: true, length: 0, matches: false } });
  const f = await bad.b.fill({ selector: '#q' }, 'abc');
  assert.equal(f.success, false);
  assert.match(f.error, /verification failed/);
});

test('locators are validated: exactly one of selector/text, bounded length', async () => {
  const { b } = fakeBrowser();
  assert.equal((await b.querySelector({})).success, false);
  assert.equal((await b.querySelector({ selector: 'a', text: 'b' })).success, false);
  assert.equal((await b.querySelector({ selector: 'x'.repeat(501) })).success, false);
  assert.equal((await b.querySelector({ selector: 'a' })).success, true);
});

test('press rejects unsupported keys and sends keyDown/keyUp for supported ones', async () => {
  const { b, state } = fakeBrowser();
  assert.equal((await b.press('F13')).success, false);
  assert.equal((await b.press('Enter')).success, true);
  assert.deepEqual(state.keys.map((k) => k.type), ['keyDown', 'keyUp']);
});

test('full-page screenshot clips to real content size; element screenshot uses element clip', async () => {
  const { b, state } = fakeBrowser();
  assert.equal((await b.screenshot({ fullPage: true })).success, true);
  assert.deepEqual(state.lastShot.clip, { x: 0, y: 0, width: 800, height: 2400, scale: 1 });
  const e = await b.elementScreenshot({ selector: '#hero' });
  assert.equal(e.success, true);
  assert.deepEqual(state.lastShot.clip, { x: 10, y: 20, width: 100, height: 40, scale: 1 });
});

test('scroll reports movement from real before/after positions', async () => {
  const { b } = fakeBrowser();
  const r = await b.scroll({ y: 300 });
  assert.equal(r.success, true);
  assert.equal(r.data.moved, true);
});

test('guard denial blocks the action before any browser contact', async () => {
  const { b, state } = fakeBrowser({ deny: new Set(['browser.click']) });
  const r = await b.click({ selector: '#go' });
  assert.equal(r.success, false);
  assert.equal(r.blocked, true);
  assert.equal(state.mouse.length, 0);
});

test('connection loss triggers reattach + retry and then succeeds', async () => {
  const { b, WebSocketImpl } = fakeBrowser({ closeOn: 'query', closeTimes: 1 });
  const r = await b.querySelector({ selector: 'a' });
  assert.equal(r.success, true);
  assert.equal(WebSocketImpl.instances.length, 2); // original + one recovery
});

test('recovery is bounded: persistent loss fails after maxRecoveries, no infinite loop', async () => {
  const { b, WebSocketImpl } = fakeBrowser({ closeOn: 'query', closeTimes: 99, ctl: { maxRecoveries: 2 } });
  const r = await b.querySelector({ selector: 'a' });
  assert.equal(r.success, false);
  assert.equal(r.recoveryExhausted, true);
  assert.equal(WebSocketImpl.instances.length, 3);
});

test('autoLaunch starts the browser when the debug port is down, then waits for it', async () => {
  let up = false; let launched = 0;
  const { WebSocketImpl } = fakeBrowser();
  const fetchImpl = async (url) => {
    if (!up) throw new Error('ECONNREFUSED');
    const p = new URL(url).pathname;
    const body = p === '/json/version' ? { Browser: 'Chrome/FAKE' } : [{ id: 'T1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/T1' }];
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const state = fakeBrowser();
  const b = new BrowserController({ fetchImpl, WebSocketImpl: state.WebSocketImpl, autoLaunch: true, launchWaitMs: 2000, recoveryDelayMs: 1, logger: { warn() {} },
    launchImpl: () => { launched++; setTimeout(() => { up = true; }, 50); return { pid: 1 }; } });
  const r = await b.listTabs();
  assert.equal(r.success, true);
  assert.equal(launched, 1);
  assert.equal(b.status().launchedByXoft, true);
});

test('without autoLaunch an unreachable browser is reported, never launched', async () => {
  let launched = 0;
  const b = new BrowserController({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, launchImpl: () => { launched++; }, logger: { warn() {} }, recoveryDelayMs: 1 });
  const r = await b.listTabs();
  assert.equal(r.success, false);
  assert.match(r.error, /Cannot reach browser debugging endpoint/);
  assert.equal(launched, 0);
});

test('launch args bind debugging to loopback with a dedicated profile', () => {
  const args = buildLaunchArgs({ port: 9333, profileDir: '/tmp/prof' });
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(args.includes('--user-data-dir=/tmp/prof'));
  assert.throws(() => buildLaunchArgs({ port: 9333 }), /profileDir/);
  assert.equal(findChrome({ platform: 'linux', env: {}, exists: (p) => p === '/usr/bin/chromium' }), '/usr/bin/chromium');
  assert.equal(findChrome({ platform: 'linux', env: {}, exists: () => false }), null);
});
