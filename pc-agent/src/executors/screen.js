'use strict';
const { execFile } = require('child_process');

const MAX_TYPED_TEXT = 4000;
const SEND_KEYS_ESCAPES = Object.freeze({
  '+': '{+}',
  '^': '{^}',
  '%': '{%}',
  '~': '{~}',
  '(': '{(}',
  ')': '{)}',
  '{': '{{}',
  '}': '{}}',
});

/**
 * SendKeys treats these characters as keyboard modifiers or control syntax.
 * Escape each one before building the PowerShell single-quoted string.
 */
function escapeSendKeysText(value) {
  return String(value).replace(/[+^%~(){}]/g, (character) => SEND_KEYS_ESCAPES[character]);
}

function ps(script, args = [], execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, '--', ...args],
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          if (stderr && !error.stderr) error.stderr = String(stderr);
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

async function capture({ platform = process.platform, execFileImpl = execFile } = {}) {
  if (platform !== 'win32') return { success: false, error: 'Screen capture executor currently supports Windows only.' };
  const script = `$bmp = New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width,[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Location,[System.Drawing.Point]::Empty,$bmp.Size); $ms=New-Object System.IO.MemoryStream; $bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray()); $g.Dispose(); $bmp.Dispose(); $ms.Dispose();`;
  try {
    const { stdout } = await ps('Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; ' + script, [], execFileImpl);
    const base64 = stdout.trim();
    if (!base64) return { success: false, error: 'No screenshot data returned.' };
    return { success: true, data: { mimeType: 'image/png', base64 }, verification: { verified: true, evidence: { source: 'Windows.Forms screen capture' } } };
  } catch (error) {
    return { success: false, error: `Screen capture failed: ${error.message}` };
  }
}

async function input(action, parameters = {}, { platform = process.platform, execFileImpl = execFile } = {}) {
  if (platform !== 'win32') return { success: false, error: 'Screen interaction executor currently supports Windows only.' };

  const x = Number(parameters.x);
  const y = Number(parameters.y);
  if (action === 'click' && (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0)) {
    return { success: false, error: 'Valid non-negative x/y coordinates are required.' };
  }

  let script;
  if (action === 'click') {
    const flags = parameters.button === 'right' ? ['0x0008', '0x0010'] : ['0x0002', '0x0004'];
    script = `$sig=@'
using System; using System.Runtime.InteropServices; public static class I { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra); }
'@; Add-Type $sig; if (-not [I]::SetCursorPos(${x},${y})) { throw 'Windows refused to position the cursor.' }; [I]::mouse_event(${flags[0]},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [I]::mouse_event(${flags[1]},0,0,0,[UIntPtr]::Zero);`;
  } else if (action === 'type') {
    const text = String(parameters.text ?? '');
    if (text.length > MAX_TYPED_TEXT) return { success: false, error: `Text exceeds ${MAX_TYPED_TEXT} character limit.` };
    const escaped = escapeSendKeysText(text).replace(/'/g, "''");
    script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`;
  } else if (action === 'scroll') {
    const amount = Math.max(-20, Math.min(20, Math.trunc(Number(parameters.amount))));
    if (!Number.isFinite(amount) || amount === 0) return { success: false, error: 'Scroll amount must be a non-zero number.' };
    script = `$sig=@'
using System; using System.Runtime.InteropServices; public static class I { [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra); }
'@; Add-Type $sig; [I]::mouse_event(0x0800,0,0,${amount * 120},[UIntPtr]::Zero);`;
  } else {
    return { success: false, error: `Unsupported screen action '${action}'.` };
  }

  try {
    await ps(script, [], execFileImpl);
    return { success: true, data: { action, dispatched: true }, verification: { verified: true, evidence: { source: action === 'type' ? 'Windows.Forms SendKeys dispatch' : 'Windows user32 input dispatch' } } };
  } catch (error) {
    return { success: false, error: `Screen interaction failed: ${error.message}` };
  }
}

module.exports = { capture, input, escapeSendKeysText };
