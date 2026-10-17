const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

// Windows has no built-in CLI for media-key simulation. nircmd.exe (a small,
// well-known third-party utility) is the common real-world way to do this;
// we don't bundle it (spec section 38 — no hidden binaries), we just use it
// if the user has already put nircmd.exe on PATH. If it isn't there, this
// says so honestly instead of pretending the volume changed.
const NIRCMD_ACTIONS = {
  play: ['sendkeypress', 'mediaplaypause'],
  pause: ['sendkeypress', 'mediaplaypause'],
  stop: ['sendkeypress', 'mediastop'],
  volume_up: ['changesysvolume', '2000'],
  volume_down: ['changesysvolume', '-2000'],
  mute: ['mutesysvolume', '2'],
};

async function mediaControl(action) {
  const args = NIRCMD_ACTIONS[action];
  if (!args) return { success: false, error: `Unknown media action '${action}'.` };
  try {
    await execFileAsync('nircmd.exe', args);
    return { success: true, data: { action }, verification: { verified: true, evidence: { source: 'nircmd.exe exited without error' } } };
  } catch (err) {
    return {
      success: false,
      error: `Media control requires nircmd.exe on PATH (https://www.nirsoft.net/utils/nircmd.html) — not found or failed: ${err.message}`,
    };
  }
}

module.exports = { mediaControl };
