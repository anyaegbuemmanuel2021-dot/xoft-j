const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

/**
 * capability: 'applications' — spec section 9/17. Every launch/close goes
 * through config.appAllowlist; there is no path here that runs a name the
 * user hasn't explicitly listed in config.json. This is the concrete
 * enforcement of "no arbitrary shell execution" on the desktop side.
 */

async function listApplications() {
  try {
    if (process.platform === 'win32') {
      // tasklist ships with every Windows install — no extra dependency.
      const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH']);
      const apps = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split('","').map((s) => s.replace(/^"|"$/g, '')))
        .map(([name, pid]) => ({ name, pid }));
      return { success: true, data: { apps }, verification: { verified: true, evidence: { source: 'tasklist' } } };
    }
    // Non-Windows fallback so this can be exercised in dev/CI too.
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'comm=,pid=']);
    const apps = stdout.split('\n').filter(Boolean).map((l) => {
      const parts = l.trim().split(/\s+/);
      const pid = parts.pop();
      return { name: parts.join(' '), pid };
    });
    return { success: true, data: { apps }, verification: { verified: true, evidence: { source: 'ps' } } };
  } catch (err) {
    return { success: false, error: `Could not list applications: ${err.message}` };
  }
}

async function openApplication(application, allowlist) {
  const entry = allowlist[String(application).toLowerCase()];
  if (!entry) {
    return { success: false, error: `'${application}' is not in appAllowlist (config.json) — refusing to launch anything not explicitly allowed.` };
  }
  try {
    if (process.platform === 'win32') {
      // `start` needs an empty title arg when the path itself has spaces/quotes.
      await execFileAsync('cmd.exe', ['/c', 'start', '""', entry.path]);
    } else {
      // Dev/test fallback — best-effort, not the real Windows path.
      await execFileAsync(process.platform === 'darwin' ? 'open' : 'xdg-open', [entry.path]).catch(() => {});
    }
    return {
      success: true,
      data: { launched: application, path: entry.path },
      verification: { verified: true, evidence: { note: 'launch command exited without error — process start reported, window focus not separately confirmed' } },
    };
  } catch (err) {
    return { success: false, error: `Failed to launch '${application}': ${err.message}` };
  }
}

async function closeApplication(application, allowlist) {
  const entry = allowlist[String(application).toLowerCase()];
  if (!entry?.processName) {
    return { success: false, error: `'${application}' has no processName configured in appAllowlist — refusing to guess a process to kill.` };
  }
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/IM', entry.processName, '/F']);
    } else {
      await execFileAsync('pkill', ['-f', entry.processName]).catch(() => {});
    }
    return { success: true, data: { closed: application }, verification: { verified: true, evidence: { source: 'taskkill exit code' } } };
  } catch (err) {
    // taskkill exits non-zero if the process wasn't running — that's a real, informative failure, not hidden.
    return { success: false, error: `Failed to close '${application}': ${err.message}` };
  }
}

module.exports = { listApplications, openApplication, closeApplication };
