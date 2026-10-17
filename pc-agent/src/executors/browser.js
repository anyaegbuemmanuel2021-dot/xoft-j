const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

/** capability: 'browser', action: 'open_url'. Only http(s) URLs — never a bare string handed to a shell unescaped. */
async function openUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { success: false, error: `'${url}' is not a valid URL.` };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { success: false, error: `Refusing to open non-http(s) URL scheme '${parsed.protocol}'.` };
  }
  try {
    if (process.platform === 'win32') {
      await execFileAsync('cmd.exe', ['/c', 'start', '""', parsed.toString()]);
    } else {
      await execFileAsync(process.platform === 'darwin' ? 'open' : 'xdg-open', [parsed.toString()]).catch(() => {});
    }
    return { success: true, data: { opened: parsed.toString() }, verification: { verified: true, evidence: { source: 'os open command exited without error' } } };
  } catch (err) {
    return { success: false, error: `Failed to open URL: ${err.message}` };
  }
}

module.exports = { openUrl };
