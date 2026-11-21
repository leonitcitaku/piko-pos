import fs from 'node:fs';
import path from 'node:path';
import * as sqlite from 'node:sqlite';
import { db, dataDir, getSetting, setSetting, openDb, closeDb } from '../db.js';
import { now } from '../clock.js';
import { HttpError, bad } from '../http.js';

const keep = () => Math.min(365, Math.max(5, Number(getSetting('backups_keep', '30')) || 30));
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const backupDir = () => path.join(dataDir, 'backups');
const NAME = /^pos-[A-Za-z0-9._-]+\.db$/;

function freeName(dir, base) {
  let file = path.join(dir, `${base}.db`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base}-${n}.db`);
  return file;
}
function fileOf(name) {
  if (!NAME.test(String(name))) throw bad('bad_name');
  const file = path.join(backupDir(), name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'no_backup');
  return file;
}

// Runs when the day is closed and when the app starts. The PC is usually shut down at night,
// so a timed nightly backup would never fire.
export async function runBackup(reason = 'manual') {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  // Two backups in the same second must not write the same file: add a counter until the name is free.
  const file = freeName(dir, `pos-${stamp(now())}-${reason}`);
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
  for (const f of files.slice(0, Math.max(0, files.length - keep()))) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
}

export function listBackups() {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => NAME.test(f)).map((f) => {
    const st = fs.statSync(path.join(dir, f));
    const m = /^pos-(\d{8})-(\d{6})-(.+?)(?:-\d+)?\.db$/.exec(f);
    return { name: f, size: st.size, at: Math.round(st.mtimeMs), reason: m ? m[3] : '' };
  }).sort((a, b) => b.at - a.at);
}

// Opens a backup read only and says what is in it, without touching the live database.
export function inspectFile(file) {
  let b;
  try { b = new sqlite.DatabaseSync(file, { readOnly: true }); } catch { throw bad('not_a_backup', 'This file is not a POS database'); }
  try {
    const tables = b.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    for (const need of ['users', 'orders', 'order_items', 'payments', 'business_days', 'settings']) {
      if (!tables.includes(need)) throw bad('not_a_backup', 'This file is not a POS database');
    }
    const n = (sql) => b.prepare(sql).get().n;
    const cafe = b.prepare("SELECT value FROM settings WHERE key = 'cafe_name'").get();
    const last = b.prepare('SELECT MAX(created_at) AS t FROM payments').get();
    const first = b.prepare('SELECT MIN(opened_at) AS t FROM business_days').get();
    return {
      cafe_name: cafe ? cafe.value : '', schema: b.prepare('PRAGMA user_version').get().user_version,
      users: n('SELECT COUNT(*) AS n FROM users WHERE active = 1'), days: n('SELECT COUNT(*) AS n FROM business_days'),
      open_days: n("SELECT COUNT(*) AS n FROM business_days WHERE status = 'open'"),
      orders: n('SELECT COUNT(*) AS n FROM orders'), open_orders: n("SELECT COUNT(*) AS n FROM orders WHERE status = 'open'"),
      products: n('SELECT COUNT(*) AS n FROM products WHERE active = 1'),
      sales_cents: n('SELECT COALESCE(SUM(amount_cents), 0) AS n FROM payments'),
      first_day_at: first.t || null, last_sale_at: last.t || null,
      staff: b.prepare('SELECT name, role FROM users WHERE active = 1 ORDER BY role, name').all(),
    };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw bad('not_a_backup', 'This file is not a POS database');
  } finally { b.close(); }
}
export const backupSummary = (name) => inspectFile(fileOf(name));
export const backupFile = (name) => fileOf(name);

// A backup brought from somewhere else (a USB stick, another PC). Checked before it is kept.
export function saveUploaded(buffer) {
  if (!buffer || buffer.length < 100 || buffer.subarray(0, 15).toString('latin1') !== 'SQLite format 3') throw bad('not_a_backup', 'This file is not a POS database');
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = freeName(dir, `pos-${stamp(now())}-uploaded`);
  fs.writeFileSync(file, buffer);
  try { const summary = inspectFile(file); return { name: path.basename(file), summary }; }
  catch (e) { fs.unlinkSync(file); throw e; }
}

// Puts a backup in place of the live database. The live one is backed up first, so this can be undone.
export async function restoreBackup(name) {
  const file = fileOf(name);
  const summary = inspectFile(file);
  const safety = await runBackup('before-restore');
  const live = path.join(dataDir, 'pos.db');
  // No await between closing and reopening: nothing else may run while there is no database.
  closeDb();
  for (const f of [live + '-wal', live + '-shm']) { try { fs.unlinkSync(f); } catch { /* not there */ } }
  fs.copyFileSync(file, live);
  openDb(dataDir);
  return { restored: name, safety: path.basename(safety.file), summary };
}

export function dbInfo() {
  const live = path.join(dataDir, 'pos.db');
  const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  const n = (sql) => db.prepare(sql).get().n;
  return { file: live, size: size(live) + size(live + '-wal'), schema: db.prepare('PRAGMA user_version').get().user_version,
    orders: n('SELECT COUNT(*) AS n FROM orders'), days: n('SELECT COUNT(*) AS n FROM business_days'),
    audit_rows: n('SELECT COUNT(*) AS n FROM audit_log'), tickets: n('SELECT COUNT(*) AS n FROM print_jobs'),
    backups_dir: backupDir(), backups: listBackups().length, keep: keep() };
}
