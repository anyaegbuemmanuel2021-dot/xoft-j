'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

async function movePath(src, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try { await fs.promises.rename(src, dest); }
  catch (err) {
    if (err.code !== 'EXDEV') throw err; // different volume: copy then remove
    await fs.promises.cp(src, dest, { recursive: true, errorOnExist: true });
    await fs.promises.rm(src, { recursive: true, force: true });
  }
}

/**
 * RecoveryStore — checkpoints (pre-edit copies) and trash (pre-delete moves), both keyed by operation id.
 * Layout: <stateDir>/checkpoints/op-<id>/<name>   <stateDir>/trash/op-<id>/<name> + meta.json
 * Nothing here ever permanently deletes user data; purging old recovery data is an explicit, separate act.
 */
class RecoveryStore {
  constructor({ stateDir } = {}) {
    if (!stateDir) throw new Error('RecoveryStore: stateDir is required');
    this.checkpointDir = path.join(stateDir, 'checkpoints');
    this.trashDir = path.join(stateDir, 'trash');
  }

  async checkpoint(opId, absPath) {
    const stat = await fs.promises.stat(absPath);
    if (!stat.isFile()) throw new Error('Checkpoints are for files; use trash for directories');
    const ref = path.join(this.checkpointDir, `op-${opId}`, path.basename(absPath));
    await fs.promises.mkdir(path.dirname(ref), { recursive: true });
    await fs.promises.copyFile(absPath, ref);
    const sha = await sha256File(ref);
    if (sha !== (await sha256File(absPath))) throw new Error('Checkpoint verification failed (hash mismatch) — refusing to proceed');
    return { ref, sha256: sha, size: stat.size };
  }

  async restoreCheckpoint(ref, destPath) {
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.copyFile(ref, destPath);
    return { sha256: await sha256File(destPath) };
  }

  async trash(opId, absPath) {
    const stat = await fs.promises.stat(absPath);
    const dir = path.join(this.trashDir, `op-${opId}`);
    const ref = path.join(dir, path.basename(absPath));
    await movePath(absPath, ref);
    await fs.promises.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ originalPath: absPath, deletedAt: new Date().toISOString(), isDirectory: stat.isDirectory(), size: stat.size }, null, 2));
    return { ref, originalPath: absPath, isDirectory: stat.isDirectory() };
  }

  /** Restores to the original path; refuses to clobber something that now exists there unless overwrite=true. */
  async restoreFromTrash(ref, originalPath, { overwrite = false } = {}) {
    if (!fs.existsSync(ref)) throw new Error('Trash entry no longer exists (was it purged?)');
    if (fs.existsSync(originalPath) && !overwrite) throw new Error(`Cannot restore: '${originalPath}' already exists (pass overwrite to replace it)`);
    if (fs.existsSync(originalPath)) await fs.promises.rm(originalPath, { recursive: true, force: true });
    await movePath(ref, originalPath);
    return { restoredTo: originalPath };
  }
}

module.exports = { RecoveryStore, sha256File, movePath };
