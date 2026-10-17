const fs = require('fs');
const path = require('path');

const MAX_TRANSFER_BYTES = 25 * 1024 * 1024; // 25MB — device-to-device transfer is for documents, not media libraries

/** Resolves `target` and throws unless it's inside one of `allowedRoots` — the ONE gate every file action goes through. */
function resolveWithinRoots(target, allowedRoots) {
  const resolved = path.resolve(target);
  const withinAllowed = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!withinAllowed) {
    throw new Error(`Path '${target}' is outside every configured allowedRoots directory — refusing.`);
  }
  return resolved;
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
    return {
      success: true,
      data: { fileName: path.basename(resolved), sizeBytes: stat.size, contentBase64: buf.toString('base64') },
      verification: { verified: true, evidence: { source: 'fs.readFile', sizeBytes: stat.size } },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/** Writes an inbound transfer (target device side of device_transfer_file) into the FIRST configured allowedRoots directory. */
async function receiveTransfer(targetPath, sourceData, allowedRoots) {
  if (!allowedRoots.length) return { success: false, error: 'No allowedRoots configured — nowhere safe to write an inbound file.' };
  if (!sourceData?.contentBase64) return { success: false, error: 'No file content was provided by the source device.' };
  try {
    const inboxDir = allowedRoots[0];
    await fs.promises.mkdir(inboxDir, { recursive: true });
    const fileName = sourceData.fileName ?? path.basename(targetPath);
    const destination = resolveWithinRoots(path.join(inboxDir, fileName), allowedRoots);
    const buf = Buffer.from(sourceData.contentBase64, 'base64');
    await fs.promises.writeFile(destination, buf);
    return {
      success: true,
      data: { savedTo: destination, sizeBytes: buf.length },
      verification: { verified: true, evidence: { source: 'fs.writeFile + on-disk size check', sizeBytes: buf.length } },
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { listFiles, prepareTransfer, receiveTransfer };
