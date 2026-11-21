import { get, all } from '../db.js';
import { now } from '../clock.js';
import { HttpError } from '../http.js';
import { sessionTotals, lineTotal } from './orders.js';

export function listDays(limit = 60) {
  return all(`SELECT d.*, uo.name AS opened_by_name, uc.name AS closed_by_name FROM business_days d
    LEFT JOIN users uo ON uo.id = d.opened_by LEFT JOIN users uc ON uc.id = d.closed_by ORDER BY d.id DESC LIMIT ?`, limit);
}

export function dayReport(dayId) {
  const day = dayId
    ? get(`SELECT d.*, uo.name AS opened_by_name, uc.name AS closed_by_name FROM business_days d LEFT JOIN users uo ON uo.id = d.opened_by LEFT JOIN users uc ON uc.id = d.closed_by WHERE d.id = ?`, dayId)
    : get(`SELECT d.*, uo.name AS opened_by_name, uc.name AS closed_by_name FROM business_days d LEFT JOIN users uo ON uo.id = d.opened_by LEFT JOIN users uc ON uc.id = d.closed_by ORDER BY d.id DESC LIMIT 1`);
  if (!day) throw new HttpError(404, 'no_day');
  const from = day.opened_at, to = day.closed_at || now();
  const pays = all('SELECT p.*, u.name AS user_name, a.name AS approved_by_name FROM payments p JOIN orders o ON o.id = p.order_id JOIN users u ON u.id = p.user_id LEFT JOIN users a ON a.id = p.approved_by WHERE o.day_id = ?', day.id);
  const cash = pays.filter((p) => p.type === 'cash').reduce((s, p) => s + p.amount_cents, 0);
  const house = pays.filter((p) => p.type === 'house').reduce((s, p) => s + p.amount_cents, 0);
  const sessions = all('SELECT id FROM sessions WHERE day_id = ? ORDER BY id', day.id).map((s) => sessionTotals(s.id));
  const payouts = all(`SELECT c.*, u.name AS user_name, a.name AS approved_by_name FROM cash_movements c LEFT JOIN sessions s ON s.id = c.session_id
    LEFT JOIN users u ON u.id = s.user_id LEFT JOIN users a ON a.id = c.approved_by WHERE c.day_id = ? AND c.type = 'payout' ORDER BY c.id`, day.id);

  const items = all(`SELECT i.*, p.created_at AS paid_at, p.type AS pay_type, c.name AS category FROM order_items i
    JOIN orders o ON o.id = i.order_id JOIN payments p ON p.id = i.payment_id
    LEFT JOIN products pr ON pr.id = i.product_id LEFT JOIN categories c ON c.id = pr.category_id
    WHERE o.day_id = ? AND i.status = 'sent'`, day.id);
  const group = (keyFn) => { const m = new Map(); for (const i of items) { const k = keyFn(i); const e = m.get(k) || { key: k, qty: 0, cents: 0 }; e.qty += i.qty; e.cents += lineTotal(i); m.set(k, e); } return [...m.values()]; };
  const byCategory = group((i) => i.category || '?').sort((a, b) => b.cents - a.cents);
  const byItem = group((i) => i.name).sort((a, b) => b.qty - a.qty);
  const byHour = group((i) => new Date(i.paid_at).getHours()).sort((a, b) => a.key - b.key);

  const log = all('SELECT l.*, u.name AS user_name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.at >= ? AND l.at <= ? ORDER BY l.id', from, to)
    .map((l) => ({ ...l, detail: safeJson(l.detail) }));
  const names = new Map(all('SELECT id, name FROM users').map((u) => [u.id, u.name]));
  const withApprover = (l) => ({ at: l.at, user_name: l.user_name, order_id: l.target, ...l.detail, approved_by_name: names.get(l.detail?.approved_by) || null });
  const voids = log.filter((l) => l.action === 'void').map(withApprover);
  const discounts = log.filter((l) => l.action === 'discount').map(withApprover);
  const comps = log.filter((l) => l.action === 'on_the_house').map(withApprover);
  const quick = new Map();
  for (const l of log.filter((x) => x.action === 'quick_cancel')) quick.set(l.user_name, (quick.get(l.user_name) || 0) + 1);
  const passes = log.filter((l) => l.action === 'pass_table').map((l) => ({ at: l.at, by: l.user_name, order_id: l.target, from: names.get(l.detail?.from), to: names.get(l.detail?.to) }));

  const jobs = all('SELECT kind, content, was_late, status FROM print_jobs WHERE day_id = ?', day.id);
  const isCopy = (j) => j.kind === 'copy' || safeJson(j.content)?.copy === true; // old rows used kind 'copy'
  const openDue = all(`SELECT i.* FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.day_id = ? AND o.status = 'open' AND i.status = 'sent' AND i.payment_id IS NULL`, day.id)
    .reduce((s, i) => s + lineTotal(i), 0);
  return {
    day, totals: { sales_cents: cash + house, cash_cents: cash, house_cents: house, payout_cents: payouts.reduce((s, p) => s + p.amount_cents, 0),
      tables_paid: get("SELECT COUNT(*) AS n FROM orders WHERE day_id = ? AND status = 'paid'", day.id).n, open_due_cents: openDue },
    sessions, payouts, by_category: byCategory, by_item: byItem, by_hour: byHour,
    voids, discounts, comps, quick_cancels: [...quick].map(([user_name, count]) => ({ user_name, count })), passes,
    tickets: { printed: jobs.filter((j) => j.status === 'printed').length, late: jobs.filter((j) => j.was_late).length,
      reprints: jobs.filter(isCopy).length, skipped: jobs.filter((j) => j.status === 'skipped').length },
    catch_up_orders: get('SELECT COUNT(*) AS n FROM orders WHERE day_id = ? AND entered_late = 1', day.id).n,
  };
}

const safeJson = (s) => { try { return JSON.parse(s); } catch { return s; } };
const eur = (c) => (c / 100).toFixed(2);
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

export function dayReportCsv(dayId) {
  const r = dayReport(dayId), rows = [];
  const add = (...cells) => rows.push(cells.map(csvCell).join(','));
  const dt = (ms) => (ms ? new Date(ms).toLocaleString('sv-SE') : '');
  add('Day', r.day.id); add('Opened', dt(r.day.opened_at), r.day.opened_by_name); add('Closed', dt(r.day.closed_at), r.day.closed_by_name || ''); add();
  add('Total sales', eur(r.totals.sales_cents)); add('Cash', eur(r.totals.cash_cents)); add('On the house', eur(r.totals.house_cents)); add('Payouts', eur(r.totals.payout_cents)); add();
  add('Staff', 'Float', 'Cash sales', 'Payouts', 'Owed', 'Handed over', 'Difference');
  for (const s of r.sessions) add(s.user_name, eur(s.float_cents), eur(s.cash_cents), eur(s.payout_cents), eur(s.expected_cents ?? s.owed_cents), s.handed_cents == null ? '' : eur(s.handed_cents), s.difference_cents == null ? '' : eur(s.difference_cents));
  add(); add('Category', 'Qty', 'Amount'); for (const c of r.by_category) add(c.key, c.qty, eur(c.cents));
  add(); add('Item', 'Qty', 'Amount'); for (const c of r.by_item) add(c.key, c.qty, eur(c.cents));
  add(); add('Hour', 'Qty', 'Amount'); for (const c of r.by_hour) add(c.key + ':00', c.qty, eur(c.cents));
  add(); add('Voids', 'By', 'Item', 'Qty', 'Reason', 'Approved by'); for (const v of r.voids) add(dt(v.at), v.user_name, v.item, v.qty, v.reason, v.approved_by_name || '');
  add(); add('On the house', 'By', 'Amount', 'Approved by'); for (const v of r.comps) add(dt(v.at), v.user_name, eur(v.amount_cents), v.approved_by_name || '');
  add(); add('Payouts', 'Amount', 'Reason', 'From', 'Approved by'); for (const p of r.payouts) add(dt(p.created_at), eur(p.amount_cents), p.reason, p.user_name || 'house', p.approved_by_name || '');
  return '﻿' + rows.join('\r\n') + '\r\n';
}
