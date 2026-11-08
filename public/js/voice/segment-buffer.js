// RollingAudioBuffer keeps a short, bounded pre-roll so VAD startup latency does not clip the first syllable.
export class RollingAudioBuffer {
  constructor({ preRollMs = 500, now = () => Date.now() } = {}) {
    this.preRollMs = Math.max(0, Number(preRollMs) || 0);
    this.now = now;
    this.history = [];
    this.activeChunks = null;
  }

  push(chunk, timestamp = this.now()) {
    if (!chunk || !(chunk.size > 0)) return;
    const at = Number.isFinite(timestamp) ? timestamp : this.now();
    this.history.push({ chunk, at });
    const cutoff = at - this.preRollMs;
    while (this.history.length && this.history[0].at < cutoff) this.history.shift();
    if (this.activeChunks) this.activeChunks.push(chunk);
  }

  begin() {
    if (this.activeChunks) return false;
    const cutoff = this.now() - this.preRollMs;
    this.activeChunks = this.history.filter((entry) => entry.at >= cutoff).map((entry) => entry.chunk);
    return true;
  }

  finish() {
    if (!this.activeChunks) return [];
    const chunks = this.activeChunks;
    this.activeChunks = null;
    return chunks;
  }

  discard() { this.activeChunks = null; this.history = []; }
  get active() { return this.activeChunks !== null; }
}
