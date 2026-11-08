// vad.js — local voice-activity detection. Pure logic (no DOM/audio APIs) so it is unit-tested in Node.
// Runs on the user's own device: raw microphone audio is analysed here and NEVER sent anywhere by this module.

/** Root-mean-square energy of a Float32Array/array of samples in [-1, 1]. */
export function rmsOf(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * EnergyVad — adaptive-noise-floor energy VAD with hysteresis.
 *  - speech STARTS after `startFrames` consecutive frames above threshold (rejects clicks/pops)
 *  - speech ENDS after `endSilenceMs` of continuous sub-threshold audio (rides over short pauses)
 *  - threshold = max(minThreshold, noiseFloor * floorMultiplier); the floor only adapts during silence,
 *    so a long utterance does not raise its own threshold and cut itself off.
 * This is a simple energy detector, not a neural VAD: steady loud noise (fans, music) can trigger it.
 */
export class EnergyVad {
  constructor({ minThreshold = 0.015, floorMultiplier = 3, startFrames = 3, endSilenceMs = 700, frameMs = 30, floorAdapt = 0.05 } = {}) {
    Object.assign(this, { minThreshold, floorMultiplier, startFrames, endSilenceMs, frameMs, floorAdapt });
    this.noiseFloor = minThreshold / floorMultiplier;
    this.speaking = false;
    this._above = 0;
    this._lastSpeechAt = 0;
  }

  get threshold() { return Math.max(this.minThreshold, this.noiseFloor * this.floorMultiplier); }

  /** @returns {{speaking:boolean, event:'start'|'end'|null, rms:number, threshold:number}} */
  process(rms, nowMs) {
    const above = rms >= this.threshold;
    let event = null;
    if (above) {
      this._above++;
      this._lastSpeechAt = nowMs;
      if (!this.speaking && this._above >= this.startFrames) { this.speaking = true; event = 'start'; }
    } else {
      this._above = 0;
      if (!this.speaking) this.noiseFloor += (rms - this.noiseFloor) * this.floorAdapt; // adapt to ambient noise only while silent
      else if (nowMs - this._lastSpeechAt >= this.endSilenceMs) { this.speaking = false; event = 'end'; }
    }
    return { speaking: this.speaking, event, rms, threshold: this.threshold };
  }

  reset() { this.speaking = false; this._above = 0; this._lastSpeechAt = 0; }
}
