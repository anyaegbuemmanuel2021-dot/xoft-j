// store.js — tiny keyed pub/sub. Each dashboard widget subscribes only to the
// slice(s) it renders, so one telemetry tick re-renders one panel, not the page.

export function createStore(initial = {}) {
  const state = { ...initial };
  const subs = new Map(); // key -> Set<fn>

  return {
    get: (key) => state[key],
    set(key, value) {
      state[key] = value;
      for (const fn of subs.get(key) ?? []) fn(value, key);
    },
    update(key, fn) { this.set(key, fn(state[key])); },
    /** subscribe(keys, fn) — fn called on change (not immediately). Returns unsubscribe. */
    subscribe(keys, fn) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        if (!subs.has(k)) subs.set(k, new Set());
        subs.get(k).add(fn);
      }
      return () => { for (const k of list) subs.get(k)?.delete(fn); };
    },
  };
}
