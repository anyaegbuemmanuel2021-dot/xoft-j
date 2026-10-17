import fs from 'node:fs';
import path from 'node:path';

/**
 * KillSwitch — a way to trigger EmergencyStop that does NOT require the
 * dashboard, the REST API, or its auth layer to be reachable (spec:
 * "independent kill switch"). Two independent triggers, either sufficient:
 *
 *   1. A sentinel file. Dropping a file at <dataDir>/KILL (any content,
 *      even empty) trips the switch on the next fs watch event or the next
 *      poll tick, whichever fires first — reachable from the same machine
 *      with nothing more than `touch`/`echo >`, no HTTP call, no API key.
 *   2. SIGUSR2 sent to this process (`kill -USR2 <pid>`) — reachable from
 *      anywhere with shell access to the host, again with no HTTP layer
 *      involved at all.
 *
 * Honest limitation, stated rather than glossed over: both triggers still
 * require *this Node process* to be alive and its event loop unblocked to
 * notice them — a fully hung or killed process cannot be reached by
 * anything running inside it. What this genuinely buys is independence
 * from the dashboard UI, the REST API, and API-key auth, which is the
 * actual asset ("dashboard is unreachable/misbehaving, but the process
 * is up") — not independence from the OS process itself.
 */
export class KillSwitch {
  constructor({ emergencyStop, activityLog, dataDir = './data', pollIntervalMs = 3000 } = {}) {
    this.emergencyStop = emergencyStop;
    this.activityLog = activityLog;
    this.sentinelPath = path.join(dataDir, 'KILL');
    this.pollIntervalMs = pollIntervalMs;
    this._watcher = null;
    this._timer = null;
    this._sigHandler = null;
  }

  _trip(source) {
    if (this.emergencyStop.isActive()) return; // already stopped — avoid duplicate log noise
    this.activityLog?.log({ type: 'kill_switch_tripped', detail: { source } });
    this.emergencyStop.activate(`kill switch: ${source}`);
  }

  _checkSentinel() {
    if (fs.existsSync(this.sentinelPath)) this._trip('sentinel file');
  }

  start() {
    if (this._timer) return; // already started
    this._checkSentinel();
    // Poll as the reliable baseline (fs.watch semantics vary by platform/filesystem);
    // fs.watch on the parent dir gives near-instant reaction when it's supported.
    this._timer = setInterval(() => this._checkSentinel(), this.pollIntervalMs);
    this._timer.unref?.();
    try {
      fs.mkdirSync(path.dirname(this.sentinelPath), { recursive: true });
      this._watcher = fs.watch(path.dirname(this.sentinelPath), (_event, filename) => {
        if (filename === 'KILL') this._checkSentinel();
      });
      this._watcher.unref?.();
    } catch { /* fs.watch unsupported on this platform/filesystem — polling still covers it */ }

    this._sigHandler = () => this._trip('SIGUSR2');
    process.on('SIGUSR2', this._sigHandler);
  }

  stop() {
    clearInterval(this._timer); this._timer = null;
    this._watcher?.close(); this._watcher = null;
    if (this._sigHandler) process.removeListener('SIGUSR2', this._sigHandler);
  }

  /** Clears the sentinel file so restarting/deactivating doesn't immediately re-trip. Caller decides when this is safe — never automatic. */
  clearSentinel() {
    try { fs.unlinkSync(this.sentinelPath); } catch { /* already absent */ }
  }

  status() {
    return { sentinelPath: this.sentinelPath, sentinelPresent: fs.existsSync(this.sentinelPath), listening: Boolean(this._timer) };
  }
}
