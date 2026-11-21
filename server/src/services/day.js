import { get, all, run, tx } from '../db.js';
import { now } from '../clock.js';
import { bad, conflict, HttpError, int } from '../http.js';
import { audit } from './audit.js';
import { broadcast } from './events.js';
import { currentDay, requireDay, ensureSession, sessionTotals, guardClock } from './orders.js';
import { runBackup } from './backup.js';

export function dayView() {
  const day = currentDay();
  const last = get("SELECT * FROM business_days WHERE status = 'closed' ORDER BY id DESC LIMIT 1");
  if (!day) return { day: null, last_closed: last || null };
  const sessions = all('SELECT id FROM sessions WHERE day_id = ? ORDER BY id', day.id).map((s) => sessionTotals(s.id));
  const openOrders = get("SELECT COUNT(*) AS n FROM orders WHERE status = 'open'").n;
  const payouts = all('SELECT c.*, u.name AS user_name FROM cash_movements c LEFT JOIN sessions s ON s.id = c.session_id LEFT JOIN users u ON u.id = s.user_id WHERE c.day_id = ? AND c.type = ? ORDER BY c.id', day.id, 'payout');
  return { day: { ...day, catch_up: !!day.catch_up, hours_open: (now() - day.opened_at) / 3_600_000 }, sessions, open_orders: openOrders, payouts };
}

export function openBusinessDay(ctx) {
  return tx(() => {
    guardClock();
    if (currentDay()) throw conflict('day_open', 'A business day is already open');
    run('INSERT INTO business_days(opened_by, opened_at) VALUES(?, ?)', ctx.user.id, now());
    audit(ctx, 'day_open');
    broadcast('day');
    return dayView();
  });
}

export async function closeBusinessDay(ctx) {
  const result = tx(() => {
    const day = requireDay();
    const open = all(`SELECT o.id, t.name AS table_name, u.name AS waiter_name FROM orders o JOIN tables t ON t.id = o.table_id JOIN users u ON u.id = o.waiter_id WHERE o.status = 'open'`);
    if (open.length) throw conflict('open_tables', 'Some tables are still open', { tables: open });
    const pending = [];
    for (const s of all('SELECT id FROM sessions WHERE day_id = ? AND settled_at IS NULL', day.id)) {
      const t = sessionTotals(s.id);
      if (t.owed_cents === 0 && t.cash_cents === 0 && t.house_cents === 0 && t.float_cents === 0) {
        run('UPDATE sessions SET expected_cents = 0, handed_cents = 0, difference_cents = 0, confirmed_by = ?, settled_at = ? WHERE id = ?', ctx.user.id, now(), s.id);
      } else pending.push({ id: t.id, user_name: t.user_name, owed_cents: t.owed_cents });
    }
    if (pending.length) throw conflict('unsettled_sessions', 'Some staff have not settled yet', { sessions: pending });
    run("UPDATE business_days SET status = 'closed', closed_by = ?, closed_at = ?, catch_up = 0 WHERE id = ?", ctx.user.id, now(), day.id);
    audit(ctx, 'day_close', day.id);
    return { closed_day_id: day.id };
  });
  broadcast('day');
  try { result.backup = await runBackup('day-close'); } catch (e) { result.backup_error = String(e.message || e); }
  return result;
}

export function setCatchUp(ctx, on) {
  const day = requireDay();
  run('UPDATE business_days SET catch_up = ? WHERE id = ?', on ? 1 : 0, day.id);
  audit(ctx, on ? 'catch_up_on' : 'catch_up_off');
  broadcast('day');
  return dayView();
}

export function giveFloat(ctx, body) {
  const amount = int(body.amount_cents, 'amount_cents');
  if (amount <= 0) throw bad('bad_amount');
  return tx(() => {
    const day = requireDay();
    const s = ensureSession(int(body.user_id, 'user_id'));
    run('UPDATE sessions SET float_cents = float_cents + ? WHERE id = ?', amount, s.id);
    run("INSERT INTO cash_movements(day_id, session_id, type, amount_cents, reason, approved_by, created_at) VALUES(?,?,'float',?,?,?,?)", day.id, s.id, amount, 'float', ctx.user.id, now());
    audit(ctx, 'float', s.id, { amount_cents: amount });
    broadcast('day');
    return sessionTotals(s.id);
  });
}

export function payout(ctx, body) {
  const amount = int(body.amount_cents, 'amount_cents');
  const reason = String(body.reason || '').trim().slice(0, 100);
  if (amount <= 0) throw bad('bad_amount');
  if (!reason) throw bad('reason_required');
  return tx(() => {
    const day = requireDay();
    let sessionId = null;
    if (body.session_id != null) {
      const s = get('SELECT * FROM sessions WHERE id = ? AND day_id = ? AND settled_at IS NULL', int(body.session_id, 'session_id'), day.id);
      if (!s) throw bad('no_session');
      sessionId = s.id;
    }
    run("INSERT INTO cash_movements(day_id, session_id, type, amount_cents, reason, approved_by, created_at) VALUES(?,?,'payout',?,?,?,?)", day.id, sessionId, amount, reason, ctx.user.id, now());
    audit(ctx, 'payout', sessionId, { amount_cents: amount, reason });
    broadcast('day');
    return dayView();
  });
}

export function settle(ctx, sessionId, body) {
  const handed = int(body.handed_cents, 'handed_cents');
  if (handed < 0) throw bad('bad_amount');
  return tx(() => {
    const t = sessionTotals(sessionId);
    if (t.settled_at) throw conflict('already_settled');
    if (t.open_tables.length) throw conflict('open_tables', 'This person still has open tables. Pass them to someone or close them first.', { tables: t.open_tables });
    run('UPDATE sessions SET expected_cents = ?, handed_cents = ?, difference_cents = ?, confirmed_by = ?, settled_at = ? WHERE id = ?',
      t.owed_cents, handed, handed - t.owed_cents, ctx.user.id, now(), sessionId);
    audit(ctx, 'settle', sessionId, { expected_cents: t.owed_cents, handed_cents: handed });
    broadcast('day');
    return sessionTotals(sessionId);
  });
}
