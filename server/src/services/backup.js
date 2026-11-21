import fs from 'node:fs';
import path from 'node:path';
import * as sqlite from 'node:sqlite';
import { db, dataDir, getSetting, setSetting } from '../db.js';
import { now } from '../clock.js';

const KEEP = 30;
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

// Runs when the day is closed and when the app starts. The PC is usually shut down at night,
// so a timed nightly backup would never fire.
export async function runBackup(reason = 'manual') {
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  // Two backups in the same second must not write the same file: add a counter until the name is free.
  const base = `pos-${stamp(now())}-${reason}`;
  let file = path.join(dir, `${base}.db`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base}-${n}.db`);
  if (typeof sqlite.backup === 'function') await sqlite.backup(db, file);
  else db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const copies = [file];
  const extra = getSetting('backup_dir', '');
  if (extra) {
    try { fs.mkdirSync(extra, { recursive: true }); const dest = path.join(extra, path.basename(file)); fs.copyFileSync(file, dest); copies.push(dest); rotate(extra); }
    catch (e) { setSetting('last_backup_error', 'Second backup folder failed: ' + (e.code || e.message)); }
  }
  rotate(dir);
  setSetting('last_backup_at', now());
  setSetting('last_backup_file', file);
  return { file, copies };
}

function rotate(dir) {
  const files = fs.readdirSync(dir).filter((f) => /^pos-.*\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
}
