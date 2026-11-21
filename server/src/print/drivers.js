import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { getSetting, dataDir } from '../db.js';
import { ticketBytes, ticketText } from './escpos.js';
import { sendWindowsRaw } from '../util/printers.js';
import { ticketWidth } from './queue.js';

// Network printer: raw ESC/POS to port 9100. Asks the printer for its paper status first when it answers.
// Most cheap printers never answer the status question, so after one silent try we stop waiting for it.
const answersStatus = new Map();
function sendNetwork(host, port, bytes) {
  const key = host + ':' + port;
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port, timeout: 3000 });
    let done = false, statusTimer = null, written = false, flushed = false;
    const finish = (err) => { if (done) return; done = true; clearTimeout(statusTimer); sock.destroy(); err ? reject(err) : resolve(); };
    const write = () => { if (written) return; written = true; sock.write(bytes, (e) => { if (e) return finish(e); flushed = true; sock.end(); }); };
    sock.on('connect', () => {
      sock.write(Buffer.from([0x10, 0x04, 0x04])); // DLE EOT 4: paper sensor status
      if (answersStatus.get(key) === false) return write();
      statusTimer = setTimeout(() => { answersStatus.set(key, false); write(); }, 400);
    });
    sock.once('data', (d) => {
      clearTimeout(statusTimer); answersStatus.set(key, true);
      if (!written && (d[0] & 0x60) === 0x60) return finish(new Error('Printer is out of paper'));
      write();
    });
    sock.on('timeout', () => finish(new Error('Printer did not answer')));
    sock.on('error', (e) => finish(new Error('Printer not reachable: ' + (e.code || e.message))));
    // A printer that accepts the connection and then drops it before we wrote anything must not count as printed.
    sock.on('close', () => finish(flushed ? null : new Error('Printer closed the connection')));
  });
}

// USB printer on Windows: share the printer in Windows, then raw bytes can be written to \\localhost\ShareName.
async function sendWindowsShare(share, bytes) {
  const target = share.startsWith('\\\\') ? share : `\\\\localhost\\${share}`;
  await fs.promises.writeFile(target, bytes);
}

// File "printer": writes each ticket as text. For development and for demos without a printer.
async function sendFile(job) {
  const dir = path.join(dataDir, 'tickets');
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, `${String(job.id).padStart(6, '0')}-${job.kind}.txt`), ticketText(job, ticketWidth()));
}

export async function printJob(job) {
  const mode = getSetting('printer_mode', 'off');
  if (mode === 'off') return;                               // no printer set up: tickets live on the Tickets page only
  if (mode === 'file') return sendFile(job);
  const bytes = ticketBytes(job, ticketWidth());
  if (mode === 'network') {
    const host = getSetting('printer_host', '');
    if (!host) throw new Error('Printer address is not set');
    return sendNetwork(host, Number(getSetting('printer_port', '9100')) || 9100, bytes);
  }
  if (mode === 'windows') {
    const share = getSetting('printer_share', '');
    if (!share) throw new Error('Printer share name is not set');
    return sendWindowsShare(share, bytes);
  }
  if (mode === 'winraw') {
    const name = getSetting('printer_name', '');
    if (!name) throw new Error('No printer is picked');
    return sendWindowsRaw(name, bytes);
  }
  throw new Error('Unknown printer mode: ' + mode);
}
