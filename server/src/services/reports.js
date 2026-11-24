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
    stock: stockReport(from, to + 1),
  };
}

// ---------------------------------------------------------------- stock: what was used, what it cost, what was lost
// Cost of a line is what its stock cost when it was sent (order_items.cost_cents), so a later price never rewrites
// an old day. A line sold before any delivery had a price has no cost, and is counted as such instead of as zero.
export function stockReport(from, to) {
  const paid = all(`SELECT i.name, i.qty, i.price_cents, i.discount_pct, i.cost_cents, i.stock, p.type FROM order_items i JOIN payments p ON p.id = i.payment_id
    WHERE i.status = 'sent' AND p.created_at >= ? AND p.created_at < ?`, from, to);
  const by = new Map();
  let revenue = 0, cost = 0, houseCost = 0, noCost = 0;
  for (const i of paid) {
    if (!i.stock) continue;                        // not tracked
    const e = by.get(i.name) || { name: i.name, qty: 0, sales_cents: 0, cost_cents: 0, no_cost_qty: 0, house_qty: 0 };
    const c = i.cost_cents == null ? null : i.cost_cents * i.qty;
    if (i.type === 'house') { e.house_qty += i.qty; if (c != null) houseCost += c; }
    else {
      e.qty += i.qty;
      if (c == null) { e.no_cost_qty += i.qty; noCost += i.qty; }
      else { const sale = lineTotal(i); e.sales_cents += sale; e.cost_cents += c; revenue += sale; cost += c; }
    }
    by.set(i.name, e);
  }
  const products = [...by.values()].map((e) => ({ ...e, profit_cents: e.sales_cents - e.cost_cents })).sort((a, b) => b.profit_cents - a.profit_cents);
  const madeAndThrown = get(`SELECT COALESCE(SUM(cost_cents * qty), 0) AS v, COALESCE(SUM(qty), 0) AS n FROM order_items
    WHERE status = 'void' AND void_stock = 'waste' AND voided_at >= ? AND voided_at < ?`, from, to);
  const moveSum = (kind) => get('SELECT COALESCE(SUM(cost_cents), 0) AS v, COUNT(*) AS n FROM stock_moves WHERE kind = ? AND at >= ? AND at < ?', kind, from, to);
  const shelfWaste = moveSum('waste'), counts = moveSum('count');
  const items = all(`SELECT s.id, s.name, s.unit, s.pack_name, s.pack_size,
      COALESCE(SUM(CASE WHEN m.kind = 'sale' THEN -m.delta WHEN m.kind = 'return' THEN -m.delta ELSE 0 END), 0) AS used,
      COALESCE(SUM(CASE WHEN m.kind = 'delivery' THEN m.delta ELSE 0 END), 0) AS delivered,
      COALESCE(SUM(CASE WHEN m.kind = 'waste' THEN -m.delta ELSE 0 END), 0) AS wasted,
      COALESCE(SUM(CASE WHEN m.kind = 'count' THEN m.delta ELSE 0 END), 0) AS counted_diff,
      COALESCE(SUM(CASE WHEN m.kind = 'delivery' THEN m.cost_cents ELSE 0 END), 0) AS bought_cents
    FROM stock_items s JOIN stock_moves m ON m.stock_item_id = s.id AND m.at >= ? AND m.at < ? GROUP BY s.id ORDER BY s.sort, s.name`, from, to);
  return {
    totals: { revenue_cents: revenue, cost_cents: cost, profit_cents: revenue - cost, house_cost_cents: houseCost, no_cost_qty: noCost,
      waste_cents: madeAndThrown.v + shelfWaste.v, waste_made_qty: madeAndThrown.n, count_diff_cents: counts.v,
      bought_cents: items.reduce((x, i) => x + i.bought_cents, 0) },
    products, items,
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
  stockCsv(add, r.stock);
  return '﻿' + rows.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- any period: a day, a month, a year, chosen dates
const FOREVER = 9e15;
// from and to are calendar dates 'YYYY-MM-DD', both included, in the PC's own time zone. Missing means open ended.
export function parseRange(q = {}) {
  const at = (s, plus = 0) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3] + plus).getTime() : null; };
  const from = at(q.from) ?? 0, to = at(q.to, 1) ?? FOREVER;
  if (to <= from) throw new HttpError(400, 'bad_range', 'The end date is before the start date');
  return { from, to };
}
const LOCAL = (col, fmt) => `strftime('${fmt}', ${col} / 1000, 'unixepoch', 'localtime')`;
const LINE = 'ROUND(i.price_cents * i.qty * (100 - i.discount_pct) / 100.0)';

export function rangeReport(from, to) {
  const tot = get(`SELECT COALESCE(SUM(CASE WHEN type = 'cash' THEN amount_cents ELSE 0 END), 0) AS cash,
      COALESCE(SUM(CASE WHEN type = 'house' THEN amount_cents ELSE 0 END), 0) AS house, COUNT(*) AS payments, COUNT(DISTINCT order_id) AS orders
    FROM payments WHERE created_at >= ? AND created_at < ?`, from, to);
  const bucket = (fmt) => all(`SELECT ${LOCAL('p.created_at', fmt)} AS key,
      SUM(CASE WHEN p.type = 'cash' THEN p.amount_cents ELSE 0 END) AS cash, SUM(CASE WHEN p.type = 'house' THEN p.amount_cents ELSE 0 END) AS house,
      SUM(p.amount_cents) AS cents, COUNT(DISTINCT p.order_id) AS qty
    FROM payments p WHERE p.created_at >= ? AND p.created_at < ? GROUP BY key ORDER BY key`, from, to);
  const byDay = bucket('%Y-%m-%d');
  const items = (key) => all(`SELECT ${key} AS key, SUM(i.qty) AS qty, CAST(SUM(${LINE}) AS INTEGER) AS cents
    FROM order_items i JOIN payments p ON p.id = i.payment_id LEFT JOIN products pr ON pr.id = i.product_id LEFT JOIN categories c ON c.id = pr.category_id
    WHERE i.status = 'sent' AND p.created_at >= ? AND p.created_at < ? GROUP BY key`, from, to);
  const payouts = all(`SELECT c.id, c.created_at, c.amount_cents, c.reason, u.name AS user_name, a.name AS approved_by_name FROM cash_movements c
    LEFT JOIN sessions s ON s.id = c.session_id LEFT JOIN users u ON u.id = s.user_id LEFT JOIN users a ON a.id = c.approved_by
    WHERE c.type = 'payout' AND c.created_at >= ? AND c.created_at < ? ORDER BY c.id DESC LIMIT 500`, from, to);
  const payoutTotal = get("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM cash_movements WHERE type = 'payout' AND created_at >= ? AND created_at < ?", from, to).n;
  const diff = get(`SELECT COALESCE(SUM(CASE WHEN difference_cents > 0 THEN difference_cents ELSE 0 END), 0) AS surplus,
      COALESCE(SUM(CASE WHEN difference_cents < 0 THEN difference_cents ELSE 0 END), 0) AS shortage, COUNT(*) AS settled
    FROM sessions WHERE settled_at >= ? AND settled_at < ?`, from, to);
  const acts = Object.fromEntries(all(`SELECT action, COUNT(*) AS n FROM audit_log WHERE at >= ? AND at < ?
    AND action IN ('void', 'quick_cancel', 'discount', 'on_the_house') GROUP BY action`, from, to).map((r) => [r.action, r.n]));
  return {
    from, to: to >= FOREVER ? null : to,
    totals: { sales_cents: tot.cash + tot.house, cash_cents: tot.cash, house_cents: tot.house, payout_cents: payoutTotal, kept_cents: tot.cash - payoutTotal,
      tables_paid: get("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid' AND closed_at >= ? AND closed_at < ?", from, to).n,
      payments: tot.payments, days_with_sales: byDay.length, surplus_cents: diff.surplus, shortage_cents: diff.shortage,
      voids: acts.void || 0, quick_cancels: acts.quick_cancel || 0, discounts: acts.discount || 0, comps: acts.on_the_house || 0 },
    by_day: byDay, by_month: byDay.length > 62 ? bucket('%Y-%m') : [], by_hour: bucket('%H').map((r) => ({ ...r, key: Number(r.key) })),
    by_category: items("COALESCE(c.name, '?')").sort((a, b) => b.cents - a.cents), by_item: items('i.name').sort((a, b) => b.qty - a.qty).slice(0, 200),
    by_staff: all(`SELECT u.name AS key, SUM(CASE WHEN p.type = 'cash' THEN p.amount_cents ELSE 0 END) AS cash, SUM(p.amount_cents) AS cents, COUNT(DISTINCT p.order_id) AS qty
      FROM payments p JOIN users u ON u.id = p.user_id WHERE p.created_at >= ? AND p.created_at < ? GROUP BY u.id ORDER BY cents DESC`, from, to),
    payouts, stock: stockReport(from, to),
  };
}

function stockCsv(add, st) {
  if (!st || (!st.products.length && !st.items.length)) return;
  const t = st.totals;
  add(); add('Stock sales (tracked)', eur(t.revenue_cents)); add('Cost of goods', eur(t.cost_cents)); add('Gross profit', eur(t.profit_cents));
  add('On the house cost', eur(t.house_cost_cents)); add('Waste', eur(t.waste_cents)); add('Count differences', eur(t.count_diff_cents));
  add('Bought', eur(t.bought_cents)); if (t.no_cost_qty) add('Sold without a cost', t.no_cost_qty);
  add(); add('Product', 'Qty', 'Sales', 'Cost', 'Profit', 'On the house', 'No cost');
  for (const p of st.products) add(p.name, p.qty, eur(p.sales_cents), eur(p.cost_cents), eur(p.profit_cents), p.house_qty, p.no_cost_qty);
  add(); add('Stock item', 'Used', 'Delivered', 'Wasted', 'Count difference', 'Unit');
  for (const i of st.items) add(i.name, i.used, i.delivered, i.wasted, i.counted_diff, i.unit);
}

export function rangeReportCsv(from, to) {
  const r = rangeReport(from, to), rows = [];
  const add = (...cells) => rows.push(cells.map(csvCell).join(','));
  const d = (ms) => (ms ? new Date(ms).toLocaleDateString('sv-SE') : '');
  add('From', from ? d(from) : 'start'); add('To', r.to ? d(r.to - 1) : 'now'); add();
  add('Total sales', eur(r.totals.sales_cents)); add('Cash', eur(r.totals.cash_cents)); add('On the house', eur(r.totals.house_cents));
  add('Payouts', eur(r.totals.payout_cents)); add('Cash kept', eur(r.totals.kept_cents)); add('Tables paid', r.totals.tables_paid);
  add('Surplus at settling', eur(r.totals.surplus_cents)); add('Shortage at settling', eur(r.totals.shortage_cents)); add();
  add('Day', 'Tables', 'Cash', 'On the house', 'Total'); for (const x of r.by_day) add(x.key, x.qty, eur(x.cash), eur(x.house), eur(x.cents));
  add(); add('Staff', 'Tables', 'Cash', 'Total'); for (const x of r.by_staff) add(x.key, x.qty, eur(x.cash), eur(x.cents));
  add(); add('Category', 'Qty', 'Amount'); for (const x of r.by_category) add(x.key, x.qty, eur(x.cents));
  add(); add('Item', 'Qty', 'Amount'); for (const x of r.by_item) add(x.key, x.qty, eur(x.cents));
  add(); add('Payout', 'Amount', 'Reason', 'From', 'Approved by'); for (const p of r.payouts) add(new Date(p.created_at).toLocaleString('sv-SE'), eur(p.amount_cents), p.reason, p.user_name || 'house', p.approved_by_name || '');
  stockCsv(add, r.stock);
  return '﻿' + rows.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- staff: what each person did in a period
export function staffReport(from, to) {
  const by = (rows, key = 'user_id') => new Map(rows.map((r) => [r[key], r]));
  const pay = by(all(`SELECT user_id, SUM(CASE WHEN type = 'cash' THEN amount_cents ELSE 0 END) AS cash, SUM(CASE WHEN type = 'house' THEN amount_cents ELSE 0 END) AS house,
    COUNT(*) AS payments, COUNT(DISTINCT order_id) AS tables FROM payments WHERE created_at >= ? AND created_at < ? GROUP BY user_id`, from, to));
  const sent = by(all("SELECT sent_by AS user_id, SUM(qty) AS items FROM order_items WHERE status = 'sent' AND sent_at >= ? AND sent_at < ? GROUP BY sent_by", from, to));
  const ses = by(all(`SELECT user_id, COUNT(*) AS sessions, SUM(CASE WHEN settled_at IS NOT NULL THEN 1 ELSE 0 END) AS settled,
    COALESCE(SUM(difference_cents), 0) AS difference, COALESCE(SUM(CASE WHEN difference_cents > 0 THEN difference_cents ELSE 0 END), 0) AS surplus,
    COALESCE(SUM(CASE WHEN difference_cents < 0 THEN difference_cents ELSE 0 END), 0) AS shortage, MAX(started_at) AS last_at
    FROM sessions WHERE started_at >= ? AND started_at < ? GROUP BY user_id`, from, to));
  const acts = new Map();
  for (const r of all(`SELECT user_id, action, COUNT(*) AS n FROM audit_log WHERE at >= ? AND at < ? AND action IN ('void', 'quick_cancel', 'discount') GROUP BY user_id, action`, from, to)) {
    const a = acts.get(r.user_id) || {}; a[r.action] = r.n; acts.set(r.user_id, a);
  }
  return all('SELECT id, name, role, active FROM users ORDER BY active DESC, name').map((u) => {
    const p = pay.get(u.id) || {}, s = ses.get(u.id) || {}, a = acts.get(u.id) || {};
    return { id: u.id, name: u.name, role: u.role, active: u.active,
      sales_cents: (p.cash || 0) + (p.house || 0), cash_cents: p.cash || 0, house_cents: p.house || 0, tables: p.tables || 0, items: sent.get(u.id)?.items || 0,
      sessions: s.sessions || 0, settled: s.settled || 0, surplus_cents: s.surplus || 0, shortage_cents: s.shortage || 0, difference_cents: s.difference || 0,
      voids: a.void || 0, quick_cancels: a.quick_cancel || 0, discounts: a.discount || 0, last_at: s.last_at || null };
  });
}

export function staffDetail(userId, from, to) {
  const row = staffReport(from, to).find((u) => u.id === userId);
  if (!row) throw new HttpError(404, 'no_user');
  const sessions = all(`SELECT s.id, s.started_at, s.settled_at, s.float_cents, s.expected_cents, s.handed_cents, s.difference_cents, c.name AS confirmed_by_name,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE session_id = s.id AND type = 'cash') AS cash_cents,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE session_id = s.id AND type = 'house') AS house_cents,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM cash_movements WHERE session_id = s.id AND type = 'payout') AS payout_cents
    FROM sessions s LEFT JOIN users c ON c.id = s.confirmed_by WHERE s.user_id = ? AND s.started_at >= ? AND s.started_at < ? ORDER BY s.id DESC LIMIT 400`, userId, from, to);
  const byDay = all(`SELECT ${LOCAL('p.created_at', '%Y-%m-%d')} AS key, SUM(p.amount_cents) AS cents, COUNT(DISTINCT p.order_id) AS qty
    FROM payments p WHERE p.user_id = ? AND p.created_at >= ? AND p.created_at < ? GROUP BY key ORDER BY key DESC LIMIT 400`, userId, from, to);
  const topItems = all(`SELECT i.name AS key, SUM(i.qty) AS qty, CAST(SUM(${LINE}) AS INTEGER) AS cents FROM order_items i
    WHERE i.sent_by = ? AND i.status = 'sent' AND i.sent_at >= ? AND i.sent_at < ? GROUP BY i.name ORDER BY qty DESC LIMIT 15`, userId, from, to);
  return { ...row, session_list: sessions, by_day: byDay, top_items: topItems };
}
