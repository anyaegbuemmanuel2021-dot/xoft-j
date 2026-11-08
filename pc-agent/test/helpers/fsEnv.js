'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HaltGuard } = require('../../src/runtime/HaltGuard');
const { ActionPolicy } = require('../../src/runtime/ActionPolicy');
const { RuntimeGuard } = require('../../src/runtime/RuntimeGuard');
const { OperationJournal } = require('../../src/runtime/OperationJournal');
const { RecoveryStore } = require('../../src/runtime/RecoveryStore');
const { WorkspaceRegistry } = require('../../src/runtime/WorkspaceRegistry');
const { FileSystemService } = require('../../src/services/FileSystemService');

function makeEnv({ policy = {}, maxMutationsPerMinute = 1000, files = {} } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xoft-test-')));
  const root = path.join(base, 'ws'); const outside = path.join(base, 'outside'); const stateDir = path.join(base, 'state');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(outside, { recursive: true });
  for (const [rel, content] of Object.entries(files)) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
  const halt = new HaltGuard({ stateDir });
  const guard = new RuntimeGuard({ halt, policy: new ActionPolicy(policy), stateDir, maxMutationsPerMinute });
  const journal = new OperationJournal({ stateDir });
  const recovery = new RecoveryStore({ stateDir });
  const workspaces = new WorkspaceRegistry({ stateDir, seed: [{ name: 'proj', root }] });
  const fsx = new FileSystemService({ workspaces, journal, recovery, guard, extraSensitive: [path.join(root, 'agent-config.json')] });
  return { base, root, outside, stateDir, halt, guard, journal, recovery, workspaces, fsx, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
module.exports = { makeEnv };
