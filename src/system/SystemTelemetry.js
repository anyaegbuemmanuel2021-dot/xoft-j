import os from 'node:os';
import fs from 'node:fs';

/**
 * SystemTelemetry — real host/process numbers for the Command Center's
 * SYSTEM STATUS panel. Read-only, no secrets: only aggregate CPU/memory/disk
 * and uptime. Nothing here is estimated or faked; when a value cannot be read
 * on this platform it is returned as null and the UI shows "unavailable".
 *
 * CPU % is computed from the delta between two os.cpus() samples, so it
 * reflects load *since the previous call* (the dashboard polls every few
 * seconds). The very first call has no previous sample and returns null.
 */
export class SystemTelemetry {
  constructor({ dataDir = '.', osImpl = os, fsImpl = fs, now = () => Date.now() } = {}) {
    this.dataDir = dataDir;
    this.os = osImpl;
    this.fs = fsImpl;
    this.now = now;
    this._lastCpu = null;
    this._lastCpuPct = null;
    this._startedAt = this.now();
  }

  _cpuTotals() {
    let idle = 0;
    let total = 0;
    for (const c of this.os.cpus() ?? []) {
      for (const v of Object.values(c.times)) total += v;
      idle += c.times.idle;
    }
    return { idle, total };
  }

  cpuPercent() {
    const cur = this._cpuTotals();
    const prev = this._lastCpu;
    this._lastCpu = cur;
    if (!prev) return this._lastCpuPct;
    const dTotal = cur.total - prev.total;
    // Two polls in the same tick give a zero delta — keep the last value.
    if (dTotal <= 0) return this._lastCpuPct;
    const pct = Math.round((1 - (cur.idle - prev.idle) / dTotal) * 100);
    this._lastCpuPct = Math.min(100, Math.max(0, pct));
    return this._lastCpuPct;
  }

  storage() {
    try {
      const s = this.fs.statfsSync(this.dataDir);
      const total = Number(s.blocks) * Number(s.bsize);
      const free = Number(s.bavail) * Number(s.bsize);
      if (!total) return null;
      return { totalBytes: total, usedBytes: total - free, usedPercent: Math.round(((total - free) / total) * 100) };
    } catch {
      return null;
    }
  }

  snapshot() {
    const total = this.os.totalmem();
    const free = this.os.freemem();
    return {
      ts: new Date(this.now()).toISOString(),
      cpu: { percent: this.cpuPercent(), cores: (this.os.cpus() ?? []).length, load1: this.os.loadavg()[0] },
      memory: { totalBytes: total, usedBytes: total - free, usedPercent: total ? Math.round(((total - free) / total) * 100) : null },
      storage: this.storage(),
      uptime: { processSeconds: Math.round(process.uptime()), hostSeconds: Math.round(this.os.uptime()) },
      platform: `${this.os.platform()} ${this.os.arch()}`,
      node: process.version,
    };
  }
}
