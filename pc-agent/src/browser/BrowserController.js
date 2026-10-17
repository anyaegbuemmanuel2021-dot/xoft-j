'use strict';
const path = require('node:path');
const { CdpClient } = require('./cdp-client');
const { CdpPage } = require('./cdp-page');
const { CdpDom } = require('./cdp-dom');
const { CdpError } = require('./cdp-connection');
const { checkUrl } = require('./url-policy');
const { launchChrome } = require('./chrome-launcher');

const MAX_SCREENSHOT_B64 = 12 * 1024 * 1024;
const isConnectionLoss = (err) => err instanceof CdpError && /not open|connection closed|Cannot reach browser|Connection closed/i.test(err.message);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * BrowserController — the AI-facing browser surface (browser.* tools). Backend = CDP
 * (see ./cdp-*.js); the backend is replaceable because callers only see these methods.
 *
 * Safety properties:
 *  - every action first calls guard.assertAllowed('browser.<action>') (permissions/halt live outside this class)
 *  - navigation goes through url-policy
 *  - there is NO arbitrary-JS method; page scripts are fixed and parameterized
 *  - connection loss triggers at most `maxRecoveries` reattach attempts, then a clear failure
 *
 * Every method returns { success, data?, error?, verification? } like the existing executors.
 */
class BrowserController {
  constructor({
    host = '127.0.0.1', port = 9222, fetchImpl, WebSocketImpl, guard = { assertAllowed() {} }, policy = {},
    profileDir = path.join(process.cwd(), '.xoft', 'browser-profile'), autoLaunch = false, launchImpl = launchChrome,
    maxRecoveries = 2, recoveryDelayMs = 300, settleMs = 250, launchWaitMs = 10000, logger = console,
  } = {}) {
    this.client = new CdpClient({ host, port, fetchImpl, WebSocketImpl });
    this.port = port;
    this.guard = guard;
    this.policy = policy;
    this.profileDir = profileDir;
    this.autoLaunch = autoLaunch;
    this.launchImpl = launchImpl;
    this.maxRecoveries = maxRecoveries;
    this.recoveryDelayMs = recoveryDelayMs;
    this.settleMs = settleMs;
    this.launchWaitMs = launchWaitMs;
    this.logger = logger;
    this._session = null; // { targetId, conn, page, dom }
    this._launched = null;
  }

  status() {
    return { attachedTabId: this._session?.targetId ?? null, connected: Boolean(this._session?.conn?.isOpen), port: this.port, launchedByXoft: Boolean(this._launched) };
  }

  async _ensureBrowser() {
    try { await this.client.version(); return; } catch (err) {
      if (!this.autoLaunch) throw err;
    }
    this._launched = this.launchImpl({ port: this.port, profileDir: this.profileDir });
    const deadline = Date.now() + this.launchWaitMs;
    for (;;) {
      try { await this.client.version(); return; } catch (err) {
        if (Date.now() > deadline) throw new CdpError(`Launched browser did not open its debugging port within ${this.launchWaitMs}ms`);
        await sleep(200);
      }
    }
  }

  async _attach(targetId) {
    this._detach();
    const { connection, page } = await this.client.attach(targetId);
    const cdpPage = new CdpPage(connection);
    await cdpPage.enable();
    connection.on('close', () => { if (this._session?.conn === connection) this._session.closed = true; });
    this._session = { targetId: page.id, conn: connection, page: cdpPage, dom: new CdpDom(cdpPage) };
    return page;
  }

  _detach() { try { this._session?.conn.close(); } catch { /* ignore */ } this._session = null; }

  async _ensureSession() {
    if (this._session?.conn.isOpen) return this._session;
    await this._ensureBrowser();
    const pages = await this.client.listPages();
    if (!pages.length) throw new CdpError('The browser has no open page tabs');
    const wanted = this._session?.targetId && pages.find((p) => p.id === this._session.targetId) ? this._session.targetId : pages[0].id;
    await this._attach(wanted);
    return this._session;
  }

  /** Runs fn(session) with guard check + bounded recovery on connection loss. */
  async _run(action, fn) {
    try { this.guard.assertAllowed(`browser.${action}`); } catch (err) { return { success: false, error: err.message, blocked: true }; }
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRecoveries; attempt++) {
      try {
        const session = await this._ensureSession();
        const out = await fn(session);
        return { success: true, ...out };
      } catch (err) {
        lastErr = err;
        if (!isConnectionLoss(err) || attempt === this.maxRecoveries) break;
        this.logger.warn?.(`[browser] ${action}: connection lost (${err.message}); recovery ${attempt + 1}/${this.maxRecoveries}`);
        this._detach();
        await sleep(this.recoveryDelayMs * (attempt + 1));
      }
    }
    return { success: false, error: lastErr?.message ?? 'browser action failed', recoveryExhausted: isConnectionLoss(lastErr) };
  }

  // --- tabs ---
  listTabs() {
    return this._run('list_tabs', async () => {
      const tabs = await this.client.listPages();
      return { data: { tabs: tabs.map(({ id, title, url }) => ({ id, title, url, attached: id === this._session?.targetId })) }, verification: { verified: true, evidence: { source: 'CDP /json/list' } } };
    });
  }

  attachTab(targetId) {
    try { this.guard.assertAllowed('browser.attach_tab'); } catch (err) { return Promise.resolve({ success: false, error: err.message, blocked: true }); }
    return (async () => {
      try {
        await this._ensureBrowser();
        const page = await this._attach(targetId);
        await this.client.activatePage(targetId).catch(() => {});
        return { success: true, data: { tab: { id: page.id, title: page.title, url: page.url } }, verification: { verified: true, evidence: { source: 'CDP attach + Page/Runtime/DOM enable' } } };
      } catch (err) { return { success: false, error: err.message }; }
    })();
  }

  newTab(url = 'about:blank') {
    const p = checkUrl(url, this.policy);
    if (!p.ok) return Promise.resolve({ success: false, error: p.reason });
    return this._run('new_tab', async () => {
      await this._ensureBrowser();
      const t = await this.client.newPage(p.url);
      await this._attach(t.id);
      return { data: { tab: { id: t.id, url: t.url } }, verification: { verified: true, evidence: { source: 'CDP /json/new + attach' } } };
    });
  }

  // --- navigation ---
  navigate(url) {
    const p = checkUrl(url, this.policy);
    if (!p.ok) { this.guard.audit?.('browser.navigate.denied', { url, reason: p.reason }); return Promise.resolve({ success: false, error: p.reason }); }
    return this._run('navigate', async ({ page }) => {
      const info = await page.navigate(p.url);
      const sameHost = (() => { try { return new URL(info.url).hostname === new URL(p.url).hostname; } catch { return false; } })();
      return { data: info, verification: { verified: true, evidence: { requested: p.url, finalUrl: info.url, redirectedToDifferentHost: !sameHost, readyState: info.readyState } } };
    });
  }
  back() { return this._run('back', async ({ page }) => ({ data: await page.history(-1), verification: { verified: true, evidence: { source: 'navigation history entry loaded' } } })); }
  forward() { return this._run('forward', async ({ page }) => ({ data: await page.history(1), verification: { verified: true, evidence: { source: 'navigation history entry loaded' } } })); }
  reload() { return this._run('reload', async ({ page }) => ({ data: await page.reload(), verification: { verified: true, evidence: { source: 'load event after reload' } } })); }

  // --- inspection ---
  getPage() {
    return this._run('get_page', async ({ page, dom }) => {
      const [info, snap] = await Promise.all([page.info(), dom.snapshot({ limit: 1 })]);
      return { data: { ...info, counts: snap.counts }, verification: { verified: true, evidence: { source: 'Runtime.evaluate' } } };
    });
  }
  getDom(opts = {}) { return this._run('get_dom', async ({ dom }) => ({ data: await dom.snapshot(opts), verification: { verified: true, evidence: { source: 'DOM snapshot (secrets redacted)' } } })); }
  querySelector(locator, opts = {}) { return this._run('query_selector', async ({ dom }) => ({ data: await dom.query(locator, opts), verification: { verified: true, evidence: { source: 'document.querySelectorAll' } } })); }
  getText(locator = null, opts = {}) { return this._run('get_text', async ({ dom }) => ({ data: await dom.getText(locator, opts), verification: { verified: true, evidence: { source: 'innerText (secrets redacted)' } } })); }
  getAttribute(locator, name) { return this._run('get_attribute', async ({ dom }) => ({ data: await dom.getAttribute(locator, name), verification: { verified: true, evidence: { source: 'getAttribute' } } })); }

  // --- interaction ---
  click(locator, opts = {}) {
    return this._run('click', async ({ dom }) => {
      const before = await dom.fingerprint();
      const r = await dom.click(locator, opts);
      await sleep(this.settleMs);
      const after = await dom.fingerprint();
      const pageChanged = CdpDom.changed(before, after);
      return { data: { ...r, pageChanged }, verification: { verified: true, evidence: { dispatched: 'mousePressed+mouseReleased', pageChanged, note: pageChanged ? 'page state changed after click' : 'input dispatched; no page change observed (may be expected)' } } };
    });
  }
  type(locator, text) { return this._run('type', async ({ dom }) => ({ data: await dom.type(locator, text), verification: { verified: false, evidence: { note: 'characters dispatched; use fill for read-back verification' } } })); }
  fill(locator, text) { return this._run('fill', async ({ dom }) => { const r = await dom.fill(locator, text); return { data: r, verification: { verified: true, evidence: { source: 'value read back after fill', secretField: r.secretField } } }; }); }
  press(key) { return this._run('press', async ({ dom }) => ({ data: await dom.press(key), verification: { verified: false, evidence: { note: 'key events dispatched' } } })); }
  scroll(opts = {}) { return this._run('scroll', async ({ dom }) => { const r = await dom.scroll(opts); return { data: r, verification: { verified: true, evidence: r } }; }); }
  waitFor(locator, opts = {}) { return this._run('wait_for', async ({ dom }) => ({ data: await dom.waitFor(locator, opts), verification: { verified: true, evidence: { source: 'polled element state' } } })); }
  waitForNavigation(opts = {}) { return this._run('wait_for_navigation', async ({ page }) => ({ data: await page.waitForNavigation(opts), verification: { verified: true, evidence: { source: 'Page.frameNavigated' } } })); }

  // --- screenshots ---
  screenshot({ fullPage = false } = {}) {
    return this._run('screenshot', async ({ page }) => {
      const base64 = await page.screenshot({ fullPage });
      if (base64.length > MAX_SCREENSHOT_B64) throw new CdpError('Screenshot too large to return; try an element screenshot');
      return { data: { mimeType: 'image/png', base64, fullPage }, verification: { verified: true, evidence: { source: 'Page.captureScreenshot', bytesBase64: base64.length } } };
    });
  }
  elementScreenshot(locator) {
    return this._run('element_screenshot', async ({ page, dom }) => {
      const clip = await dom.elementClip(locator);
      const base64 = await page.screenshot({ clip });
      if (base64.length > MAX_SCREENSHOT_B64) throw new CdpError('Screenshot too large to return');
      return { data: { mimeType: 'image/png', base64, clip }, verification: { verified: true, evidence: { source: 'Page.captureScreenshot with element clip' } } };
    });
  }

  /** Watchdog hook: is the backend reachable and are we attached? Never throws. */
  async health() {
    try { const v = await this.client.version(); return { ok: true, browser: v.Browser ?? null, attached: this.status().connected }; }
    catch (err) { return { ok: false, error: err.message, attached: false }; }
  }

  close() { this._detach(); }
}

module.exports = { BrowserController };
