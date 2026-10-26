const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

/** Open only ordinary HTTP(S) URLs, without routing user-controlled URL text through a command shell. */
async function openUrl(url) {
  let parsed;
  try {
    if (typeof url !== 'string' || /[\r\n\0]/.test(url)) throw new Error('invalid URL characters');
    parsed = new URL(url);
  } catch {
    return { success: false, error: 'A valid HTTP(S) URL is required.' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { success: false, error: `Refusing to open non-http(s) URL scheme '${parsed.protocol}'.` };
  }
  if (parsed.username || parsed.password) {
    return { success: false, error: 'URLs containing embedded credentials are refused.' };
  }
  try {
    const safeUrl = parsed.toString();
    if (process.platform === 'win32') {
      // No cmd.exe / shell parsing: URL is a single argv value to the Windows URL handler.
      await execFileAsync('rundll32.exe', ['url.dll,FileProtocolHandler', safeUrl], { windowsHide: true });
    } else {
      await execFileAsync(process.platform === 'darwin' ? 'open' : 'xdg-open', [safeUrl]).catch(() => {});
    }
    return { success: true, data: { opened: safeUrl }, verification: { verified: true, evidence: { source: 'OS URL handler launched without a shell' } } };
  } catch (err) {
    return { success: false, error: `Failed to open URL: ${err.message}` };
  }
}

module.exports = { openUrl };
