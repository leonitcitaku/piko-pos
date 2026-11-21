// Printers installed on this computer: listing them, and sending raw bytes to one by its Windows name.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...opts },
    (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split('\n')[0])) : resolve(String(stdout))));
});

// -> [{ name, share, shared, port, host, driver, is_default, offline }]
export async function listPrinters() {
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-WmiObject Win32_Printer | Select-Object Name,ShareName,Shared,PortName,DriverName,Default,WorkOffline | ConvertTo-Json -Compress']);
    let rows = []; try { rows = JSON.parse(out.trim() || '[]'); } catch { rows = []; }
    if (!Array.isArray(rows)) rows = [rows];
    return rows.filter((r) => r && r.Name).map((r) => {
      const ip = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(String(r.PortName || ''));
      return { name: r.Name, share: r.Shared ? (r.ShareName || '') : '', shared: !!r.Shared, port: r.PortName || '', host: ip ? ip[1] : '',
        driver: r.DriverName || '', is_default: !!r.Default, offline: !!r.WorkOffline };
    });
  }
  // macOS and Linux (CUPS), for development
  try {
    const out = await run('lpstat', ['-p', '-d']);
    const def = (/system default destination: (\S+)/.exec(out) || [])[1] || '';
    return [...out.matchAll(/^printer (\S+)/gm)].map((m) => ({ name: m[1], share: '', shared: false, port: '', host: '', driver: 'CUPS', is_default: m[1] === def, offline: false }));
  } catch { return []; }
}

// Raw ESC/POS straight to a printer installed in Windows, by its name. No sharing needed.
const RAW_PS1 = `param([string]$Printer, [string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class PosRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)] static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] b, int n, out int w);
  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("Cannot open the printer (" + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = "Cafe POS ticket"; di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) throw new Exception("Cannot start the print job (" + Marshal.GetLastWin32Error() + ")");
      try {
        StartPagePrinter(h); int w;
        if (!WritePrinter(h, data, data.Length, out w) || w != data.Length) throw new Exception("The printer did not take the ticket (" + Marshal.GetLastWin32Error() + ")");
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
'@
[PosRawPrint]::Send($Printer, [IO.File]::ReadAllBytes($Path))
`;

export async function sendWindowsRaw(printerName, bytes) {
  if (process.platform !== 'win32') throw new Error('Printing by printer name works on Windows only');
  const dir = path.join(os.tmpdir(), 'cafepos-print');
  await fs.promises.mkdir(dir, { recursive: true });
  const script = path.join(dir, 'rawprint.ps1');
  await fs.promises.writeFile(script, RAW_PS1);
  const bin = path.join(dir, `job-${process.pid}-${Date.now()}.bin`);
  await fs.promises.writeFile(bin, bytes);
  try {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Printer', printerName, '-Path', bin]);
  } finally { fs.promises.unlink(bin).catch(() => {}); }
}
