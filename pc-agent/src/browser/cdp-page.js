'use strict';
const { CdpError } = require('./cdp-connection');

/**
 * CdpPage — Page/Runtime-level operations on one attached tab: navigation, history,
 * page info, screenshots. Works only through CdpConnection.send/waitForEvent.
 * `evaluate` is INTERNAL: BrowserController never exposes it as an AI-facing tool.
 */
class CdpPage {
  constructor(connection, { defaultTimeoutMs = 15000 } = {}) {
    this.conn = connection;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async enable() {
    await this.conn.send('Page.enable');
    await this.conn.send('Runtime.enable');
    await this.conn.send('DOM.enable');
  }

  async evaluate(expression, { signal, timeoutMs } = {}) {
    const res = await this.conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, { signal, timeoutMs });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new CdpError(`Page script error: ${d.exception?.description ?? d.text ?? 'unknown'}`, { method: 'Runtime.evaluate' });
    }
    return res.result?.value;
  }

  /** Navigates and waits for the load event. The listener is registered BEFORE the command to avoid a race. */
  async navigate(url, { timeoutMs = this.defaultTimeoutMs, signal } = {}) {
    const loaded = this.conn.waitForEvent('Page.loadEventFired', { timeoutMs, signal });
    loaded.catch(() => {}); // avoid unhandled rejection if navigate() itself fails first
    const res = await this.conn.send('Page.navigate', { url }, { signal });
    if (res.errorText) throw new CdpError(`Navigation failed: ${res.errorText}`, { method: 'Page.navigate' });
    await loaded;
    return this.info();
  }

  async reload({ timeoutMs = this.defaultTimeoutMs, signal } = {}) {
    const loaded = this.conn.waitForEvent('Page.loadEventFired', { timeoutMs, signal });
    loaded.catch(() => {});
    await this.conn.send('Page.reload', {}, { signal });
    await loaded;
    return this.info();
  }

  /** delta = -1 (back) or +1 (forward). Fails honestly when there is no such history entry. */
  async history(delta, { timeoutMs = this.defaultTimeoutMs, signal } = {}) {
    const { currentIndex, entries } = await this.conn.send('Page.getNavigationHistory', {}, { signal });
    const target = entries[currentIndex + delta];
    if (!target) throw new CdpError(delta < 0 ? 'No previous history entry' : 'No next history entry');
    const loaded = this.conn.waitForEvent('Page.loadEventFired', { timeoutMs, signal });
    loaded.catch(() => {});
    await this.conn.send('Page.navigateToHistoryEntry', { entryId: target.id }, { signal });
    await loaded;
    return this.info();
  }

  /** Waits for the next main-frame navigation (e.g. after a click that submits a form). */
  async waitForNavigation({ timeoutMs = this.defaultTimeoutMs, signal } = {}) {
    await this.conn.waitForEvent('Page.frameNavigated', { timeoutMs, signal, predicate: (p) => !p.frame?.parentId });
    return this.info();
  }

  async info({ signal } = {}) {
    return this.evaluate('({url: location.href, title: document.title, readyState: document.readyState})', { signal });
  }

  /** PNG as base64. fullPage uses the page's real content size, not just the viewport. */
  async screenshot({ fullPage = false, clip = null, signal } = {}) {
    const params = { format: 'png' };
    if (clip) {
      params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
      params.captureBeyondViewport = true;
    } else if (fullPage) {
      const m = await this.conn.send('Page.getLayoutMetrics', {}, { signal });
      const size = m.cssContentSize ?? m.contentSize;
      if (!size) throw new CdpError('Could not determine page size for full-page screenshot');
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
      params.captureBeyondViewport = true;
    }
    const { data } = await this.conn.send('Page.captureScreenshot', params, { signal, timeoutMs: 30000 });
    if (!data) throw new CdpError('Browser returned an empty screenshot');
    return data;
  }
}

module.exports = { CdpPage };
