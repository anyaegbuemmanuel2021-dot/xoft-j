const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

function ps(script, args = []) { return execFileAsync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script,'--',...args], { maxBuffer: 8 * 1024 * 1024 }); }

async function capture() {
  if (process.platform !== 'win32') return { success:false, error:'Screen capture executor currently supports Windows only.' };
  const script = `$bmp = New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width,[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Location,[System.Drawing.Point]::Empty,$bmp.Size); $ms=New-Object System.IO.MemoryStream; $bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray()); $g.Dispose(); $bmp.Dispose(); $ms.Dispose();`;
  try { const { stdout } = await ps('Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; ' + script); const base64=stdout.trim(); if(!base64)return{success:false,error:'No screenshot data returned.'}; return {success:true,data:{mimeType:'image/png',base64},verification:{verified:true,evidence:{source:'Windows.Forms screen capture'}}}; } catch(e){return{success:false,error:`Screen capture failed: ${e.message}`};}
}

async function input(action, parameters = {}) {
  if (process.platform !== 'win32') return { success:false, error:'Screen interaction executor currently supports Windows only.' };
  const x = Number(parameters.x); const y = Number(parameters.y);
  if (action === 'click' && (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0)) return {success:false,error:'Valid non-negative x/y coordinates are required.'};
  let script;
  if (action === 'click') {
    const flag = parameters.button === 'right' ? '0x0008,0x0010' : '0x0002,0x0004';
    script = `$sig=@'
using System; using System.Runtime.InteropServices; public static class I { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra); }
'@; Add-Type $sig; [I]::SetCursorPos(${x},${y}) | Out-Null; [I]::mouse_event(${flag.split(',')[0]},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [I]::mouse_event(${flag.split(',')[1]},0,0,0,[UIntPtr]::Zero);`;
  } else if (action === 'type') {
    const text = String(parameters.text ?? '').replace(/'/g, "''");
    if (text.length > 4000) return {success:false,error:'Text exceeds 4000 character limit.'};
    script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${text}')`;
  } else if (action === 'scroll') {
    const amount = Math.max(-20, Math.min(20, Math.trunc(Number(parameters.amount))));
    if (!Number.isFinite(amount) || amount === 0) return {success:false,error:'Scroll amount must be a non-zero number.'};
    script = `$sig=@'
using System; using System.Runtime.InteropServices; public static class I { [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra); }
'@; Add-Type $sig; [I]::mouse_event(0x0800,0,0,${amount * 120},[UIntPtr]::Zero);`;
  } else return {success:false,error:`Unsupported screen action '${action}'.`};
  try { await ps(script); return {success:true,data:{action},verification:{verified:true,evidence:{source:'Windows user32/SendKeys'}}}; } catch(e){return{success:false,error:`Screen interaction failed: ${e.message}`};}
}
module.exports = { capture, input };
