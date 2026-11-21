import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot, client, fakePrinter, tmpDir, uid, until, sleep } from './helpers.js';

const dir = tmpDir();
let app, base, printer;
let owner, manager, w1, w2, w3, bar;          // clients
const ids = {};                                // user ids
let menu, tables;
const PIN = { owner: '999999', manager: '888888', w1: '1111', w2: '2222', w3: '3333', bar: '4444' };  // approvers need 6 digits

const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.data)}`); return r.data; };
const product = (name) => menu.products.find((p) => p.name === name);
const table = (name) => tables.tables.find((t) => t.name === name);
const tickets = async () => ok(await manager.get('/api/tickets')).tickets;
const setClock = (ms) => owner.post('/api/test/clock', { offset_ms: ms });
// Staff cannot see cash figures any more, so the tests read a person's open session the way a manager would.
const sessionOf = async (key) => ({ session: ok(await manager.get('/api/day')).sessions.find((x) => x.user_id === ids[key] && !x.settled_at) || null });
const idle = async () => { await until(async () => (await tickets()).every((x) => x.status !== 'waiting')); await sleep(200); };

async function order(c, tableName, lines) {
  const o = ok(await c.post('/api/orders', { id: uid(), table_id: table(tableName).id }), 'open order');
  const sent = ok(await c.post(`/api/orders/${o.id}/items`, { batch_id: uid(), items: lines.map(([n, qty, extra]) => ({ product_id: product(n).id, qty, ...(extra || {}) })) }), 'send');
  return sent;
}

test('cafe POS', async (t) => {
  ({ app, base } = await boot(dir));
  printer = await fakePrinter();
  t.after(async () => { await app.close(); await printer.off().catch(() => {}); });

  await t.test('first run: owner sets up, then adds staff', async () => {
    owner = client(base);
    assert.equal(ok(await owner.get('/api/setup/status')).needs_setup, true);
    const me = ok(await owner.post('/api/setup', { name: 'Pronari', pin: PIN.owner, cafe_name: 'Test Cafe' }));
    assert.equal(me.role, 'owner');
    assert.equal((await owner.post('/api/setup', { name: 'X', pin: '1234' })).status, 409);
    for (const [key, name, role] of [['manager', 'Menaxheri', 'manager'], ['w1', 'Arta', 'waiter'], ['w2', 'Besa', 'waiter'], ['w3', 'Dren', 'waiter'], ['bar', 'Banakieri', 'bartender']]) {
      ids[key] = ok(await owner.post('/api/admin/users', { name, pin: PIN[key], role })).id;
    }
    const login = async (key) => { const c = client(base); ok(await c.post('/api/auth/login', { user_id: ids[key], pin: PIN[key] })); return c; };
    manager = await login('manager'); w1 = await login('w1'); w2 = await login('w2'); w3 = await login('w3'); bar = await login('bar');
    ok(await owner.put('/api/admin/settings', { printer_mode: 'network', printer_host: '127.0.0.1', printer_port: String(printer.port) }));
    menu = ok(await w1.get('/api/menu')); tables = ok(await w1.get('/api/tables'));
    assert.equal(tables.tables.length, 30);
    assert.ok(menu.products.length >= 30);
  });

  await t.test('roles: waiters cannot run the day or the admin, managers cannot change prices', async () => {
    assert.equal((await w1.post('/api/day/open')).status, 403);
    assert.equal((await w1.get('/api/admin/all')).status, 403);
    assert.equal((await manager.put(`/api/admin/products/${product('Espresso').id}`, { price_cents: 150 })).status, 403);
    ok(await owner.put(`/api/admin/products/${product('Espresso').id}`, { price_cents: 120 }));
    ok(await owner.put(`/api/admin/products/${product('Makiato e madhe').id}`, { price_cents: 150 }));
    ok(await owner.put(`/api/admin/products/${product('Kola').id}`, { price_cents: 200 }));
    ok(await owner.put(`/api/admin/products/${product('Birre e madhe').id}`, { price_cents: 300 }));
    menu = ok(await w1.get('/api/menu'));
    assert.equal(product('Kola').price_cents, 200);
  });

  await t.test('no orders without an open business day', async () => {
    const r = await w1.post('/api/orders', { id: uid(), table_id: table('1').id });
    assert.equal(r.status, 409); assert.equal(r.data.error, 'day_closed');
    ok(await manager.post('/api/day/open'));
    assert.equal((await manager.post('/api/day/open')).status, 409);
  });

  await t.test('a send repeated with the same id lands once and prints one ticket', async () => {
    const o = ok(await w1.post('/api/orders', { id: uid(), table_id: table('1').id }));
    const body = { batch_id: uid(), items: [{ product_id: product('Espresso').id, qty: 2 }] };
    const [a, b] = await Promise.all([w1.post(`/api/orders/${o.id}/items`, body), w1.post(`/api/orders/${o.id}/items`, body)]);
    ok(a); ok(b);
    ok(await w1.post(`/api/orders/${o.id}/items`, body));
    const view = ok(await w1.get(`/api/orders/${o.id}`));
    assert.equal(view.items.length, 1); assert.equal(view.total_cents, 240);
    await until(() => printer.received.length >= 1);
    await sleep(200);
    assert.equal((await tickets()).filter((x) => x.order_id === o.id).length, 1);
    assert.equal(printer.received.length, 1);
    assert.match(printer.received[0], /TAVOLINA 1/); assert.match(printer.received[0], /2 x Espresso/);
    ids.order1 = o.id;
  });

  await t.test('two waiters on the same table share one order and both sets of items are there', async () => {
    const [a, b] = await Promise.all([w1.post('/api/orders', { id: uid(), table_id: table('2').id }), w2.post('/api/orders', { id: uid(), table_id: table('2').id })]);
    assert.equal(ok(a).id, ok(b).id);
    const oid = a.data.id;
    await Promise.all([
      w1.post(`/api/orders/${oid}/items`, { batch_id: uid(), items: [{ product_id: product('Kola').id, qty: 1 }] }),
      w2.post(`/api/orders/${oid}/items`, { batch_id: uid(), items: [{ product_id: product('Espresso').id, qty: 1, note: 'pa sheqer' }] }),
    ]);
    const view = ok(await w1.get(`/api/orders/${oid}`));
    assert.equal(view.items.length, 2); assert.equal(view.total_cents, 320);
    ids.order2 = oid;
  });

  await t.test('six devices sending at once: every ticket prints, none doubled', async () => {
    await idle();
    const before = printer.received.length;
    const names = ['3', '4', '5', '6', '7', '8'], cs = [w1, w2, w3, bar, manager, owner];
    const sent = await Promise.all(names.map((n, i) => order(cs[i], n, [['Makiato e madhe', 2]])));
    ids.rush = sent.map((s) => s.id);
    await until(() => printer.received.length - before >= 6);
    await sleep(200);
    assert.equal(printer.received.length - before, 6);
    const tabs = printer.received.slice(before).map((x) => /TAVOLINA (\w+)/.exec(x)[1]);
    for (const n of names) assert.equal(tabs.filter((x) => x === n).length, 1, 'table ' + n);
  });

  await t.test('printer off: tickets wait, the waiter is warned, and they print marked LATE in order', async () => {
    await printer.off();
    const before = printer.received.length;
    const a = await order(w1, '9', [['Kola', 1]]);
    const b = await order(w2, '10', [['Kola', 2]]);
    await until(async () => ok(await manager.get('/api/tickets')).printer.ok === false);
    let list = await tickets();
    assert.equal(list.filter((x) => x.status === 'waiting').length, 2);
    assert.match(list.find((x) => x.status === 'waiting' && x.attempts > 0).last_error, /not reachable/);
    assert.equal(list.filter((x) => x.attempts > 0).length, 1, 'the queue stops at the first failed ticket to keep order');
    assert.equal(ok(await manager.get('/api/system/info')).printer.ok, false);
    await printer.on();
    await until(() => printer.received.length - before >= 2);
    await sleep(200);
    const got = printer.received.slice(before);
    assert.equal(got.length, 2);
    assert.match(got[0], /LATE/); assert.match(got[0], /TAVOLINA 9/); assert.match(got[1], /TAVOLINA 10/);
    assert.equal(ok(await manager.get('/api/tickets')).printer.ok, true);
    ids.o9 = a.id; ids.o10 = b.id;
  });

  await t.test('reprint is marked COPY, and a waiting ticket can be skipped by a manager', async () => {
    const first = (await tickets()).find((x) => x.order_id === ids.order1);
    const before = printer.received.length;
    ok(await bar.post(`/api/tickets/${first.id}/reprint`));
    await until(() => printer.received.length === before + 1);
    assert.match(printer.received.at(-1), /COPY/);
    await printer.off();
    const o = await order(w3, '11', [['Kola', 1]]);
    const job = await until(async () => (await tickets()).find((x) => x.order_id === o.id && x.status === 'waiting' && x.attempts > 0));
    assert.equal((await w3.post(`/api/tickets/${job.id}/skip`)).status, 403);
    ok(await manager.post(`/api/tickets/${job.id}/skip`));
    await printer.on();
    await sleep(400);
    assert.equal((await tickets()).find((x) => x.id === job.id).status, 'skipped');
    ids.o11 = o.id;
  });

  await t.test('cancel: free for the sender inside 2 minutes, PIN and reason after that, both print a cancel ticket', async () => {
    const o = await order(w1, '12', [['Espresso', 1], ['Kola', 1], ['Birre e madhe', 1]]);
    const [esp, kola, beer] = o.items;
    const before = printer.received.length;
    assert.equal((await w2.post(`/api/orders/${o.id}/cancel-item`, { item_id: esp.id })).status, 400, 'another waiter needs a reason and approval');
    ok(await w1.post(`/api/orders/${o.id}/cancel-item`, { item_id: esp.id }));
    await setClock(3 * 60_000);
    let r = await w1.post(`/api/orders/${o.id}/cancel-item`, { item_id: kola.id, reason: 'spilled' });
    assert.equal(r.status, 403); assert.equal(r.data.error, 'need_approval');
    r = await w1.post(`/api/orders/${o.id}/cancel-item`, { item_id: kola.id, reason: 'spilled', pin: '0000' });
    assert.equal(r.status, 401);
    const view = ok(await w1.post(`/api/orders/${o.id}/cancel-item`, { item_id: kola.id, reason: 'spilled', pin: PIN.manager }));
    assert.equal(view.total_cents, 300);
    assert.equal(view.items.filter((i) => i.status === 'void').length, 2);
    await until(() => printer.received.length === before + 2);
    assert.match(printer.received.at(-1), /ANULIM/);
    ids.o12 = o.id; ids.beer12 = beer.id;
    await setClock(3 * 60_000);
  });

  await t.test('cancel only some of a line: five Amerikano, one spilled', async () => {
    const free = ok(await w2.get('/api/tables')).tables.find((x) => !x.order_id);
    const o = ok(await w2.post('/api/orders', { id: uid(), table_id: free.id }));
    let v = ok(await w2.post(`/api/orders/${o.id}/items`, { batch_id: uid(), items: [{ product_id: product('Amerikano').id, qty: 5 }] }));
    const line = v.items.find((i) => i.name === 'Amerikano');
    const before = v.total_cents;
    assert.equal((await w2.post(`/api/orders/${o.id}/cancel-item`, { item_id: line.id, qty: 6 })).status, 400, 'cannot cancel more than there are');
    v = ok(await w2.post(`/api/orders/${o.id}/cancel-item`, { item_id: line.id, qty: 1 }));
    const live = v.items.filter((i) => i.name === 'Amerikano' && i.status === 'sent'), gone = v.items.filter((i) => i.name === 'Amerikano' && i.status === 'void');
    assert.equal(live.length, 1); assert.equal(live[0].qty, 4); assert.equal(gone.length, 1); assert.equal(gone[0].qty, 1);
    assert.equal(v.total_cents, before - product('Amerikano').price_cents);
    const ticket = (await tickets()).find((j) => j.kind === 'cancel' && j.order_id === o.id);
    assert.equal(ticket.content.lines[0].qty, 1, 'the cancel ticket says one, not five');
    ok(await w2.post(`/api/orders/${o.id}/pay`, { payment_id: uid() }));
  });

  await t.test('split bill: four people pay separately, the table closes only after the last one', async () => {
    const o = await order(w2, '13', [['Makiato e madhe', 1], ['Kola', 1], ['Espresso', 1], ['Birre e madhe', 2]]);
    const [mak, kola, esp, beer] = o.items;
    let p = ok(await w2.post(`/api/orders/${o.id}/pay`, { payment_id: uid(), items: [{ id: mak.id }] }));
    assert.equal(p.paid_cents, 150); assert.equal(p.order.status, 'open'); assert.equal(p.order.due_cents, 200 + 120 + 600);
    const pid = uid();
    p = ok(await w2.post(`/api/orders/${o.id}/pay`, { payment_id: pid, items: [{ id: kola.id }] }));
    const again = ok(await w2.post(`/api/orders/${o.id}/pay`, { payment_id: pid, items: [{ id: kola.id }] }));
    assert.equal(again.repeated, true);
    p = ok(await w2.post(`/api/orders/${o.id}/pay`, { payment_id: uid(), items: [{ id: esp.id }, { id: beer.id, qty: 1 }] }));
    assert.equal(p.paid_cents, 420); assert.equal(p.order.status, 'open'); assert.equal(p.order.due_cents, 300);
    p = ok(await w2.post(`/api/orders/${o.id}/pay`, { payment_id: uid() }));
    assert.equal(p.paid_cents, 300); assert.equal(p.order.status, 'paid');
    assert.equal(p.order.total_cents, 150 + 200 + 120 + 600);
    assert.equal(table('13').order_id, null);
    tables = ok(await w1.get('/api/tables'));
    assert.equal(table('13').order_id, null, 'table is free again');
    assert.equal((await w2.post(`/api/orders/${o.id}/pay`, { payment_id: uid() })).status, 409);
  });

  await t.test('on the house needs a manager or owner PIN and is not owed by the waiter', async () => {
    const o = await order(w3, '14', [['Birre e madhe', 2]]);
    assert.equal((await w3.post(`/api/orders/${o.id}/pay`, { payment_id: uid(), type: 'house' })).status, 403);
    const p = ok(await w3.post(`/api/orders/${o.id}/pay`, { payment_id: uid(), type: 'house', pin: PIN.owner }));
    assert.equal(p.order.status, 'paid');
    const s = (await sessionOf('w3')).session;
    assert.equal(s.house_cents, 600); assert.equal(s.cash_cents, 0); assert.equal(s.owed_cents, 0);
  });

  await t.test('discount, sold out, move, merge and moving single items', async () => {
    const o = await order(w1, '15', [['Kola', 2]]);
    assert.equal((await w1.post(`/api/orders/${o.id}/discount`, { pct: 50 })).status, 403);
    assert.equal(ok(await w1.post(`/api/orders/${o.id}/discount`, { pct: 50, pin: PIN.manager })).total_cents, 200);
    ok(await bar.post(`/api/products/${product('Tonik').id}/available`, { available: false }));
    const so = await w1.post(`/api/orders/${o.id}/items`, { batch_id: uid(), items: [{ product_id: product('Tonik').id, qty: 1 }] });
    assert.equal(so.status, 409); assert.equal(so.data.error, 'sold_out');
    ok(await bar.post(`/api/products/${product('Tonik').id}/available`, { available: true }));
    assert.equal((await w1.post(`/api/orders/${o.id}/move`, { table_id: table('12').id })).status, 409, 'table 12 is busy');
    ok(await w1.post(`/api/orders/${o.id}/move`, { table_id: table('T1').id }));
    const merged = ok(await w1.post(`/api/orders/${o.id}/merge`, { into_order_id: ids.o12 }));
    assert.equal(merged.total_cents, 300 + 200);
    const moved = ok(await w1.post(`/api/orders/${ids.o12}/move-items`, { item_ids: [ids.beer12], table_id: table('T2').id, new_order_id: uid() }));
    assert.equal(moved.source.total_cents, 200); assert.equal(moved.target.total_cents, 300); assert.equal(moved.target.table_name, 'T2');
    ids.o17 = moved.target.id;
  });

  await t.test('sessions: float, cash, payout, pass tables, settle while service continues', async () => {
    ok(await manager.post('/api/sessions/float', { user_id: ids.w1, amount_cents: 2000 }));
    // w1 collects cash on tables 1, 12 and 17
    for (const oid of [ids.order1, ids.o12, ids.o17]) ok(await w1.post(`/api/orders/${oid}/pay`, { payment_id: uid() }));
    let s = (await sessionOf('w1')).session;
    assert.equal(s.cash_cents, 240 + 200 + 300); assert.equal(s.owed_cents, 2000 + 740);
    ok(await manager.post('/api/cash/payout', { amount_cents: 500, reason: 'Qumesht', session_id: s.id }));
    s = (await sessionOf('w1')).session;
    assert.equal(s.owed_cents, 2000 + 740 - 500);
    // w1 still has open tables (2, 3, 9): settlement is refused until they are passed on
    let r = await manager.post(`/api/sessions/${s.id}/settle`, { handed_cents: 2240 });
    assert.equal(r.status, 409); assert.equal(r.data.error, 'open_tables');
    for (const tb of r.data.tables) ok(await w1.post(`/api/orders/${tb.id}/pass`, { user_id: ids.w2 }));
    // meanwhile another waiter keeps taking orders
    const live = await order(w3, 'T3', [['Kola', 1]]);
    const done = ok(await manager.post(`/api/sessions/${s.id}/settle`, { handed_cents: 2200 }));
    assert.equal(done.expected_cents, 2240); assert.equal(done.difference_cents, -40);
    assert.equal((await sessionOf('w1')).session, null, 'the settled session is finished; a new one starts only if they sell again');
    ok(await w3.post(`/api/orders/${live.id}/pay`, { payment_id: uid() }));
  });

  await t.test('the day cannot close with open tables or unsettled staff; then it closes and backs up', async () => {
    let r = await manager.post('/api/day/close');
    assert.equal(r.status, 409); assert.equal(r.data.error, 'open_tables');
    for (const tb of r.data.tables) {
      const c = [w2, w3, bar, manager, owner].find(() => true);
      ok(await c.post(`/api/orders/${tb.id}/pay`, { payment_id: uid() }));
    }
    r = await manager.post('/api/day/close');
    assert.equal(r.status, 409); assert.equal(r.data.error, 'unsettled_sessions');
    const view = ok(await manager.get('/api/day'));
    for (const s of view.sessions.filter((x) => !x.settled_at)) ok(await manager.post(`/api/sessions/${s.id}/settle`, { handed_cents: s.owed_cents }));
    await until(async () => (await tickets()).every((x) => x.status !== 'waiting'));
    const report = ok(await manager.get('/api/reports/day'));
    const sumCash = report.sessions.reduce((a, s) => a + s.cash_cents, 0);
    assert.equal(report.totals.cash_cents, sumCash, 'day cash equals all sessions added together');
    assert.equal(report.totals.house_cents, 600);
    assert.equal(report.totals.payout_cents, 500);
    assert.equal(report.by_item.reduce((a, i) => a + i.cents, 0), report.totals.sales_cents);
    assert.equal(report.voids.length, 1); assert.equal(report.voids[0].reason, 'spilled'); assert.equal(report.voids[0].approved_by_name, 'Menaxheri');
    assert.equal(report.quick_cancels[0].user_name, 'Arta');
    assert.ok(report.tickets.late >= 1); assert.equal(report.tickets.reprints, 1); assert.equal(report.tickets.skipped, 1);
    const closed = ok(await manager.post('/api/day/close'));
    assert.ok(fs.existsSync(closed.backup.file));
    ids.backup = closed.backup.file; ids.day1 = closed.closed_day_id;
    const csv = await manager.get(`/api/reports/day.csv?id=${ids.day1}`);
    assert.equal(csv.status, 200); assert.match(csv.data, /Total sales/);
  });

  await t.test('the backup restores with all data', async () => {
    const copy = path.join(dir, 'restore-check.db');
    fs.copyFileSync(ids.backup, copy);
    const db = new DatabaseSync(copy);
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'").get().n >= 10);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 6);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    db.close();
  });

  await t.test('catch up mode records orders without printing bar tickets', async () => {
    w1 = client(base); ok(await w1.post('/api/auth/login', { user_id: ids.w1, pin: PIN.w1 }));
    ok(await manager.post('/api/day/open'));
    ok(await manager.post('/api/day/catch-up', { on: true }));
    await sleep(300);
    const before = printer.received.length, jobsBefore = (await tickets()).length;
    const o = await order(w1, '1', [['Kola', 3]]);
    await sleep(400);
    assert.equal(printer.received.length, before, 'printed: ' + printer.received.at(-1)); assert.equal((await tickets()).length, jobsBefore);
    assert.equal(o.entered_late, 1);
    ok(await manager.post('/api/day/catch-up', { on: false }));
    ids.late = o.id;
  });

  await t.test('restart: open tables are intact and nobody is logged out', async () => {
    await app.close();
    ({ app, base: base } = await boot(dir));
    const c = client(base); c.setCookie(w1.cookie());
    const view = ok(await c.get(`/api/orders/${ids.late}`));
    assert.equal(view.status, 'open'); assert.equal(view.total_cents, 600);
    w1 = c; const mc = client(base); mc.setCookie(manager.cookie()); manager = mc;
    const oc = client(base); oc.setCookie(owner.cookie()); owner = oc;
    assert.equal(ok(await manager.get('/api/day')).open_orders, 1);
  });

  await t.test('clock guard: if the PC clock jumps back, orders are refused', async () => {
    await setClock(-365 * 24 * 3600_000);
    const r = await w1.post(`/api/orders/${ids.late}/items`, { batch_id: uid(), items: [{ product_id: product('Kola').id, qty: 1 }] });
    assert.equal(r.status, 409); assert.equal(r.data.error, 'clock_wrong');
    assert.equal(ok(await manager.get('/api/system/info')).clock_wrong, true);
    await setClock(0);
    ok(await w1.post(`/api/orders/${ids.late}/pay`, { payment_id: uid() }));
  });

  await t.test('five wrong PINs lock the device for a minute', async () => {
    const c = client(base);
    for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/auth/login', { user_id: ids.w2, pin: '0000' })).status, 401);
    assert.equal((await c.post('/api/auth/login', { user_id: ids.w2, pin: '0000' })).status, 401);
    const locked = await c.post('/api/auth/login', { user_id: ids.w2, pin: PIN.w2 });
    assert.equal(locked.status, 429); assert.equal(locked.data.error, 'locked');
    await setClock(61_000);
    ok(await c.post('/api/auth/login', { user_id: ids.w2, pin: PIN.w2 }));
    await setClock(0);
  });

  await t.test('system page: address, QR code, test print', async () => {
    const info = ok(await manager.get('/api/system/info'));
    assert.ok(info.urls.length >= 1); assert.equal(info.fiscal_mode, 'off');
    const qr = await manager.get('/api/system/qr.svg');
    assert.match(qr.data, /^<svg/);
    const before = printer.received.length;
    ok(await manager.post('/api/system/test-print'));
    await until(() => printer.received.length === before + 1);
    assert.match(printer.received.at(-1), /Printeri punon/);
    assert.equal((await owner.put('/api/admin/settings', { fiscal_mode: 'printer' })).status, 400);
    const anon = client(base);
    assert.equal((await anon.post('/api/system/check-boss-pin', { pin: PIN.w2 })).status, 401, 'a waiter PIN cannot quit the desktop app');
    ok(await anon.post('/api/system/check-boss-pin', { pin: PIN.manager }));
  });

  await t.test('owner reset wipes sales and keeps the menu and staff', async () => {
    assert.equal((await manager.post('/api/system/reset', { pin: PIN.manager })).status, 403);
    assert.equal((await owner.post('/api/system/reset', { pin: PIN.owner })).status, 409, 'day must be closed first');
    const view = ok(await manager.get('/api/day'));
    for (const s of view.sessions.filter((x) => !x.settled_at)) ok(await manager.post(`/api/sessions/${s.id}/settle`, { handed_cents: s.owed_cents }));
    ok(await manager.post('/api/day/close'));
    assert.equal((await owner.post('/api/system/reset', { pin: '1234' })).status, 401);
    ok(await owner.post('/api/system/reset', { pin: PIN.owner }));
    assert.equal(ok(await owner.get('/api/reports/days')).length, 0);
    assert.equal(ok(await owner.get('/api/admin/all')).users.length, 6);
    assert.equal(ok(await owner.get('/api/menu')).products.length, menu.products.length);
  });

  await t.test('a manager or owner PIN must be 6 digits, including on promotion', async () => {
    assert.equal((await owner.post('/api/admin/users', { name: 'Shkurt', pin: '1234', role: 'manager' })).status, 400);
    assert.equal((await owner.post('/api/admin/users', { name: 'Shkurt', pin: '1234', role: 'owner' })).status, 400);
    assert.equal((await owner.post('/api/admin/users', { name: 'Gjate', pin: '123456', role: 'waiter' })).status, 400, 'a staff PIN is exactly 4 digits');
    const id = ok(await owner.post('/api/admin/users', { name: 'Vogel', pin: '1234', role: 'waiter' })).id;
    // Promoting a waiter must not leave them approving voids with the 4 digits they already had.
    let r = await owner.put(`/api/admin/users/${id}`, { role: 'manager' });
    assert.equal(r.status, 400); assert.equal(r.data.error, 'pin_required');
    assert.equal((await owner.put(`/api/admin/users/${id}`, { role: 'manager', pin: '1234' })).status, 400);
    ok(await owner.put(`/api/admin/users/${id}`, { role: 'manager', pin: '775533' }));
    ok(await owner.put(`/api/admin/users/${id}`, { active: false }));   // tidy up
  });

  await t.test('the lockout gets longer every round, so guessing a PIN is not just waiting', async () => {
    const c = client(base);
    const wrong = () => c.post('/api/auth/login', { user_id: ids.w2, pin: '000000' });
    for (let i = 0; i < 5; i++) await wrong();
    let r = await c.post('/api/auth/login', { user_id: ids.w2, pin: PIN.w2 });
    assert.equal(r.status, 429);
    assert.ok(r.data.retry_in_sec <= 60, `first lock is a minute, got ${r.data.retry_in_sec}`);

    await setClock(61_000);                       // wait it out, then keep guessing
    for (let i = 0; i < 5; i++) await wrong();
    r = await c.post('/api/auth/login', { user_id: ids.w2, pin: PIN.w2 });
    assert.equal(r.status, 429);
    assert.ok(r.data.retry_in_sec > 60, `second lock must be longer than a minute, got ${r.data.retry_in_sec}`);

    await setClock(61_000 + 5 * 60_000 + 1000);   // the five minutes pass, the real PIN works again
    ok(await c.post('/api/auth/login', { user_id: ids.w2, pin: PIN.w2 }));
    await setClock(0);
  });

  await t.test('a phone left unused for two weeks stops working', async () => {
    // The clock route is public, so drive it from a client of its own: once the clock moves
    // two weeks on, every idle token has legitimately expired, the test's own included.
    const clock = client(base);
    const jump = (ms) => clock.post('/api/test/clock', { offset_ms: ms });
    const phone = client(base);
    ok(await phone.post('/api/auth/login', { user_id: ids.w3, pin: PIN.w3 }));
    ok(await phone.get('/api/auth/me'));
    await jump(15 * 24 * 3600_000);
    assert.equal((await phone.get('/api/tables')).status, 401, 'an idle token must stop working');
    await jump(0);
    ok(await phone.post('/api/auth/login', { user_id: ids.w3, pin: PIN.w3 }), 'and logging in again works');
  });

  await t.test('waiters see the tables and nothing about the money', async () => {
    ok(await owner.post('/api/auth/login', { user_id: ids.owner ?? 1, pin: PIN.owner }));
    ok(await manager.post('/api/auth/login', { user_id: ids.manager, pin: PIN.manager }));
    ok(await w1.post('/api/auth/login', { user_id: ids.w1, pin: PIN.w1 }));
    for (const url of ['/api/day', '/api/cash/live', '/api/me/session', '/api/tickets', '/api/reports/range', '/api/reports/staff', '/api/system/backups', '/api/system/printers', '/api/system/db', '/api/audit']) {
      assert.equal((await w1.get(url)).status, 403, url + ' must be closed to a waiter');
    }
    ok(await w1.get('/api/tables')); ok(await w1.get('/api/menu'));
    const info = ok(await w1.get('/api/system/info'));
    assert.equal(info.data_dir, undefined); assert.equal(info.urls, undefined); assert.equal(typeof info.day_open, 'boolean');
  });

  await t.test('reports for any period, and what each person did in it', async () => {
    ok(await manager.post('/api/day/open'));
    const E = ok(await w1.get('/api/menu')).products.find((p) => p.name === 'Espresso').price_cents * 3;
    const o = ok(await w1.post('/api/orders', { id: uid(), table_id: tables.tables[0].id }));
    ok(await w1.post(`/api/orders/${o.id}/items`, { batch_id: uid(), items: [{ product_id: product('Espresso').id, qty: 3 }] }));
    ok(await w1.post(`/api/orders/${o.id}/pay`, { payment_id: uid() }));
    const live = ok(await manager.get('/api/cash/live'));
    assert.equal(live.cash_cents, E); assert.equal(live.with_staff_cents, E); assert.equal(live.sessions.length, 1);
    const today = new Date().toLocaleDateString('sv-SE');
    const r = ok(await manager.get(`/api/reports/range?from=${today}&to=${today}`));
    assert.equal(r.totals.sales_cents, E); assert.equal(r.by_day.length, 1); assert.equal(r.by_item[0].key, 'Espresso'); assert.equal(r.by_item[0].qty, 3);
    assert.equal(ok(await manager.get('/api/reports/range?from=2001-01-01&to=2001-12-31')).totals.sales_cents, 0, 'a year with no sales is empty');
    assert.equal((await manager.get('/api/reports/range?from=2026-02-01&to=2026-01-01')).status, 400);
    assert.match((await manager.get(`/api/reports/range.csv?from=${today}&to=${today}`)).data, new RegExp('Total sales,' + (E / 100).toFixed(2)));
    // settle 50 cents short: that is a loss on the waiter's profile
    const s = (await sessionOf('w1')).session;
    ok(await manager.post(`/api/sessions/${s.id}/settle`, { handed_cents: s.owed_cents - 50 }));
    const staff = ok(await manager.get('/api/reports/staff'));
    const me = staff.find((u) => u.id === ids.w1);
    assert.equal(me.sales_cents, E); assert.equal(me.shortage_cents, -50); assert.equal(me.surplus_cents, 0); assert.equal(me.items, 3);
    const detail = ok(await manager.get(`/api/reports/staff/${ids.w1}?from=${today}&to=${today}`));
    assert.equal(detail.session_list.length, 1); assert.equal(detail.session_list[0].difference_cents, -50); assert.equal(detail.top_items[0].key, 'Espresso');
    ok(await manager.post('/api/day/close'));
  });

  await t.test('the floor plan is saved per zone and comes back with the tables', async () => {
    const zone = tables.zones[0].id, tb = tables.tables.find((x) => x.zone_id === zone);
    assert.equal((await w1.put(`/api/plan/${zone}`, { tables: [], items: [] })).status, 403);
    ok(await manager.put(`/api/plan/${zone}`, { tables: [{ id: tb.id, px: 120, py: 80, pw: 110, ph: 110, shape: 'round' }],
      items: [{ kind: 'bar', x: 400, y: 40, w: 300, h: 70, label: 'Banaku' }, { kind: 'chair', x: 420, y: 120, w: 36, h: 36 }] }));
    const view = ok(await w1.get('/api/tables'));
    const got = view.tables.find((x) => x.id === tb.id);
    assert.equal(got.px, 120); assert.equal(got.shape, 'round'); assert.equal(view.plan.filter((i) => i.zone_id === zone).length, 2);
    assert.equal((await manager.put(`/api/plan/${zone}`, { tables: [], items: [{ kind: 'rocket', x: 1, y: 1, w: 20, h: 20 }] })).status, 400);
    assert.equal(ok(await w1.get('/api/tables')).plan.filter((i) => i.zone_id === zone).length, 2, 'a refused save changes nothing');
  });

  await t.test('backups can be listed, looked into, uploaded and restored, by the owner PIN only', async () => {
    ok(await owner.post('/api/system/backup'));
    const list = ok(await owner.get('/api/system/backups'));
    assert.ok(list.length >= 1);
    const sum = ok(await owner.get(`/api/system/backups/${list[0].name}/summary`));
    assert.equal(sum.cafe_name, 'Test Cafe'); assert.ok(sum.users >= 6);
    assert.equal((await owner.get('/api/system/backups/..%2Fpos.db/summary')).status, 400, 'no wandering outside the backups folder');
    assert.equal((await manager.post(`/api/system/backups/${list[0].name}/restore`, { pin: PIN.manager })).status, 403);
    assert.equal((await owner.post(`/api/system/backups/${list[0].name}/restore`, { pin: PIN.manager })).status, 401, 'a manager PIN is not the owner PIN');
    // change something, restore, and it is back as it was
    ok(await owner.put('/api/admin/settings', { cafe_name: 'Changed' }));
    const out = ok(await owner.post(`/api/system/backups/${list[0].name}/restore`, { pin: PIN.owner }));
    assert.match(out.safety, /before-restore/);
    ok(await owner.post('/api/auth/login', { user_id: ids.owner ?? 1, pin: PIN.owner }));
    assert.equal(ok(await owner.get('/api/admin/all')).settings.cafe_name, 'Test Cafe');
    assert.equal((await owner.post('/api/system/reset', { pin: PIN.manager })).status, 401, 'wiping takes the owner PIN and nothing else');
  });

  await t.test('the owner can log every other device out and stay in', async () => {
    ok(await owner.post('/api/auth/login', { user_id: ids.owner ?? 1, pin: PIN.owner }));
    ok(await manager.post('/api/auth/login', { user_id: ids.manager, pin: PIN.manager }));
    const phone = client(base);
    ok(await phone.post('/api/auth/login', { user_id: ids.w1, pin: PIN.w1 }));
    ok(await phone.get('/api/tables'));
    const r = ok(await owner.post('/api/system/logout-all'));
    assert.ok(r.logged_out >= 1, 'something was logged out');
    assert.equal((await phone.get('/api/tables')).status, 401, 'the other phone is out');
    ok(await owner.get('/api/tables'), 'the owner keeps the screen they are standing at');
    assert.equal((await manager.get('/api/day')).status, 401, 'the manager is out too');
  });
});
