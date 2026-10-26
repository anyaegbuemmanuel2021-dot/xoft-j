const fs = require('fs');
const path = require('path');

const MAX_TRANSFER_BYTES = 25 * 1024 * 1024;

/** Compare paths using platform-aware containment rather than string-prefix checks. */
function isWithin(target, root) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Resolve an existing target (or a new target beneath an existing parent) through real paths.
 * This prevents a symlink/junction inside an allowed root from escaping that root.
 * Allowed roots must already exist; receiveTransfer creates its inbox before resolving it.
 */
function resolveWithinRoots(target, allowedRoots) {
  if (typeof target !== 'string' || !target.trim() || target.includes('\0')) {
    throw new Error('Invalid file path.');
  }
  const resolved = path.resolve(target);
  const realRoots = allowedRoots.map((root) => {
    try { return fs.realpathSync(root); } catch { return null; }
  }).filter(Boolean);
  if (!realRoots.length) throw new Error('No existing allowedRoots directory is available.');

  let cursor = resolved;
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`Cannot resolve path '${target}'.`);
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const realTarget = path.join(fs.realpathSync(cursor), ...suffix);
  if (!realRoots.some((root) => isWithin(realTarget, root))) {
    throw new Error(`Path '${target}' resolves outside every configured allowedRoots directory — refusing.`);
  }
  return realTarget;
}

async function listFiles(targetPath, allowedRoots) {
  try {
    const resolved = resolveWithinRoots(targetPath, allowedRoots);
    const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
    const files = entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
    return { success: true, data: { path: resolved, files }, verification: { verified: true, evidence: { source: 'fs.readdir' } } };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** Reads a file for outbound transfer (source device side of device_transfer_file). */
async function prepareTransfer(targetPath, allowedRoots) {
  try {
    const resolved = resolveWithinRoots(targetPath, allowedRoots);
    const stat = await fs.promises.stat(resolved);
    if (!stat.isFile()) return { success: false, error: `'${targetPath}' is not a file.` };
    if (stat.size > MAX_TRANSFER_BYTES) {
      return { success: false, error: `File is ${stat.size} bytes, over the ${MAX_TRANSFER_BYTES}-byte transfer limit.` };
    }
    const buf = await fs.promises.readFile(resolved);
    if (buf.length > MAX_TRANSFER_BYTES) {
      return { success: false, error: `File grew beyond the ${MAX_TRANSFER_BYTES}-byte transfer limit while being read.` };
    }
    return {
      success: true,
      data: { fileName: path.basename(resolved), sizeBytes: buf.length, contentBase64: buf.toString('base64') },
      verification: { verified: true, evidence: { source: 'fs.readFile', sizeBytes: buf.length } },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** Writes inbound transfers into the FIRST configured allowedRoots directory without overwriting existing files. */
async function receiveTransfer(targetPath, sourceData, allowedRoots) {
  if (!Array.isArray(allowedRoots) || !allowedRoots.length) return { success: false, error: 'No allowedRoots configured — nowhere safe to write an inbound file.' };
  if (typeof sourceData?.contentBase64 !== 'string' || !sourceData.contentBase64) return { success: false, error: 'No file content was provided by the source device.' };
  try {
    const inboxDir = path.resolve(allowedRoots[0]);
    await fs.promises.mkdir(inboxDir, { recursive: true });
    const fileName = String(sourceData.fileName ?? path.basename(String(targetPath ?? 'received-file')));
    // Never allow a remote filename to choose a directory or special path.
    if (!fileName || fileName === '.' || fileName === '..' || path.basename(fileName) !== fileName || /[\\/\0]/.test(fileName)) {
      throw new Error('Invalid inbound file name; directory paths are not allowed.');
    }
    // Bound encoded size before allocating the decoded buffer.
    const maxEncodedLength = Math.ceil(MAX_TRANSFER_BYTES / 3) * 4;
    if (sourceData.contentBase64.length > maxEncodedLength) {
      throw new Error(`Inbound file exceeds the ${MAX_TRANSFER_BYTES}-byte transfer limit.`);
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(sourceData.contentBase64)) {
      throw new Error('Inbound file content is not valid base64.');
    }
    const buf = Buffer.from(sourceData.contentBase64, 'base64');
    if (buf.length > MAX_TRANSFER_BYTES) throw new Error(`Inbound file exceeds the ${MAX_TRANSFER_BYTES}-byte transfer limit.`);
    const destination = resolveWithinRoots(path.join(inboxDir, fileName), allowedRoots);
    // 'wx' prevents silently replacing an existing file or following a destination symlink.
    const handle = await fs.promises.open(destination, 'wx', 0o600);
    try { await handle.writeFile(buf); } finally { await handle.close(); }
    const stat = await fs.promises.stat(destination);
    if (!stat.isFile() || stat.size !== buf.length) {
      await fs.promises.unlink(destination).catch(() => {});
      throw new Error('Inbound file verification failed after writing.');
    }
    return {
      success: true,
      data: { savedTo: destination, sizeBytes: stat.size },
      verification: { verified: true, evidence: { source: 'fs.stat after exclusive write', sizeBytes: stat.size } },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { listFiles, prepareTransfer, receiveTransfer, resolveWithinRoots, MAX_TRANSFER_BYTES };
