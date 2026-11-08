import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Availability, Capability, EngineError, EngineEvent, EngineStatus, ErrorCode } from '../src/engines/constants.js';
import { Engine } from '../src/engines/Engine.js';
import { EngineRegistry } from '../src/engines/EngineRegistry.js';
import { EngineRouter } from '../src/engines/EngineRouter.js';
import { analyzeTask } from '../src/engines/TaskAnalyzer.js';

class FakeEngine extends Engine {
  constructor(id, caps, { available = true, weight = () => 0, health } = {}) {
    super({ id, name: id, capabilities: caps });
    this.available = available; this.weight = weight; this.customHealth = health;
  }
  async healthCheck() {
    if (this.customHealth) return this.customHealth(this);
    return { available: this.available, level: this.available ? Availability.READY : Availability.OFFLINE, status: this.available ? 'online' : 'offline', reason: this.available ? null : 'down', dependencies: {}, capabilities: this.capabilities, checkedAt: new Date().toISOString() };
  }
  routingWeight(a) { return this.weight(a); }
}
const bus = () => { const b = new EventEmitter(); b.emitEvent = (t, p) => { b.emit(t, p); b.emit('*', { type: t, payload: p }); }; return b; };
const ALL = Object.values(Capability);

test('analyzer: questions are conversational, coding goals are autonomous with required capabilities', () => {
  const q = analyzeTask({ goal: 'What is the capital of France?' });
  assert.deepEqual(q.requiredCapabilities, [Capability.CHAT]);
  assert.equal(q.simple, true);
  assert.equal(q.autonomous, false);

  const c = analyzeTask({ goal: 'Open my SocialPulse project, inspect the authentication system, find the bug, fix it, run the tests and report what you changed.' });
  assert.ok(c.requiredCapabilities.includes(Capability.CODING));
  assert.ok(c.requiredCapabilities.includes(Capability.TERMINAL));
  assert.ok(c.requiredCapabilities.includes(Capability.FILESYSTEM));
  assert.equal(c.autonomous, true);

  const b = analyzeTask({ goal: 'go to https://example.com and download the pdf' });
  assert.ok(b.requiredCapabilities.includes(Capability.BROWSER));

  const forced = analyzeTask({ goal: 'hello', requiredCapabilities: [Capability.BROWSER] });
  assert.ok(forced.requiredCapabilities.includes(Capability.BROWSER), 'explicit requirements are kept');
});

test('registry: register, duplicate rejection, health isolation, events on availability change', async () => {
  const eventBus = bus(); const seen = [];
  eventBus.on('*', (e) => seen.push(e.type));
  const reg = new EngineRegistry({ eventBus });
  const good = new FakeEngine('good', ALL);
  const broken = new FakeEngine('broken', ALL, { health: () => { throw new Error('boom'); } });
  reg.register(good); reg.register(broken);
  assert.throws(() => reg.register(new FakeEngine('good', [])), /already registered/);
  assert.throws(() => reg.get('nope'), (e) => e.code === ErrorCode.NOT_FOUND);

  await reg.refreshAll();
  assert.equal(reg.health('good').available, true);
  assert.equal(reg.health('broken').available, false, 'a throwing health check becomes an unavailable record, not an exception');
  assert.equal(reg.health('broken').level, Availability.ERROR);
  assert.ok(seen.includes(EngineEvent.ENGINE_READY));
  assert.ok(seen.includes(EngineEvent.ENGINE_ERROR));

  good.available = false; await reg.refresh('good');
  assert.ok(seen.includes(EngineEvent.ENGINE_OFFLINE));
  assert.equal(reg.list().length, 2);
});

test('registry: a hung health check times out instead of blocking', async () => {
  const reg = new EngineRegistry({ healthTimeoutMs: 50 });
  reg.register(new FakeEngine('slow', ALL, { health: () => new Promise(() => {}) }));
  const h = await reg.refresh('slow');
  assert.equal(h.available, false);
  assert.match(h.reason, /timed out/);
});

test('router: simple question → core; autonomous coding → hermes; explanations are returned', async () => {
  const reg = new EngineRegistry();
  reg.register(new FakeEngine('xoft-core', ALL, { weight: (a) => (a.simple ? 30 : -10) }), { priority: 60 });
  reg.register(new FakeEngine('hermes', ALL, { weight: (a) => (a.autonomous ? 25 : a.simple ? -30 : 0) }), { priority: 50 });
  const router = new EngineRouter({ registry: reg });
  const simple = await router.select({ goal: 'What is a closure in JavaScript?' });
  assert.equal(simple.engineId, 'xoft-core');
  const coding = await router.select({ goal: 'Open my project, find the auth bug, fix it, run the tests, then report what you changed.', workingDirectory: '/p' });
  assert.equal(coding.engineId, 'hermes');
  assert.ok(coding.reason.includes('hermes'));
  assert.ok(coding.candidates.every((c) => Array.isArray(c.reasons)));
});

test('router: unavailable engine is skipped; requested-but-down engine falls back with a reason, event and audit', async () => {
  const eventBus = bus(); const events = []; eventBus.on('*', (e) => events.push(e.type));
  const logs = []; const activityLog = { log: (e) => logs.push(e) };
  const reg = new EngineRegistry({ eventBus, activityLog });
  const hermes = new FakeEngine('hermes', ALL, { available: false });
  reg.register(new FakeEngine('xoft-core', ALL), { priority: 60 }); reg.register(hermes, { priority: 50 });
  const router = new EngineRouter({ registry: reg, eventBus, activityLog });

  const auto = await router.select({ goal: 'Fix the failing tests in my repo and run them again', workingDirectory: '/p' });
  assert.equal(auto.engineId, 'xoft-core');

  const asked = await router.select({ goal: 'Fix the failing tests', workingDirectory: '/p' }, { preferredEngine: 'hermes' });
  assert.equal(asked.engineId, 'xoft-core');
  assert.equal(asked.fallbackFrom, 'hermes');
  assert.match(asked.reason, /unavailable/);
  assert.ok(events.includes(EngineEvent.ENGINE_FALLBACK));
  assert.ok(logs.some((l) => l.type === 'engine_fallback'));

  await assert.rejects(() => router.select({ goal: 'Fix tests', workingDirectory: '/p' }, { preferredEngine: 'hermes', allowFallback: false }), (e) => e.code === ErrorCode.UNAVAILABLE && /hermes/.test(e.message));
  await assert.rejects(() => router.select({ goal: 'x' }, { preferredEngine: 'ghost' }), (e) => e.code === ErrorCode.NOT_FOUND);
});

test('router: capability requirements decide; nothing compatible → clear UNAVAILABLE with per-engine reasons', async () => {
  const reg = new EngineRegistry();
  reg.register(new FakeEngine('chat-only', [Capability.CHAT]), { priority: 90 });
  reg.register(new FakeEngine('agent', [Capability.CHAT, Capability.BROWSER, Capability.FILESYSTEM]), { priority: 10 });
  const router = new EngineRouter({ registry: reg });
  const d = await router.select({ goal: 'go to https://example.com and click the login button' });
  assert.equal(d.engineId, 'agent');

  const reg2 = new EngineRegistry(); reg2.register(new FakeEngine('chat-only', [Capability.CHAT]));
  await assert.rejects(() => new EngineRouter({ registry: reg2 }).select({ goal: 'go to https://example.com and click login' }), (e) => e.code === ErrorCode.UNAVAILABLE && e.details.candidates[0].reasons.join().includes('lacks capability'));
});

test('router: partial availability — an engine whose browser dependency is down still serves non-browser work', async () => {
  class Partial extends FakeEngine {
    canServe(a, h) { if (!h.available) return false; if (a.requiredCapabilities.includes(Capability.BROWSER) && h.dependencies.browser === false) return false; return this.supportsAll(a.requiredCapabilities); }
  }
  const reg = new EngineRegistry();
  reg.register(new Partial('hermes', ALL, { health: () => ({ available: true, level: Availability.PARTIAL, status: 'online', reason: 'browser backend down', dependencies: { browser: false, runtime: true }, capabilities: ALL, checkedAt: '' }) }));
  const router = new EngineRouter({ registry: reg });
  assert.equal((await router.select({ goal: 'Refactor the module and run the unit tests', workingDirectory: '/p' })).engineId, 'hermes');
  await assert.rejects(() => router.select({ goal: 'open the website https://example.com and click the button' }), (e) => e.code === ErrorCode.UNAVAILABLE);
});

test('Engine base: stream() yields events then the result; unsupported operations throw NOT_SUPPORTED', async () => {
  class Streamy extends Engine {
    async execute(task, ctx) { ctx.onEvent({ type: 'a' }); await new Promise((r) => setTimeout(r, 5)); ctx.onEvent({ type: 'b' }); return { status: 'completed', output: 'ok' }; }
  }
  const e = new Streamy({ id: 's', name: 's' });
  const got = [];
  for await (const ev of e.stream({ id: 't' })) got.push(ev.type);
  assert.deepEqual(got, ['a', 'b', 'result']);
  await assert.rejects(() => e.cancel({}), (err) => err.code === ErrorCode.NOT_SUPPORTED);
  await assert.rejects(() => e.pause({}), (err) => err.code === ErrorCode.NOT_SUPPORTED);
  await assert.rejects(() => e.resume({}), (err) => err.code === ErrorCode.NOT_SUPPORTED);
  const statuses = []; e.onStatusChange((c) => statuses.push(c.status)); e.setStatus(EngineStatus.ONLINE); e.setStatus(EngineStatus.ONLINE); e.setActiveTasks(1); e.setActiveTasks(0);
  assert.deepEqual(statuses, ['online', 'busy', 'online']);
});
