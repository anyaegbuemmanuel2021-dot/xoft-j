'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * HaltGuard — the agent-local kill switch. Independent of the model, the mission engine
 * and (crucially) of core reachability: a sentinel file `<stateDir>/HALT` or a core
 * emergency-stop flag halts everything; in-flight operations register an AbortController
 * so halting actually interrupts terminal processes, waits and CDP commands.
 * Nothing in the agent can clear the sentinel — only a human deleting the file (or
 * calling resume() from the local CLI) resumes work.
 */
class HaltGuard {
  constructor({ stateDir, pollMs = 1000, fsImpl = fs } = {}) {
    if (!stateDir) throw new Error('HaltGuard: stateDir is required');
    this.sentinel = path.join(stateDir, 'HALT');
    this.pollMs = pollMs;
    this.fs = fsImpl;
    this._flag = null; // reason string when halted by memory flag (core/emergency)
    this._ops = new Set();
    this._timer = null;
    this._listeners = new Set();
    this.fs.mkdirSync(stateDir, { recursive: true });
  }

  isHalted() { return Boolean(this._flag) || this.fs.existsSync(this.sentinel); }
  reason() { return this._flag ?? (this.fs.existsSync(this.sentinel) ? 'HALT sentinel file present' : null); }

  assertNotHalted() {
    if (this.isHalted()) throw new Error(`HALTED: ${this.reason()} — no actions are permitted until a human resumes the agent.`);
  }

  halt(reason = 'halted') {
    const first = !this.isHalted();
    this._flag = reason;
    this._abortAll(reason);
    if (first) for (const fn of this._listeners) { try { fn(reason); } catch { /* listener errors never block a halt */ } }
  }

  /** Called by the core sync loop when the core emergency stop is active/inactive. */
  syncFromCore(coreActive, reason = 'core emergency stop') {
    if (coreActive && !this._flag) this.halt(reason);
    if (!coreActive && this._flag === reason) this._flag = null; // only clears a halt that CORE set; never a local one
  }

  resume() { this._flag = null; try { this.fs.unlinkSync(this.sentinel); } catch { /* already absent */ } }

  onHalt(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  /** Registers an in-flight operation. Returns { signal, done() }. If already halted, throws. */
  track() {
    this.assertNotHalted();
    const ctl = new AbortController();
    this._ops.add(ctl);
    return { signal: ctl.signal, done: () => this._ops.delete(ctl) };
  }

  _abortAll(reason) { for (const c of this._ops) c.abort(new Error(`HALTED: ${reason}`)); this._ops.clear(); }

  start() {
    if (this._timer) return;
    const tick = () => { if (this.fs.existsSync(this.sentinel) && this._ops.size) this._abortAll('HALT sentinel file present'); };
    this._timer = setInterval(tick, this.pollMs);
    this._timer.unref?.();
  }
  stop() { clearInterval(this._timer); this._timer = null; }
}

module.exports = { HaltGuard };
