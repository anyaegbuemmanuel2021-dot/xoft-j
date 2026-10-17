'use strict';
const { execFileSync } = require('node:child_process');

const TASK_NAME = 'XOFT Agent';

/**
 * Builds the exact schtasks argument array for registering XOFT to run at
 * user logon. Kept separate from actually running it so this can be unit
 * tested cross-platform without a real Windows machine or admin rights.
 *
 * Runs the exact same command the user would run manually (`node
 * src/index.js`, or the packaged .exe directly) — this does not change
 * what runs, only when it starts automatically. `/sc onlogon` + `/rl
 * limited` means it runs with the current user's normal privileges at
 * their next login; it does not request admin rights and does not run
 * before anyone logs in (the more invasive "run whether user is logged on
 * or not" mode needs stored credentials and is deliberately not what this
 * does by default — see the README).
 */
function buildInstallArgs({ execPath, scriptPath, isPackaged }) {
  const command = isPackaged ? execPath : `"${execPath}" "${scriptPath}"`;
  return ['/create', '/tn', TASK_NAME, '/tr', command, '/sc', 'onlogon', '/rl', 'limited', '/f'];
}

function buildUninstallArgs() {
  return ['/delete', '/tn', TASK_NAME, '/f'];
}

function assertWindows() {
  if (process.platform !== 'win32') {
    throw new Error(
      `Startup registration uses Windows Task Scheduler (schtasks) and only works on Windows (this process reports '${process.platform}'). ` +
      "On other platforms, use your OS's own login-item/service mechanism (e.g. a systemd user unit on Linux, a LaunchAgent on macOS) to run this same start command instead."
    );
  }
}

/** Registers XOFT to start automatically at login. Explicit opt-in only — never called automatically by normal startup. */
function installStartup({ scriptPath = require.resolve('./index.js') } = {}) {
  assertWindows();
  const isPackaged = Boolean(process.pkg);
  const args = buildInstallArgs({ execPath: process.execPath, scriptPath, isPackaged });
  execFileSync('schtasks', args, { stdio: 'inherit' });
  return { taskName: TASK_NAME };
}

/** Removes the scheduled task, if present. Safe to call even if it was never installed. */
function uninstallStartup() {
  assertWindows();
  try {
    execFileSync('schtasks', buildUninstallArgs(), { stdio: 'inherit' });
  } catch (err) {
    // schtasks exits non-zero if the task doesn't exist — that's a no-op, not a failure.
    if (!/ERROR.*cannot find|no scheduled/i.test(err.message)) throw err;
  }
  return { taskName: TASK_NAME };
}

module.exports = { installStartup, uninstallStartup, buildInstallArgs, buildUninstallArgs, TASK_NAME };
