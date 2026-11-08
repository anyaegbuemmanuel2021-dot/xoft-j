'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { installStartup, uninstallStartup, buildInstallArgs, buildUninstallArgs, TASK_NAME } = require('../src/startup');

describe('pc-agent startup registration', () => {
  test('installStartup() refuses on a non-Windows platform with a clear, actionable error (this test environment is not Windows)', () => {
    assert.equal(process.platform === 'win32', false, 'sanity check: this suite assumes it is NOT running on Windows');
    assert.throws(() => installStartup(), /Windows/);
  });

  test('uninstallStartup() refuses on a non-Windows platform the same way', () => {
    assert.throws(() => uninstallStartup(), /Windows/);
  });

  test('buildInstallArgs() runs the unpackaged agent via node + the script path, quoted, at user logon with normal privileges', () => {
    const args = buildInstallArgs({ execPath: 'C:\\Program Files\\nodejs\\node.exe', scriptPath: 'C:\\xoft\\src\\index.js', isPackaged: false });
    assert.deepEqual(args, [
      '/create', '/tn', TASK_NAME,
      '/tr', '"C:\\Program Files\\nodejs\\node.exe" "C:\\xoft\\src\\index.js"',
      '/sc', 'onlogon', '/rl', 'limited', '/f',
    ]);
  });

  test('buildInstallArgs() runs the packaged .exe directly (no separate node/script args) when packaged', () => {
    const args = buildInstallArgs({ execPath: 'C:\\xoft\\dist\\xoft-agent.exe', scriptPath: 'ignored', isPackaged: true });
    assert.deepEqual(args, [
      '/create', '/tn', TASK_NAME,
      '/tr', 'C:\\xoft\\dist\\xoft-agent.exe',
      '/sc', 'onlogon', '/rl', 'limited', '/f',
    ]);
  });

  test('buildInstallArgs() never requests elevated privileges or a run-without-login mode by default', () => {
    const args = buildInstallArgs({ execPath: 'node.exe', scriptPath: 'index.js', isPackaged: false });
    assert.ok(!args.includes('highest'), 'must not request admin/highest run level by default');
    assert.equal(args[args.indexOf('/rl') + 1], 'limited');
    assert.equal(args[args.indexOf('/sc') + 1], 'onlogon', 'must run at login, not before anyone logs in');
  });

  test('buildUninstallArgs() force-deletes the exact same task name install used, and nothing else', () => {
    assert.deepEqual(buildUninstallArgs(), ['/delete', '/tn', TASK_NAME, '/f']);
  });
});
