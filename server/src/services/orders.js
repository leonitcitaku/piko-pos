import { get, all, run, tx, getSetting, setSetting } from '../db.js';
import { now } from '../clock.js';
import { bad, conflict, HttpError, int } from '../http.js';
import { audit } from './audit.js';
import { broadcast } from './events.js';
import { enqueueTicket } from '../print/queue.js';
import { approve } from '../auth.js';
import { fiscalOrderPaid } from '../fiscal/index.js';
import * as stock from './stock.js';

// Refuse to record anything if the PC clock has jumped backwards (dead battery after a power cut).
export function guardClock() {
  const last = Number(getSetting('last_event_at', '0'));
  const t = now();
  if (last && t < last - 5 * 60_000) throw conflict('clock_wrong', 'The PC clock is earlier than the last sale. Fix the clock first.');
  if (t > last) setSetting('last_event_at', t);
  return t;
}

export const currentDay = () => get("SELECT * FROM business_days WHERE status = 'open' ORDER BY id DESC LIMIT 1");
export function requireDay() {
  const d = currentDay();
  if (!d) throw conflict('day_closed', 'No business day is open');
  return d;
}

export function ensureSession(userId) {
  const day = requireDay();
  let s = get('SELECT * FROM sessions WHERE day_id = ? AND user_id = ? AND settled_at IS NULL', day.id, userId);
  if (!s) {
    const id = run('INSERT INTO sessions(day_id, user_id, started_at) VALUES(?,?,?)', day.id, userId, now()).lastInsertRowid;
    s = get('SELECT * FROM sessions WHERE id = ?', id);
  }
  return s;
}

export const lineTotal = (it, qty = it.qty) => Math.round((it.price_cents * qty * (100 - it.discount_pct)) / 100);

export function orderView(id) {
  const o = get(`SELECT o.*, t.name AS table_name, z.name AS zone_name, u.name AS waiter_name
    FROM orders o JOIN tables t ON t.id = o.table_id JOIN zones z ON z.id = t.zone_id JOIN users u ON u.id = o.waiter_id
    WHERE o.id = ?`, id);
  if (!o) throw new HttpError(404, 'no_order');
  const items = all(`SELECT i.*, u.name AS sent_by_name FROM order_items i JOIN users u ON u.id = i.sent_by WHERE i.order_id = ? ORDER BY i.id`, id)
    .map((i) => ({ ...i, modifiers: JSON.parse(i.modifiers), total_cents: lineTotal(i) }));
  const live = items.filter((i) => i.status === 'sent');
  const total = live.reduce((s, i) => s + i.total_cents, 0);
  const paid = live.filter((i) => i.payment_id).reduce((s, i) => s + i.total_cents, 0);
  return { ...o, items, total_cents: total, paid_cents: paid, due_cents: total - paid, server_time: now(),
    cancel_window_sec: Number(getSetting('cancel_window_sec', '120')) };
}

function openOrderRow(id) {
  const o = get('SELECT * FROM orders WHERE id = ?', id);
  if (!o) throw new HttpError(404, 'no_order');
  if (o.status !== 'open') throw conflict('order_closed', 'This order is already closed');
  return o;
}

function closeIfDone(ctx, orderId) {
  const items = all("SELECT * FROM order_items WHERE order_id = ?", orderId);
  if (!items.length) return;
  const live = items.filter((i) => i.status === 'sent');
  let status = null;
  if (live.length === 0) status = 'void';
  else if (live.every((i) => i.payment_id)) status = 'paid';
  if (!status) return;
  run('UPDATE orders SET status = ?, closed_at = ? WHERE id = ?', status, now(), orderId);
  if (status === 'paid') fiscalOrderPaid(orderId);
}

export function tablesView() {
  const rows = all(`SELECT t.id, t.name, t.zone_id, t.px, t.py, t.pw, t.ph, t.shape, o.id AS order_id, o.waiter_id, u.name AS waiter_name, o.opened_at
    FROM tables t LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'open' LEFT JOIN users u ON u.id = o.waiter_id
    WHERE t.active = 1 ORDER BY t.zone_id, t.sort, t.id`);
  const dues = new Map();
  for (const i of all(`SELECT i.* FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.status = 'open' AND i.status = 'sent'`)) {
    const d = dues.get(i.order_id) || { due: 0, count: 0, paid: 0 };
    if (i.payment_id) d.paid += lineTotal(i); else { d.due += lineTotal(i); d.count += i.qty; }
    dues.set(i.order_id, d);
  }
  return {
    zones: all('SELECT id, name FROM zones WHERE active = 1 ORDER BY sort, id'),
    plan: all('SELECT id, zone_id, kind, x, y, w, h, label FROM plan_items ORDER BY id'),
    tables: rows.map((r) => ({ ...r, due_cents: dues.get(r.order_id)?.due || 0, items: dues.get(r.order_id)?.count || 0,
      part_paid: (dues.get(r.order_id)?.paid || 0) > 0 })),
  };
}

export function openOrder(ctx, body) {
  const id = String(body.id || '');
  if (id.length < 8) throw bad('bad_id', 'The device must supply an order id');
  const tableId = int(body.table_id, 'table_id');
  return tx(() => {
    guardClock();
    const day = requireDay();
    const mine = get('SELECT * FROM orders WHERE id = ?', id);
    if (mine) return orderView(id);
    const table = get('SELECT * FROM tables WHERE id = ? AND active = 1', tableId);
    if (!table) throw bad('no_table');
    const existing = get("SELECT id FROM orders WHERE table_id = ? AND status = 'open'", tableId);
    if (existing) return orderView(existing.id);
    ensureSession(ctx.user.id);
    run('INSERT INTO orders(id, table_id, day_id, waiter_id, opened_at, entered_late) VALUES(?,?,?,?,?,?)',
      id, tableId, day.id, ctx.user.id, now(), day.catch_up ? 1 : 0);
    broadcast('tables');
    return orderView(id);
  });
}

function ticketContent(orderId, items, extra = {}) {
  const o = orderView(orderId);
  return {
    cafe: getSetting('cafe_name', 'Cafe'), table: o.table_name, zone: o.zone_name, order_id: orderId,
    lines: items.map((i) => ({ qty: i.qty, name: i.name, mods: (i.modifiers || []).map((m) => m.name), note: i.note || '' })),
    ...extra,
  };
}

export function addItems(ctx, orderId, body) {
  const batchId = String(body.batch_id || '');
  if (batchId.length < 8) throw bad('bad_id', 'The device must supply a batch id');
  if (!Array.isArray(body.items) || !body.items.length) throw bad('no_items');
  return tx(() => {
    if (get('SELECT 1 AS x FROM batches WHERE id = ?', batchId)) return orderView(orderId); // repeat send: ignore
    guardClock();
    const day = requireDay();
    const o = openOrderRow(orderId);
    const t = now();
    const made = [];
    for (const it of body.items) {
      const p = get('SELECT * FROM products WHERE id = ? AND active = 1', int(it.product_id, 'product_id'));
      if (!p) throw bad('no_product');
      if (!p.available) throw conflict('sold_out', `${p.name} is sold out`, { product_id: p.id });
      const qty = int(it.qty ?? 1, 'qty');
      if (qty < 1 || qty > 99) throw bad('bad_qty');
      const mods = (it.modifier_ids || []).map((mid) => {
        const m = get('SELECT * FROM modifiers WHERE id = ? AND active = 1', int(mid, 'modifier_id'));
        if (!m) throw bad('no_modifier');
        return { id: m.id, name: m.name, price_cents: m.price_cents };
      });
      const price = p.price_cents + mods.reduce((s, m) => s + m.price_cents, 0);
      const note = it.note ? String(it.note).slice(0, 80) : null;
      const r = run(`INSERT INTO order_items(order_id, product_id, name, price_cents, vat_rate, qty, modifiers, note, batch_id, sent_by, sent_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`, orderId, p.id, p.name, price, p.vat_rate, qty, JSON.stringify(mods), note, batchId, ctx.user.id, t);
      made.push({ id: Number(r.lastInsertRowid), qty, name: p.name, modifiers: mods, note });
      // Catch-up entries are real sales too, so they use stock like any other.
      stock.consumeForLine(ctx, Number(r.lastInsertRowid), p.id, mods.map((m) => m.id), qty);
    }
    run('INSERT INTO batches(id, order_id, created_at) VALUES(?,?,?)', batchId, orderId, t);
    ensureSession(ctx.user.id);
    if (o.waiter_id !== ctx.user.id) audit(ctx, 'serve_other_table', orderId, { waiter_id: o.waiter_id });
    if (day.catch_up) {
      run('UPDATE orders SET entered_late = 1 WHERE id = ?', orderId);
      audit(ctx, 'catch_up_entry', orderId, { batch_id: batchId });
    } else {
      const first = get('SELECT COUNT(*) AS n FROM batches WHERE order_id = ?', orderId).n === 1;
      enqueueTicket({ day_id: day.id, order_id: orderId, batch_id: batchId, user_id: ctx.user.id, kind: first ? 'order' : 'addition',
        content: ticketContent(orderId, made, { waiter: ctx.user.name }), original_time: t });
    }
    broadcast('tables');
    return orderView(orderId);
  });
}

export function cancelItem(ctx, orderId, body) {
  return tx(() => {
    guardClock();
    const o = openOrderRow(orderId);
    const it = get("SELECT * FROM order_items WHERE id = ? AND order_id = ?", int(body.item_id, 'item_id'), orderId);
    if (!it) throw bad('no_item');
    if (it.status !== 'sent') return orderView(orderId);
    if (it.payment_id) throw conflict('item_paid', 'This item is already paid');
    // Five Amerikano on one line, one spilled: cancel just that one. Missing qty means the whole line.
    const qty = body.qty == null ? it.qty : int(body.qty, 'qty');
    if (qty < 1 || qty > it.qty) throw bad('bad_qty');
    const windowMs = Number(getSetting('cancel_window_sec', '120')) * 1000;
    const quick = it.sent_by === ctx.user.id && now() - it.sent_at <= windowMs;
    const reason = String(body.reason || (quick ? 'mistake' : '')).slice(0, 60);
    let approver = null;
    if (!quick) {
      if (!reason) throw bad('reason_required');
      approver = approve(ctx, body.pin);
    }
    // Part of a line: the line keeps the rest, and the cancelled ones become a line of their own, so every
    // report, ticket and the audit see exactly what was cancelled, sent by whom and when.
    let voidId = it.id;
    if (qty < it.qty) {
      run('UPDATE order_items SET qty = ? WHERE id = ?', it.qty - qty, it.id);
      voidId = Number(run(`INSERT INTO order_items(order_id, product_id, name, price_cents, vat_rate, qty, modifiers, note, discount_pct, status, batch_id, sent_by, sent_at, stock, cost_cents)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, orderId, it.product_id, it.name, it.price_cents, it.vat_rate, qty, it.modifiers, it.note, it.discount_pct, 'sent', it.batch_id, it.sent_by, it.sent_at, it.stock, it.cost_cents).lastInsertRowid);
    }
    run("UPDATE order_items SET status = 'void', void_reason = ?, void_by = ?, voided_at = ? WHERE id = ?", reason, approver?.id ?? ctx.user.id, now(), voidId);
    // A mistake caught in time never left the bar: it goes back on the shelf. After that it was most likely made,
    // so it counts as thrown away, unless whoever approves the cancel says it goes back.
    const restock = body.restock == null ? quick : !!body.restock;
    stock.cancelLine(ctx, { ...it, id: voidId }, qty, restock ? 'return' : 'waste');
    audit(ctx, quick ? 'quick_cancel' : 'void', orderId, { item: it.name, qty, of: it.qty, reason, approved_by: approver?.id ?? null });
    const day = requireDay();
    if (!day.catch_up) {
      enqueueTicket({ day_id: day.id, order_id: orderId, batch_id: null, user_id: ctx.user.id, kind: 'cancel',
        content: ticketContent(orderId, [{ ...it, qty, modifiers: JSON.parse(it.modifiers) }], { waiter: ctx.user.name }), original_time: now() });
    }
    closeIfDone(ctx, orderId);
    broadcast('tables');
    return get('SELECT status FROM orders WHERE id = ?', orderId).status === 'open' ? orderView(orderId) : { ...orderView(orderId), closed: true };
  });
}

export function discount(ctx, orderId, body) {
  const pct = int(body.pct, 'pct');
  if (pct < 0 || pct > 100) throw bad('bad_pct');
  return tx(() => {
    guardClock(); openOrderRow(orderId);
    const approver = approve(ctx, body.pin);
    run("UPDATE order_items SET discount_pct = ? WHERE order_id = ? AND status = 'sent' AND payment_id IS NULL", pct, orderId);
    audit(ctx, 'discount', orderId, { pct, approved_by: approver.id });
    broadcast('tables');
    return orderView(orderId);
  });
}

export function moveOrder(ctx, orderId, body) {
  const tableId = int(body.table_id, 'table_id');
  return tx(() => {
    openOrderRow(orderId);
    if (!get('SELECT 1 AS x FROM tables WHERE id = ? AND active = 1', tableId)) throw bad('no_table');
    if (get("SELECT 1 AS x FROM orders WHERE table_id = ? AND status = 'open' AND id != ?", tableId, orderId)) throw conflict('table_busy', 'That table has an open order. Merge instead.');
    run('UPDATE orders SET table_id = ? WHERE id = ?', tableId, orderId);
    audit(ctx, 'move_table', orderId, { table_id: tableId });
    broadcast('tables');
    return orderView(orderId);
  });
}

export function mergeOrder(ctx, orderId, body) {
  const into = String(body.into_order_id || '');
  return tx(() => {
    openOrderRow(orderId); openOrderRow(into);
    if (into === orderId) throw bad('same_order');
    run('UPDATE order_items SET order_id = ? WHERE order_id = ?', into, orderId);
    run('UPDATE payments SET order_id = ? WHERE order_id = ?', into, orderId);
    run('UPDATE batches SET order_id = ? WHERE order_id = ?', into, orderId);
    run("UPDATE orders SET status = 'merged', closed_at = ? WHERE id = ?", now(), orderId);
    audit(ctx, 'merge_tables', orderId, { into });
    broadcast('tables');
    return orderView(into);
  });
}

export function moveItems(ctx, orderId, body) {
  const tableId = int(body.table_id, 'table_id');
  const ids = (body.item_ids || []).map((x) => int(x, 'item_id'));
  if (!ids.length) throw bad('no_items');
  return tx(() => {
    guardClock();
    const src = openOrderRow(orderId);
    const day = requireDay();
    let target = get("SELECT * FROM orders WHERE table_id = ? AND status = 'open'", tableId);
    if (target && target.id === orderId) throw bad('same_order');
    if (!target) {
      const newId = String(body.new_order_id || '');
      if (newId.length < 8) throw bad('bad_id');
      if (!get('SELECT 1 AS x FROM tables WHERE id = ? AND active = 1', tableId)) throw bad('no_table');
      run('INSERT INTO orders(id, table_id, day_id, waiter_id, opened_at) VALUES(?,?,?,?,?)', newId, tableId, day.id, src.waiter_id, now());
      target = { id: newId };
    }
    for (const id of ids) {
      const it = get("SELECT * FROM order_items WHERE id = ? AND order_id = ? AND status = 'sent' AND payment_id IS NULL", id, orderId);
      if (!it) throw bad('no_item', 'Only unpaid items can be moved');
      run('UPDATE order_items SET order_id = ? WHERE id = ?', target.id, id);
    }
    audit(ctx, 'move_items', orderId, { to: target.id, count: ids.length });
    // If nothing is left on the source table, close it.
    const left = all('SELECT * FROM order_items WHERE order_id = ?', orderId);
    if (!left.length) run("UPDATE orders SET status = 'merged', closed_at = ? WHERE id = ?", now(), orderId);
    else closeIfDone(ctx, orderId);
    broadcast('tables');
    return { source: orderView(orderId), target: orderView(target.id) };
  });
}

export function passOrder(ctx, orderId, body) {
  const userId = int(body.user_id, 'user_id');
  return tx(() => {
    const o = openOrderRow(orderId);
    if (!get('SELECT 1 AS x FROM users WHERE id = ? AND active = 1', userId)) throw bad('no_user');
    run('UPDATE orders SET waiter_id = ? WHERE id = ?', userId, orderId);
    ensureSession(userId);
    audit(ctx, 'pass_table', orderId, { from: o.waiter_id, to: userId });
    broadcast('tables');
    return orderView(orderId);
  });
}

export function pay(ctx, orderId, body) {
  const paymentId = String(body.payment_id || '');
  if (paymentId.length < 8) throw bad('bad_id', 'The device must supply a payment id');
  const type = body.type === 'house' ? 'house' : 'cash';
  return tx(() => {
    if (get('SELECT 1 AS x FROM payments WHERE id = ?', paymentId)) return { order: orderView(orderId), repeated: true };
    guardClock();
    openOrderRow(orderId);
    const unpaid = all("SELECT * FROM order_items WHERE order_id = ? AND status = 'sent' AND payment_id IS NULL", orderId);
    if (!unpaid.length) throw conflict('nothing_due');
    const picks = Array.isArray(body.items) && body.items.length
      ? body.items.map((x) => ({ id: int(x.id, 'item id'), qty: x.qty == null ? null : int(x.qty, 'qty') }))
      : unpaid.map((i) => ({ id: i.id, qty: null }));
    let amount = 0; const plan = [];
    for (const pk of picks) {
      const row = unpaid.find((i) => i.id === pk.id);
      if (!row) throw bad('no_item', 'An item is missing or already paid');
      const qty = pk.qty ?? row.qty;
      if (qty < 1 || qty > row.qty) throw bad('bad_qty');
      amount += lineTotal(row, qty);
      plan.push({ row, qty });
    }
    const approver = type === 'house' ? approve(ctx, body.pin) : null;
    const session = ensureSession(ctx.user.id);
    run('INSERT INTO payments(id, order_id, session_id, user_id, type, amount_cents, approved_by, created_at) VALUES(?,?,?,?,?,?,?,?)',
      paymentId, orderId, session.id, ctx.user.id, type, amount, approver?.id ?? null, now());
    for (const { row, qty } of plan) {
      if (qty === row.qty) run('UPDATE order_items SET payment_id = ? WHERE id = ?', paymentId, row.id);
      else {
        run('UPDATE order_items SET qty = ? WHERE id = ?', row.qty - qty, row.id);
        run(`INSERT INTO order_items(order_id, product_id, name, price_cents, vat_rate, qty, modifiers, note, discount_pct, status, batch_id, sent_by, sent_at, payment_id, stock, cost_cents)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, orderId, row.product_id, row.name, row.price_cents, row.vat_rate, qty, row.modifiers, row.note,
          row.discount_pct, 'sent', row.batch_id, row.sent_by, row.sent_at, paymentId, row.stock, row.cost_cents);
      }
    }
    if (type === 'house') audit(ctx, 'on_the_house', orderId, { amount_cents: amount, approved_by: approver.id });
    closeIfDone(ctx, orderId);
    broadcast('tables');
    return { order: orderView(orderId), paid_cents: amount, type };
  });
}

export function sessionTotals(sessionId) {
  const s = get('SELECT s.*, u.name AS user_name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?', sessionId);
  if (!s) throw new HttpError(404, 'no_session');
  const sum = (sql, ...p) => get(sql, ...p).v || 0;
  const cash = sum("SELECT SUM(amount_cents) AS v FROM payments WHERE session_id = ? AND type = 'cash'", sessionId);
  const house = sum("SELECT SUM(amount_cents) AS v FROM payments WHERE session_id = ? AND type = 'house'", sessionId);
  const payouts = sum("SELECT SUM(amount_cents) AS v FROM cash_movements WHERE session_id = ? AND type = 'payout'", sessionId);
  const openTables = all(`SELECT o.id, t.name AS table_name FROM orders o JOIN tables t ON t.id = o.table_id
    WHERE o.status = 'open' AND o.waiter_id = ? AND o.day_id = ?`, s.user_id, s.day_id);
  return { ...s, cash_cents: cash, house_cents: house, payout_cents: payouts, owed_cents: s.float_cents + cash - payouts, open_tables: openTables };
}

export function mySession(ctx) {
  const day = currentDay();
  if (!day) return { day: null };
  const s = get('SELECT id FROM sessions WHERE day_id = ? AND user_id = ? AND settled_at IS NULL', day.id, ctx.user.id);
  return { day: { id: day.id, opened_at: day.opened_at, catch_up: !!day.catch_up }, session: s ? sessionTotals(s.id) : null };
}
