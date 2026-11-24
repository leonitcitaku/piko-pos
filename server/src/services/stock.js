// Stock: what the cafe buys and counts, and what every sale uses of it.
// Amounts are whole units (shots, filters, cans). A stock item is bought in packs: 1 kg of coffee = 110 shots.
// Nothing here is ever deleted. Every change is a row in stock_moves, and a mistake is put right with a correction.
// Stock never blocks a sale: it can go below zero, and the warnings tell the bar.
import { get, all, run, tx, getSetting } from '../db.js';
import { now } from '../clock.js';
import { bad, conflict, HttpError, int } from '../http.js';
import { audit } from './audit.js';
import { broadcast } from './events.js';
import { enqueueTicket } from '../print/queue.js';

const RANK = { ok: 0, low: 1, out: 2 };
const dayId = () => get("SELECT id FROM business_days WHERE status = 'open' ORDER BY id DESC LIMIT 1")?.id ?? null;
const item = (id) => { const s = get('SELECT * FROM stock_items WHERE id = ?', id); if (!s) throw new HttpError(404, 'no_stock_item'); return s; };
// What one unit cost, from the average price of a pack. Null until a delivery with a price was recorded.
export const unitCost = (s) => (s.avg_cost_cents_per_pack == null ? null : s.avg_cost_cents_per_pack / s.pack_size);

// "1.6 kg (176 shote)", or "12 copë" for things counted one by one.
export function fmtQty(s, units = s.qty) {
  if (s.pack_size <= 1) return `${units} ${s.unit}`;
  const packs = Math.round((units / s.pack_size) * 10) / 10;
  return `${String(packs).replace(/\.0$/, '')} ${s.pack_name} (${units} ${s.unit})`;
}
// The screen sends either whole units or packs (decimals allowed: 0.6 kg). Both end as whole units.
export function toUnits(s, body) {
  if (body.units != null && body.units !== '') { const n = Number(body.units); if (!Number.isFinite(n)) throw bad('bad_amount'); return Math.round(n); }
  if (body.packs != null && body.packs !== '') { const n = Number(String(body.packs).replace(',', '.')); if (!Number.isFinite(n)) throw bad('bad_amount'); return Math.round(n * s.pack_size); }
  throw bad('amount_required', 'Enter an amount');
}
const stateOf = (s) => (s.qty <= 0 ? 'out' : s.low_level > 0 && s.qty <= s.low_level ? 'low' : 'ok');

// ---------- warnings ----------
// Raised inside the transaction, sent after it. If the transaction rolls back, its alert rows are gone
// and flush() finds nothing to send.
let pending = new Set(), lastBy = null;
function flushSoon(byUser) { if (byUser) lastBy = byUser; setImmediate(flush); }
export function flush() {
  if (!pending.size) return;
  const ids = [...pending]; pending = new Set();
  const by = lastBy; lastBy = null;
  const rows = all(`SELECT a.*, s.name, s.unit, s.pack_name, s.pack_size, s.qty FROM stock_alerts a JOIN stock_items s ON s.id = a.stock_item_id
    WHERE a.id IN (${ids.map(() => '?').join(',')}) AND a.cleared_at IS NULL ORDER BY a.id`, ...ids);
  if (!rows.length) return;
  const alerts = rows.map((r) => ({ id: r.id, stock_item_id: r.stock_item_id, name: r.name, level: r.level, qty: r.qty, text: fmtQty(r, r.qty) }));
  broadcast('stock', { alerts, by });
  const out = alerts.some((a) => a.level === 'out');
  if (getSetting('stock_print_alerts', '1') === '1') {
    enqueueTicket({ day_id: dayId(), kind: 'stock', content: { cafe: getSetting('cafe_name', 'Cafe'), lines: alerts.map((a) => ({ name: a.name, level: a.level, text: a.text })) } });
  }
  if (process.send && getSetting('stock_notify', '1') === '1') {
    try {
      process.send({ type: 'notify', path: '/?stock=1', title: out ? 'Stoku mbaroi' : 'Stoku i ulët',
        body: alerts.map((a) => `${a.name}: ${a.text}`).join('\n') });
    } catch { /* the desktop app is not listening */ }
  }
}

// Works out the state after a change. A worse state raises one warning; a better one clears the old warnings.
// Before the opening count nothing is known about the shelf, so nothing is raised.
function evaluate(ids, byUser) {
  for (const id of new Set(ids)) {
    const s = get('SELECT * FROM stock_items WHERE id = ?', id);
    if (!s) continue;
    const next = s.active && s.counted_at != null ? stateOf(s) : 'ok';
    if (next === s.state) continue;
    run('UPDATE stock_items SET state = ? WHERE id = ?', next, id);
    if (RANK[next] > RANK[s.state]) {
      const a = run('INSERT INTO stock_alerts(stock_item_id, level, qty_at, at) VALUES(?,?,?,?)', id, next, s.qty, now()).lastInsertRowid;
      pending.add(Number(a));
      flushSoon(byUser);
    } else {
      // Back to ok clears everything. From out to low the "out" warning goes and the low one stays.
      const clear = next === 'ok' ? ['low', 'out'] : ['out'];
      run(`UPDATE stock_alerts SET cleared_at = ? WHERE stock_item_id = ? AND cleared_at IS NULL AND level IN (${clear.map(() => '?').join(',')})`, now(), id, ...clear);
      broadcast('stock', { alerts: [], by: null });
    }
  }
}

function move(s, kind, delta, ctx, extra = {}) {
  const after = s.qty + delta;
  run('UPDATE stock_items SET qty = ? WHERE id = ?', after, s.id);
  const id = run(`INSERT INTO stock_moves(stock_item_id, kind, delta, qty_after, cost_cents, order_item_id, day_id, user_id, reason, note, corrects, at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, s.id, kind, delta, after, extra.cost_cents ?? null, extra.order_item_id ?? null, dayId(),
    ctx?.user?.id ?? null, extra.reason ?? null, extra.note ?? null, extra.corrects ?? null, now()).lastInsertRowid;
  s.qty = after;
  return Number(id);
}

// ---------- sales ----------
// What one unit of this product with these extras uses, combined per stock item: [{ s: stock item id, a: units }].
export function recipeFor(productId, modifierIds = []) {
  const rows = [
    ...all('SELECT r.stock_item_id AS s, r.amount AS a FROM recipe_lines r JOIN stock_items i ON i.id = r.stock_item_id WHERE r.product_id = ? AND i.active = 1', productId),
    ...modifierIds.flatMap((m) => all('SELECT r.stock_item_id AS s, r.amount AS a FROM recipe_lines r JOIN stock_items i ON i.id = r.stock_item_id WHERE r.modifier_id = ? AND i.active = 1', m)),
  ];
  const sum = new Map();
  for (const r of rows) sum.set(r.s, (sum.get(r.s) || 0) + r.a);
  return [...sum].map(([s, a]) => ({ s, a }));
}

// Called for every new order line, inside the send transaction. The line keeps what it used (its snapshot),
// so a cancel later puts back exactly that, even if the recipe was changed in between.
export function consumeForLine(ctx, orderItemId, productId, modifierIds, qty) {
  const snap = recipeFor(productId, modifierIds);
  if (!snap.length) return;
  let cost = 0, known = false;
  for (const { s: sid, a } of snap) {
    const s = item(sid);
    const uc = unitCost(s);
    if (uc != null) { cost += uc * a; known = true; }
    move(s, 'sale', -a * qty, ctx, { order_item_id: orderItemId });
  }
  run('UPDATE order_items SET stock = ?, cost_cents = ? WHERE id = ?', JSON.stringify(snap), known ? Math.round(cost) : null, orderItemId);
  evaluate(snap.map((x) => x.s), ctx?.user?.id);
}

// A cancelled line. 'return': it never left the shelf, so it goes back. 'waste': it was made and thrown away,
// so the stock stays used and the report counts it as a loss.
export function cancelLine(ctx, line, qty, mode) {
  const snap = line.stock ? JSON.parse(line.stock) : [];
  run('UPDATE order_items SET void_stock = ? WHERE id = ?', snap.length ? mode : null, line.id);
  if (!snap.length || mode !== 'return') return;
  for (const { s: sid, a } of snap) move(item(sid), 'return', a * qty, ctx, { order_item_id: line.id });
  evaluate(snap.map((x) => x.s), ctx?.user?.id);
}

// ---------- the shelf ----------
export function deliver(ctx, body) {
  return tx(() => {
    const s = item(int(body.stock_item_id, 'stock_item_id'));
    const units = toUnits(s, body);
    if (units < 1) throw bad('bad_amount', 'A delivery adds at least one unit');
    // Only managers and the owner deal with money. A price from anyone else is ignored.
    let total = null;
    if (['manager', 'owner'].includes(ctx.user.role) && body.total_cents != null && body.total_cents !== '') {
      total = int(body.total_cents, 'total_cents');
      if (total < 0) throw bad('bad_price');
    }
    if (total != null) {
      // Weighted average: what is already on the shelf at the old price, plus this delivery at its price.
      const old = unitCost(s), have = Math.max(0, s.qty);
      const unit = old == null || have === 0 ? total / units : (have * old + total) / (have + units);
      run('UPDATE stock_items SET avg_cost_cents_per_pack = ? WHERE id = ?', Math.round(unit * s.pack_size), s.id);
    }
    const id = move(s, 'delivery', units, ctx, { cost_cents: total, note: body.note ? String(body.note).slice(0, 80) : null });
    audit(ctx, 'stock_delivery', s.id, { units, total_cents: total });
    evaluate([s.id], ctx.user.id);
    broadcast('stock', { alerts: [], by: null });
    return { move_id: id, item: view(item(s.id), ctx.user) };
  });
}

export function waste(ctx, body) {
  return tx(() => {
    const s = item(int(body.stock_item_id, 'stock_item_id'));
    const units = toUnits(s, body);
    if (units < 1) throw bad('bad_amount');
    const reason = String(body.reason || '').trim().slice(0, 60);
    if (!reason) throw bad('reason_required', 'Say why it was thrown away');
    const uc = unitCost(s);
    const id = move(s, 'waste', -units, ctx, { reason, cost_cents: uc == null ? null : Math.round(uc * units) });
    audit(ctx, 'stock_waste', s.id, { units, reason });
    evaluate([s.id], ctx.user.id);
    broadcast('stock', { alerts: [], by: null });
    return { move_id: id, item: view(item(s.id), ctx.user) };
  });
}

// A stock take. Each entry says what is on the shelf now and what the screen showed when the form was opened.
// The difference between those two is applied, so whatever sold while someone was counting is not lost.
export function count(ctx, body) {
  const entries = Array.isArray(body.entries) ? body.entries : [];
  if (!entries.length) throw bad('no_entries');
  return tx(() => {
    const done = [];
    for (const e of entries) {
      const s = item(int(e.stock_item_id, 'stock_item_id'));
      const counted = toUnits(s, e);
      if (counted < 0) throw bad('bad_amount');
      const seen = e.seen_qty == null ? s.qty : int(e.seen_qty, 'seen_qty');
      const delta = counted - seen;
      const first = s.counted_at == null;
      const uc = unitCost(s);
      const reason = e.reason ? String(e.reason).slice(0, 60) : null;
      if (delta !== 0 || first) move(s, first ? 'open' : 'count', delta, ctx, { reason, cost_cents: uc == null || first ? null : Math.round(uc * delta) });
      run('UPDATE stock_items SET counted_at = ? WHERE id = ?', now(), s.id);
      done.push({ stock_item_id: s.id, delta, first });
    }
    audit(ctx, 'stock_count', null, { items: done.length, changes: done.filter((d) => d.delta).length });
    evaluate(done.map((d) => d.stock_item_id), ctx.user.id);
    broadcast('stock', { alerts: [], by: null });
    return { counted: done };
  });
}

// Puts a delivery, a waste entry or a count back as if it had not happened, with a new row that says so.
export function correct(ctx, moveId) {
  return tx(() => {
    const m = get('SELECT * FROM stock_moves WHERE id = ?', moveId);
    if (!m) throw new HttpError(404, 'no_move');
    if (!['delivery', 'waste', 'count', 'open'].includes(m.kind)) throw bad('not_correctable', 'Sales are put right by cancelling the item');
    if (get('SELECT 1 AS x FROM stock_moves WHERE corrects = ?', moveId)) throw conflict('already_corrected');
    const s = item(m.stock_item_id);
    if (m.kind === 'delivery' && m.cost_cents != null && s.avg_cost_cents_per_pack != null) {
      // Take this delivery's money out of the average again.
      const left = s.qty - m.delta;
      if (left > 0) {
        const unit = Math.max(0, (s.qty * unitCost(s) - m.cost_cents) / left);
        run('UPDATE stock_items SET avg_cost_cents_per_pack = ? WHERE id = ?', Math.round(unit * s.pack_size), s.id);
      }
    }
    const id = move(s, 'correction', -m.delta, ctx, { corrects: m.id, reason: String(ctx.body?.reason || '').slice(0, 60) || null,
      cost_cents: m.cost_cents == null ? null : -m.cost_cents });
    audit(ctx, 'stock_correction', m.id, { kind: m.kind, delta: -m.delta });
    evaluate([s.id], ctx.user.id);
    broadcast('stock', { alerts: [], by: null });
    return { move_id: id };
  });
}

export function seeAlert(ctx, id) {
  const a = get('SELECT * FROM stock_alerts WHERE id = ?', id);
  if (!a) throw new HttpError(404, 'no_alert');
  if (!a.seen_at) run('UPDATE stock_alerts SET seen_by = ?, seen_at = ? WHERE id = ?', ctx.user.id, now(), id);
  broadcast('stock', { alerts: [], by: null });
  return { ok: true };
}

// ---------- reading ----------
const BOSS = ['manager', 'owner'];
export function view(s, user) {
  const boss = BOSS.includes(user.role);
  const out = { id: s.id, name: s.name, unit: s.unit, pack_name: s.pack_name, pack_size: s.pack_size, qty: s.qty, text: fmtQty(s),
    low_level: s.low_level, full_level: s.full_level, state: s.state, live_state: s.counted_at == null ? 'unknown' : stateOf(s),
    counted_at: s.counted_at, sort: s.sort, active: s.active };
  if (boss) { out.avg_cost_cents_per_pack = s.avg_cost_cents_per_pack; out.value_cents = s.avg_cost_cents_per_pack == null ? null : Math.round(Math.max(0, s.qty) * unitCost(s)); }
  return out;
}

export function overview(user) {
  const boss = BOSS.includes(user.role);
  const items = all(`SELECT * FROM stock_items ${boss ? '' : 'WHERE active = 1'} ORDER BY active DESC, sort, name`).map((s) => view(s, user));
  const alerts = openAlerts();
  const out = { items, alerts, settings: { print: getSetting('stock_print_alerts', '1') === '1', notify: getSetting('stock_notify', '1') === '1' } };
  if (boss) {
    out.recipes = all(`SELECT r.*, p.name AS product_name, m.name AS modifier_name FROM recipe_lines r
      LEFT JOIN products p ON p.id = r.product_id LEFT JOIN modifiers m ON m.id = r.modifier_id ORDER BY r.id`);
  }
  return out;
}

export const openAlerts = () => all(`SELECT a.id, a.stock_item_id, a.level, a.at, a.seen_at, s.name, s.unit, s.pack_name, s.pack_size, s.qty
  FROM stock_alerts a JOIN stock_items s ON s.id = a.stock_item_id WHERE a.cleared_at IS NULL AND s.active = 1 ORDER BY a.id`)
  .map((a) => ({ id: a.id, stock_item_id: a.stock_item_id, name: a.name, level: a.level, at: a.at, seen: !!a.seen_at, text: fmtQty(a) }));

export function moves(q) {
  const where = [], p = [];
  if (q.item) { where.push('m.stock_item_id = ?'); p.push(int(q.item, 'item')); }
  if (q.kind) { where.push('m.kind = ?'); p.push(String(q.kind)); }
  if (q.from) { where.push('m.at >= ?'); p.push(int(q.from, 'from')); }
  if (q.to) { where.push('m.at < ?'); p.push(int(q.to, 'to')); }
  const limit = Math.min(int(q.limit || 300, 'limit'), 2000);
  return all(`SELECT m.*, s.name AS item_name, s.unit, s.pack_name, s.pack_size, u.name AS user_name,
      (SELECT 1 FROM stock_moves c WHERE c.corrects = m.id) AS corrected
    FROM stock_moves m JOIN stock_items s ON s.id = m.stock_item_id LEFT JOIN users u ON u.id = m.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.id DESC LIMIT ?`, ...p, limit);
}

// Everything at or under its warning level, and how much to buy to be full again, in whole packs.
export function shoppingList() {
  return all('SELECT * FROM stock_items WHERE active = 1 ORDER BY sort, name')
    .filter((s) => s.qty <= 0 || (s.low_level > 0 && s.qty <= s.low_level))
    .map((s) => {
      const target = Math.max(s.full_level, s.low_level + 1);
      const packs = Math.max(1, Math.ceil((target - s.qty) / s.pack_size));
      return { stock_item_id: s.id, name: s.name, text: fmtQty(s), buy_packs: packs, buy_text: `${packs} ${s.pack_size > 1 ? s.pack_name : s.unit}` };
    });
}
export function printShoppingList(ctx) {
  const list = shoppingList();
  const id = enqueueTicket({ day_id: dayId(), user_id: ctx.user.id, kind: 'stock_list', content: { cafe: getSetting('cafe_name', 'Cafe'), lines: list } });
  return { job_id: id, items: list.length };
}

// What the Floor needs to mark a product: the worst state among the counted stock items it uses.
export function productStates() {
  const rows = all(`SELECT r.product_id, s.qty, s.low_level, s.counted_at, s.active FROM recipe_lines r JOIN stock_items s ON s.id = r.stock_item_id WHERE r.product_id IS NOT NULL`);
  const out = new Map();
  for (const r of rows) {
    if (!r.active || r.counted_at == null) continue;
    const st = stateOf(r);
    if (RANK[st] > RANK[out.get(r.product_id) || 'ok']) out.set(r.product_id, st);
  }
  return out;
}

// ---------- items and recipes ----------
const TEXT = (v, max, field) => { const s = String(v ?? '').trim().slice(0, max); if (!s) throw bad('missing_field', field); return s; };
export function saveItem(ctx, id, body) {
  const fields = {};
  if (body.name != null) fields.name = TEXT(body.name, 40, 'name');
  if (body.unit != null) fields.unit = TEXT(body.unit, 16, 'unit');
  if (body.pack_name != null) fields.pack_name = TEXT(body.pack_name, 16, 'pack_name');
  for (const f of ['pack_size', 'low_level', 'full_level', 'sort']) if (body[f] != null && body[f] !== '') {
    fields[f] = int(body[f], f);
    if (fields[f] < (f === 'pack_size' ? 1 : 0)) throw bad('bad_value', f);
  }
  if (body.active != null) fields.active = body.active ? 1 : 0;
  return tx(() => {
    let sid = id;
    if (id == null) {
      if (!fields.name) throw bad('missing_field', 'name');
      const keys = Object.keys(fields);
      sid = Number(run(`INSERT INTO stock_items(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map((k) => fields[k])).lastInsertRowid);
      audit(ctx, 'stock_item_create', sid, fields);
    } else {
      item(id);
      const keys = Object.keys(fields);
      if (keys.length) run(`UPDATE stock_items SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), id);
      audit(ctx, 'stock_item_update', id, fields);
    }
    evaluate([sid], ctx.user.id);
    broadcast('stock', { alerts: [], by: null }); broadcast('menu');
    return view(item(sid), ctx.user);
  });
}

// The whole recipe of one product or one extra at once: [{ stock_item_id, amount }]. An empty list stops tracking it.
export function setRecipe(ctx, owner, ownerId, lines) {
  const col = owner === 'product' ? 'product_id' : owner === 'modifier' ? 'modifier_id' : null;
  if (!col) throw bad('bad_owner');
  if (!Array.isArray(lines)) throw bad('bad_lines');
  return tx(() => {
    const table = owner === 'product' ? 'products' : 'modifiers';
    if (!get(`SELECT 1 AS x FROM ${table} WHERE id = ?`, ownerId)) throw new HttpError(404, 'no_' + owner);
    run(`DELETE FROM recipe_lines WHERE ${col} = ?`, ownerId);
    const seen = new Set();
    for (const l of lines) {
      const sid = int(l.stock_item_id, 'stock_item_id'), amount = int(l.amount, 'amount');
      if (amount < 1) throw bad('bad_amount');
      if (seen.has(sid)) throw bad('duplicate_item');
      seen.add(sid); item(sid);
      run(`INSERT INTO recipe_lines(${col}, stock_item_id, amount) VALUES(?,?,?)`, ownerId, sid, amount);
    }
    audit(ctx, 'recipe_update', `${owner}:${ownerId}`, { lines });
    broadcast('menu'); broadcast('stock', { alerts: [], by: null });
    return { ok: true };
  });
}

// The first time: coffee by the kg, tea by the box, and one item per bottled drink, with the recipes that go with
// them. The screen shows the proposal first and sends back what the owner kept and changed.
export function setupProposal() {
  const products = all('SELECT p.id, p.name, c.name AS category FROM products p JOIN categories c ON c.id = p.category_id WHERE p.active = 1 ORDER BY c.sort, p.sort');
  const modifiers = all('SELECT id, name FROM modifiers WHERE active = 1');
  const tracked = new Set(all('SELECT DISTINCT product_id FROM recipe_lines WHERE product_id IS NOT NULL').map((r) => r.product_id));
  const coffee = { Espresso: 1, 'Espresso dopio': 2, 'Makiato e vogel': 1, 'Makiato e madhe': 1, Kapucino: 1, Latte: 1, Amerikano: 1, 'Kafe e ftohte': 1 };
  const bottles = ['Pije freskuese', 'Uje', 'Birra'];
  const items = [
    { key: 'coffee', name: 'Kafe', unit: 'shote', pack_name: 'kg', pack_size: 110, low_level: 220, full_level: 1100,
      uses: products.filter((p) => coffee[p.name]).map((p) => ({ product_id: p.id, name: p.name, amount: coffee[p.name] })),
      extras: modifiers.filter((m) => m.name === 'Shot shtese').map((m) => ({ modifier_id: m.id, name: m.name, amount: 1 })) },
    { key: 'tea', name: 'Çaj', unit: 'filtra', pack_name: 'kuti', pack_size: 20, low_level: 20, full_level: 100,
      uses: products.filter((p) => p.name === 'Caj').map((p) => ({ product_id: p.id, name: p.name, amount: 1 })), extras: [] },
    ...products.filter((p) => bottles.includes(p.category) || p.name === 'Birre shishe').filter((p) => !['Birre e vogel', 'Birre e madhe', 'Portokall i shtrydhur'].includes(p.name))
      .map((p) => ({ key: 'p' + p.id, name: p.name, unit: 'copë', pack_name: 'arkë', pack_size: 24, low_level: 12, full_level: 48,
        uses: [{ product_id: p.id, name: p.name, amount: 1 }], extras: [] })),
  ].filter((it) => it.uses.length && it.uses.every((u) => !tracked.has(u.product_id)));
  return { items, already: get('SELECT COUNT(*) AS n FROM stock_items').n };
}

export function setup(ctx, body) {
  const list = Array.isArray(body.items) ? body.items : [];
  if (!list.length) throw bad('no_items');
  return tx(() => {
    const made = [];
    for (const it of list) {
      const s = saveItem(ctx, null, it);
      for (const u of it.uses || []) {
        const pid = int(u.product_id, 'product_id');
        if (!get('SELECT 1 AS x FROM products WHERE id = ?', pid)) throw bad('no_product');
        run('INSERT OR REPLACE INTO recipe_lines(product_id, stock_item_id, amount) VALUES(?,?,?)', pid, s.id, Math.max(1, int(u.amount, 'amount')));
      }
      for (const u of it.extras || []) {
        const mid = int(u.modifier_id, 'modifier_id');
        if (!get('SELECT 1 AS x FROM modifiers WHERE id = ?', mid)) throw bad('no_modifier');
        run('INSERT OR REPLACE INTO recipe_lines(modifier_id, stock_item_id, amount) VALUES(?,?,?)', mid, s.id, Math.max(1, int(u.amount, 'amount')));
      }
      made.push(s.id);
    }
    audit(ctx, 'stock_setup', null, { items: made.length });
    broadcast('menu'); broadcast('stock', { alerts: [], by: null });
    return { created: made };
  });
}

// Wiping the test data: the shelf has to be counted again, the items and recipes stay.
export function resetStock() {
  run('DELETE FROM stock_alerts');
  run('DELETE FROM stock_moves');
  run("UPDATE stock_items SET qty = 0, counted_at = NULL, state = 'ok'");
}
