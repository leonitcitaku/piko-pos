import { get, all, run, db } from '../db.js';
import { now } from '../clock.js';
import { broadcast } from '../services/events.js';
import { printJob } from './drivers.js';
import { ticketText } from './escpos.js';

// Every ticket goes through this queue. Tickets print in order. If the printer fails, they wait and retry,
// the waiter is warned, and when they finally print they carry a LATE mark with the original time.
const LATE_AFTER_MS = 60_000;
export const printerState = { ok: true, error: null, last_ok_at: null, waiting: 0 };
let busy = false, timer = null;

const parse = (j) => ({ ...j, content: JSON.parse(j.content) });

export function enqueueTicket({ day_id, order_id = null, batch_id = null, user_id = null, kind, content, original_time }) {
  const r = run('INSERT INTO print_jobs(day_id, order_id, batch_id, user_id, kind, content, original_time) VALUES(?,?,?,?,?,?,?)',
    day_id ?? null, order_id, batch_id, user_id, kind, JSON.stringify(content), original_time ?? now());
  setImmediate(pump);
  return Number(r.lastInsertRowid);
}

export async function pump() {
  if (busy || !db) return;
  busy = true;
  try {
    for (;;) {
      if (!db) break;
      const row = get("SELECT * FROM print_jobs WHERE status = 'waiting' ORDER BY id LIMIT 1");
      if (!row) break;
      const job = parse(row);
      job.was_late = job.attempts > 0 || now() - job.original_time > LATE_AFTER_MS ? 1 : 0;
      try {
        await printJob(job);
        run("UPDATE print_jobs SET status = 'printed', printed_at = ?, was_late = ?, last_error = NULL WHERE id = ?", now(), job.was_late, job.id);
        if (!printerState.ok) { printerState.ok = true; printerState.error = null; broadcast('printer', { ok: true }); }
        printerState.last_ok_at = now();
        broadcast('tickets');
      } catch (e) {
        const msg = String(e.message || e);
        run('UPDATE print_jobs SET attempts = attempts + 1, last_error = ? WHERE id = ?', msg, job.id);
        const firstFailure = job.attempts === 0;
        printerState.ok = false; printerState.error = msg;
        if (firstFailure) broadcast('ticket_failed', { job_id: job.id, user_id: job.user_id, table: job.content.table, error: msg });
        broadcast('printer', { ok: false, error: msg });
        break; // keep the order of tickets: do not jump over a failed one
      }
    }
  } finally {
    if (db) printerState.waiting = get("SELECT COUNT(*) AS n FROM print_jobs WHERE status = 'waiting'").n;
    busy = false;
  }
}

export function startQueue(intervalMs = 3000) {
  stopQueue();
  timer = setInterval(pump, intervalMs);
  timer.unref();
  setImmediate(pump);
}
export function stopQueue() { if (timer) clearInterval(timer); timer = null; }

export function listTickets(dayId, limit = 300) {
  const rows = dayId
    ? all('SELECT j.*, u.name AS user_name FROM print_jobs j LEFT JOIN users u ON u.id = j.user_id WHERE j.day_id = ? ORDER BY j.id DESC LIMIT ?', dayId, limit)
    : all('SELECT j.*, u.name AS user_name FROM print_jobs j LEFT JOIN users u ON u.id = j.user_id ORDER BY j.id DESC LIMIT ?', limit);
  return rows.map((r) => { const j = parse(r); return { ...j, text: ticketText(j) }; });
}

export function reprint(jobId, userId) {
  const j = get('SELECT * FROM print_jobs WHERE id = ?', jobId);
  if (!j) return null;
  // Keep the original kind, so a reprinted cancellation still prints as a cancellation. The COPY banner
  // rides along inside the content; reports count a reprint by that flag (or by the old kind 'copy').
  const content = { ...JSON.parse(j.content), copy: true };
  return enqueueTicket({ day_id: j.day_id, order_id: j.order_id, batch_id: j.batch_id, user_id: userId, kind: j.kind, content, original_time: j.original_time });
}

// A manager can drop a waiting ticket, for drinks that were already made by voice during an outage.
export function skip(jobId) {
  run("UPDATE print_jobs SET status = 'skipped' WHERE id = ? AND status = 'waiting'", jobId);
  setImmediate(pump);
}
