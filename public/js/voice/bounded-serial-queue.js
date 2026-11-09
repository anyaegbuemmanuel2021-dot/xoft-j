// A small FIFO queue for speech segments. It bounds latency by rejecting new work
// instead of allowing slow STT requests to accumulate into stale voice commands.
export function createBoundedSerialQueue({ limit = 2, onError = () => {} } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Queue limit must be a positive integer.');
  let pending = 0;
  let tail = Promise.resolve();
  let generation = 0;

  return {
    get pending() { return pending; },

    enqueue(task) {
      if (typeof task !== 'function') throw new TypeError('Queue task must be a function.');
      if (pending >= limit) return false;
      const taskGeneration = generation;
      pending += 1;
      const run = tail.then(async () => {
        if (taskGeneration !== generation) return;
        await task();
      });
      tail = run
        .catch((error) => {
          if (taskGeneration === generation) {
            try { onError(error); } catch { /* queue error handlers must not break the queue */ }
          }
        })
        .finally(() => {
          if (taskGeneration === generation) pending = Math.max(0, pending - 1);
        });
      return true;
    },

    clear() {
      generation += 1;
      pending = 0;
      tail = Promise.resolve();
    },

    idle() { return tail; },
  };
}
