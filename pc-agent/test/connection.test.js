'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { waitForCore, createNonOverlappingTask } = require('../src/connection');

const quietLogger = { info() {}, warn() {}, error() {} };

describe('PC agent connection resilience', () => {
  test('waits for a temporarily unavailable core and succeeds when it returns', async () => {
    let probes = 0;
    const delays = [];
    const result = await waitForCore({
      probe: async () => { probes += 1; if (probes < 3) throw new Error('offline'); },
      logger: quietLogger,
      initialDelayMs: 100,
      maxDelayMs: 500,
      sleepImpl: async (ms) => delays.push(ms),
    });
    assert.equal(probes, 3);
    assert.deepEqual(delays, [100, 250]);
    assert.deepEqual(result, { attempts: 3 });
  });

  test('caps retry delay and rethrows after a finite test attempt limit', async () => {
    const delays = [];
    await assert.rejects(() => waitForCore({
      probe: async () => { throw new Error('still offline'); },
      logger: quietLogger,
      initialDelayMs: 1000,
      maxDelayMs: 1500,
      maxAttempts: 4,
      sleepImpl: async (ms) => delays.push(ms),
    }), /still offline/);
    assert.deepEqual(delays, [1000, 1500, 1500]);
  });

  test('rejects a missing probe instead of looping forever', async () => {
    await assert.rejects(() => waitForCore({ logger: quietLogger }), /requires a probe/);
  });

  test('does not overlap periodic work when a previous tick is still running', async () => {
    let active = 0;
    let maximum = 0;
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const run = createNonOverlappingTask(async () => {
      calls += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
    }, { logger: quietLogger });

    const first = run();
    const second = run();
    assert.equal(first, second);
    await Promise.resolve();
    assert.equal(calls, 1);
    release();
    await Promise.all([first, second]);
    await run();
    assert.equal(calls, 2);
    assert.equal(maximum, 1);
  });

  test('logs a failed tick and allows the next tick to retry', async () => {
    let calls = 0;
    const errors = [];
    const run = createNonOverlappingTask(async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary failure');
    }, { logger: { error: (message) => errors.push(message) } });

    await run();
    await run();
    assert.equal(calls, 2);
    assert.match(errors[0], /temporary failure/);
  });
});
