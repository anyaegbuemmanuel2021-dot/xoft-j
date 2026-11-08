'use strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for xoft-core to become reachable before pairing or starting polling.
 * A cold start while the server is deploying or the network is unavailable
 * must not permanently kill the desktop agent.
 *
 * maxAttempts defaults to Infinity for the long-running desktop agent. Tests
 * can pass a finite limit. Backoff is capped to avoid hammering a recovering
 * server while still checking periodically.
 */
async function waitForCore({
  probe,
  logger = console,
  initialDelayMs = 1000,
  maxDelayMs = 30000,
  maxAttempts = Infinity,
  sleepImpl = sleep,
}) {
  if (typeof probe !== 'function') throw new TypeError('waitForCore requires a probe function');
  let attempt = 0;
  let delayMs = Math.max(0, Number(initialDelayMs) || 0);

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      await probe();
      logger.info?.('[connection] xoft-core is reachable');
      return { attempts: attempt };
    } catch (err) {
      logger.warn?.(`[connection] xoft-core unavailable (attempt ${attempt}): ${err.message}`);
      if (attempt >= maxAttempts) throw err;
      await sleepImpl(delayMs);
      delayMs = Math.min(Math.max(delayMs * 2, 250), maxDelayMs);
    }
  }
}

/**
 * Wrap a periodic async job so slow requests never overlap with the next
 * interval tick. A failed tick is logged and the next scheduled tick can
 * retry; the wrapper never leaves a rejected timer promise unhandled.
 */
function createNonOverlappingTask(task, { label = 'background task', logger = console } = {}) {
  if (typeof task !== 'function') throw new TypeError('task must be a function');
  let inFlight = null;

  return function run(...args) {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(() => task(...args))
      .catch((err) => {
        logger.error?.(`[${label}] ${err.message}`);
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

module.exports = { waitForCore, createNonOverlappingTask };
