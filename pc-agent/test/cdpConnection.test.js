'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CdpConnection, CdpError } = require('../src/browser/cdp-connection');
const { CdpClient } = require('../src/browser/cdp-client');
const { makeFakeWebSocket, makeFakeFetch } = require('./helpers/fakeCdp');

const open = async (handler, opts = {}) => {
  const WS = makeFakeWebSocket(handler);
  const c = new CdpConnection({ url: 'ws://127.0.0.1:9222/devtools/page/X', WebSocketImpl: WS, ...opts });
  await c.connect();
  return { c, ws: WS.instances[0] };
};

test('correlates responses to command ids even when replies arrive out of order', async () => {
  const { c } = await open({ respond: async (m, p) => { if (m === 'Slow.one') await new Promise((r) => setTimeout(r, 30)); return { m }; } });
  const [a, b] = await Promise.all([c.send('Slow.one'), c.send('Fast.two')]);
  assert.equal(a.m, 'Slow.one');
  assert.equal(b.m, 'Fast.two');
});

test('command ids are unique and increasing', async () => {
  const { c, ws } = await open({ respond: async () => ({}) });
  await c.send('A.a'); await c.send('B.b'); await c.send('C.c');
  const ids = ws.sent.map((m) => m.id);
  assert.deepEqual(ids, [1, 2, 3]);
});

test('protocol errors reject with CdpError carrying code and method', async () => {
  const { c } = await open({ respond: async () => { const e = new Error('No node'); e.code = -32000; throw e; } });
  await assert.rejects(c.send('DOM.getDocument'), (e) => e instanceof CdpError && e.code === -32000 && e.method === 'DOM.getDocument');
});

test('a hung command times out and a late reply is ignored', async () => {
  const { c } = await open({ silent: new Set(['Page.hang']), respond: async () => ({}) }, { commandTimeoutMs: 40 });
  await assert.rejects(c.send('Page.hang'), /timed out/);
  assert.deepEqual(await c.send('Page.ok'), {}); // connection still healthy afterwards
});

test('AbortSignal cancels an in-flight command', async () => {
  const { c } = await open({ silent: new Set(['Page.hang']), respond: async () => ({}) });
  const ctl = new AbortController();
  const p = c.send('Page.hang', {}, { signal: ctl.signal });
  ctl.abort();
  await assert.rejects(p, /aborted/);
});

test('events are emitted by method name and waitForEvent resolves', async () => {
  const { c, ws } = await open({ respond: async () => ({}) });
  const waiting = c.waitForEvent('Page.loadEventFired', { timeoutMs: 500 });
  ws.emit('Page.loadEventFired', { timestamp: 1 });
  assert.deepEqual(await waiting, { timestamp: 1 });
});

test('waitForEvent times out cleanly and removes its listener', async () => {
  const { c } = await open({ respond: async () => ({}) });
  await assert.rejects(c.waitForEvent('Never.happens', { timeoutMs: 30 }), /Timed out/);
  assert.equal(c.listenerCount('Never.happens'), 0);
});

test('closing rejects all pending commands and further sends fail fast', async () => {
  const { c } = await open({ silent: new Set(['Page.hang']), respond: async () => ({}) });
  const p = c.send('Page.hang');
  c.close();
  await assert.rejects(p, /closed/);
  await assert.rejects(c.send('Any.thing'), /not open/);
});

test('connect failure rejects instead of hanging', async () => {
  const WS = makeFakeWebSocket({ refuseConnect: true, respond: async () => ({}) });
  const c = new CdpConnection({ url: 'ws://127.0.0.1:1/x', WebSocketImpl: WS, connectTimeoutMs: 200 });
  await assert.rejects(c.connect(), /connect failed/);
});

test('CdpClient refuses non-loopback hosts (security)', () => {
  assert.throws(() => new CdpClient({ host: '192.168.1.20' }), /non-loopback/);
  assert.throws(() => new CdpClient({ host: 'example.com' }), /non-loopback/);
  assert.doesNotThrow(() => new CdpClient({ host: '127.0.0.1', fetchImpl: async () => {} }));
});

test('CdpClient lists only real page targets', async () => {
  const fetchImpl = makeFakeFetch({ '/json/list': [
    { id: 'A', type: 'page', title: 'Home', url: 'https://a.test/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/A' },
    { id: 'B', type: 'service_worker', title: 'sw', url: 'https://a.test/sw.js' },
    { id: 'C', type: 'page', title: 'DevTools', url: 'devtools://devtools/x' },
  ] });
  const pages = await new CdpClient({ fetchImpl }).listPages();
  assert.deepEqual(pages.map((p) => p.id), ['A']);
});

test('CdpClient.attach fails clearly on a stale tab id and connects on a valid one', async () => {
  const fetchImpl = makeFakeFetch({ '/json/list': [{ id: 'A', type: 'page', url: 'https://a.test/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/A' }] });
  const WebSocketImpl = makeFakeWebSocket({ respond: async () => ({}) });
  const client = new CdpClient({ fetchImpl, WebSocketImpl });
  await assert.rejects(client.attach('ZZZ'), /stale/);
  const { connection, page } = await client.attach('A');
  assert.equal(page.id, 'A');
  assert.ok(connection.isOpen);
});

test('CdpClient reports an unreachable endpoint honestly', async () => {
  const client = new CdpClient({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(client.listPages(), /Cannot reach browser debugging endpoint/);
});
