import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, client, fakePrinter, tmpDir, uid, until, sleep } from './helpers.js';

const PIN = { owner: '999999', manager: '888888', w1: '1111', bar: '4444' };
let app, base, printer, owner, manager, w1, bar, menu, tables, ids = {};
const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.data)}`); return r.data; };
const product = (n) => menu.products.find((p) => p.name === n);
const modifier = (n) => menu.modifiers.find((m) => m.name === n);
const st = async () => ok(await manager.get('/api/stock'));
const itemOf = async (name) => (await st()).items.find((i) => i.name === name);
const qty = async (name) => (await itemOf(name)).qty;
const setClock = (ms) => owner.post('/api/test/clock', { offset_ms: ms });
let tableNo = 0;
async function sell(c, lines) {
  const t = tables.tables[tableNo++];
  const o = ok(await c.post('/api/orders', { id: uid(), table_id: t.id }));
  return ok(await c.post(`/api/orders/${o.id}/items`, { batch_id: uid(), items: lines.map(([n, q, extra]) => ({ product_id: product(n).id, qty: q, ...(extra || {}) })) }));
}
const stockSlips = () => printer.received.filter((x) => /STOKU I ULET/.test(x));

test('stock', async (t) => {
  ({ app, base } = await boot(tmpDir()));
  printer = await fakePrinter();
  t.after(async () => { await app.close(); await printer.off().catch(() => {}); });

  owner = client(base);
  ok(await owner.post('/api/setup', { name: 'Pronari', pin: PIN.owner, cafe_name: 'Test Cafe' }));
  for (const [k, name, role] of [['manager', 'Menaxheri', 'manager'], ['w1', 'Arta', 'waiter'], ['bar', 'Banakieri', 'bartender']]) ids[k] = ok(await owner.post('/api/admin/users', { name, pin: PIN[k], role })).id;
  const login = async (k) => { const c = client(base); ok(await c.post('/api/auth/login', { user_id: ids[k], pin: PIN[k] })); return c; };
  manager = await login('manager'); w1 = await login('w1'); bar = await login('bar');
  ok(await owner.put('/api/admin/settings', { printer_mode: 'network', printer_host: '127.0.0.1', printer_port: String(printer.port) }));
  menu = ok(await w1.get('/api/menu')); tables = ok(await w1.get('/api/tables'));
  ok(await manager.post('/api/day/open'));

  await t.test('roles: waiters stay out, bartenders cannot set things up', async () => {
    assert.equal((await w1.get('/api/stock')).status, 403);
    assert.equal((await w1.post('/api/stock/deliveries', {})).status, 403);
    assert.equal((await bar.get('/api/stock/setup')).status, 403);
    assert.equal((await bar.post('/api/stock/items', { name: 'X' })).status, 403);
    assert.ok(Array.isArray(ok(await bar.get('/api/stock')).items));
  });

  await t.test('setup: coffee by the kg, tea by the box, bottles one by one', async () => {
    const p = ok(await manager.get('/api/stock/setup'));
    const coffee = p.items.find((i) => i.key === 'coffee');
    assert.equal(coffee.pack_size, 110);
    assert.equal(coffee.uses.find((u) => u.name === 'Espresso dopio').amount, 2);
    assert.equal(coffee.extras[0].name, 'Shot shtese');
    assert.equal(p.items.find((i) => i.key === 'tea').pack_size, 20);
    assert.ok(p.items.some((i) => i.name === 'Kola' && i.pack_size === 24));
    ok(await manager.post('/api/stock/setup', { items: p.items }));
    assert.equal(ok(await manager.get('/api/stock/setup')).items.length, 0, 'nothing proposed twice');
    const s = await st();
    assert.equal(s.items.find((i) => i.name === 'Kafe').live_state, 'unknown');
    assert.equal(s.alerts.length, 0, 'no warnings before the opening count');
  });

  await t.test('sales before the opening count use stock but raise nothing', async () => {
    await sell(w1, [['Espresso', 1]]);
    assert.equal(await qty('Kafe'), -1);
    assert.equal((await st()).alerts.length, 0);
  });

  await t.test('opening count: packs with decimals, and the sale made meanwhile is kept', async () => {
    const kafe = await itemOf('Kafe'), caj = await itemOf('Çaj'), kola = await itemOf('Kola');
    await sell(w1, [['Espresso', 1]]);              // sold while the form was open
    ok(await bar.post('/api/stock/counts', { entries: [
      { stock_item_id: kafe.id, packs: '2,5', seen_qty: kafe.qty },
      { stock_item_id: caj.id, units: 30, seen_qty: caj.qty },
      { stock_item_id: kola.id, units: 13, seen_qty: kola.qty },
    ] }));
    assert.equal(await qty('Kafe'), 275 - 1, '2.5 kg = 275 shots, minus the espresso sold during the count');
    assert.equal(await qty('Çaj'), 30);
    assert.equal(await qty('Kola'), 13);
  });

  await t.test('recipes: dopio uses 2 shots, an extra shot 1 more, a bottle 1', async () => {
    const before = await qty('Kafe');
    await sell(w1, [['Espresso dopio', 2, { modifier_ids: [modifier('Shot shtese').id] }], ['Kola', 1], ['Caj', 1]]);
    assert.equal(await qty('Kafe'), before - 6);
    assert.equal(await qty('Kola'), 12);
    assert.equal(await qty('Çaj'), 29);
  });

  await t.test('cancel: a quick mistake goes back, a later void counts as waste unless returned', async () => {
    let o = await sell(w1, [['Kola', 3]]);
    assert.equal(await qty('Kola'), 9);
    ok(await w1.post(`/api/orders/${o.id}/cancel-item`, { item_id: o.items[0].id, qty: 1 }));
    assert.equal(await qty('Kola'), 10, 'quick cancel returns it');
    await setClock(5 * 60_000);
    const line = ok(await w1.get(`/api/orders/${o.id}`)).items.find((i) => i.status === 'sent');
    ok(await w1.post(`/api/orders/${o.id}/cancel-item`, { item_id: line.id, qty: 1, reason: 'spilled', pin: PIN.manager }));
    assert.equal(await qty('Kola'), 10, 'a void after the window is waste: stock stays used');
    ok(await w1.post(`/api/orders/${o.id}/cancel-item`, { item_id: line.id, qty: 1, reason: 'not opened', pin: PIN.manager, restock: true }));
    assert.equal(await qty('Kola'), 11, 'unless the manager says it goes back');
    await setClock(0);
  });

  await t.test('a recipe changed after the sale: the cancel returns what was really used', async () => {
    const o = await sell(w1, [['Espresso dopio', 1]]);
    const before = await qty('Kafe');
    const kafe = await itemOf('Kafe');
    ok(await manager.put(`/api/stock/recipes/product/${product('Espresso dopio').id}`, { lines: [{ stock_item_id: kafe.id, amount: 3 }] }));
    ok(await w1.post(`/api/orders/${o.id}/cancel-item`, { item_id: o.items[0].id }));
    assert.equal(await qty('Kafe'), before + 2);
    ok(await manager.put(`/api/stock/recipes/product/${product('Espresso dopio').id}`, { lines: [{ stock_item_id: kafe.id, amount: 2 }] }));
  });

  await t.test('split payment keeps the snapshot on both lines', async () => {
    const o = await sell(w1, [['Kola', 2]]);
    ok(await w1.post(`/api/orders/${o.id}/pay`, { payment_id: uid(), type: 'cash', items: [{ id: o.items[0].id, qty: 1 }] }));
    const lines = ok(await w1.get(`/api/orders/${o.id}`)).items;
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => l.stock && JSON.parse(l.stock)[0].a === 1));
    const unpaid = lines.find((l) => !l.payment_id);
    const before = await qty('Kola');
    ok(await w1.post(`/api/orders/${o.id}/cancel-item`, { item_id: unpaid.id }));
    assert.equal(await qty('Kola'), before + 1);
  });

  await t.test('warnings: one alert and one slip per crossing, never a block, cleared by a delivery', async () => {
    const kola = await itemOf('Kola');
    ok(await manager.put(`/api/stock/items/${kola.id}`, { low_level: 8 }));
    await sleep(400);              // a slip from an earlier crossing may still be on its way to the printer
    const slips = stockSlips().length;
    // Sell down to the warning level: exactly one "low" warning.
    while (await qty('Kola') > 8) await sell(w1, [['Kola', 1]]);
    await until(() => stockSlips().length === slips + 1);
    let s = await st();
    assert.deepEqual(s.alerts.map((a) => [a.name, a.level]), [['Kola', 'low']]);
    await sell(w1, [['Kola', 1]]);
    await sleep(300);
    assert.equal(stockSlips().length, slips + 1, 'selling more raises nothing new');
    // Below zero: the sale still goes through, and "out" is raised once.
    await sell(w1, [['Kola', 9]]);
    assert.equal(await qty('Kola'), -2);
    await until(() => stockSlips().length === slips + 2);
    assert.match(stockSlips().at(-1), /MBAROI: Kola/);
    s = await st();
    assert.deepEqual(s.alerts.map((a) => a.level).sort(), ['low', 'out']);
    assert.equal(ok(await w1.get('/api/menu')).products.find((p) => p.name === 'Kola').stock_state, 'out');
    assert.equal((await stockSlips()).length, slips + 2);
    // Seen, then a delivery brings it back above the level: the warnings are gone.
    ok(await bar.post(`/api/stock/alerts/${s.alerts[0].id}/seen`));
    ok(await bar.post('/api/stock/deliveries', { stock_item_id: kola.id, packs: 1 }));
    assert.equal(await qty('Kola'), 22);
    assert.equal((await st()).alerts.length, 0);
    assert.equal(ok(await w1.get('/api/menu')).products.find((p) => p.name === 'Kola').stock_state, null);
  });

  await t.test('shopping list: what is low and how many packs bring it back to full', async () => {
    const caj = await itemOf('Çaj');
    ok(await manager.put(`/api/stock/items/${caj.id}`, { low_level: 30, full_level: 100 }));
    const list = ok(await bar.get('/api/stock/shopping-list'));
    const row = list.find((l) => l.name === 'Çaj');
    assert.equal(row.buy_packs, Math.ceil((100 - caj.qty) / 20));
    ok(await bar.post('/api/stock/shopping-list/print'));
    await until(() => printer.received.some((x) => /LISTA E BLERJES/.test(x)));
  });

  await t.test('costs: a bartender price is ignored, the average follows two deliveries, profit in the report', async () => {
    const kafe = await itemOf('Kafe');
    ok(await bar.post('/api/stock/deliveries', { stock_item_id: kafe.id, packs: 1, total_cents: 99999 }));
    assert.equal((await itemOf('Kafe')).avg_cost_cents_per_pack, null);
    // Count to a known shelf, then two deliveries at different prices.
    let k = await itemOf('Kafe');
    ok(await manager.post('/api/stock/counts', { entries: [{ stock_item_id: k.id, units: 0, seen_qty: k.qty }] }));
    ok(await manager.post('/api/stock/deliveries', { stock_item_id: k.id, packs: 1, total_cents: 2200 }));   // 20c a shot
    ok(await manager.post('/api/stock/deliveries', { stock_item_id: k.id, packs: 1, total_cents: 3300 }));   // 30c a shot
    k = await itemOf('Kafe');
    assert.equal(k.avg_cost_cents_per_pack, 2750);
    assert.equal(k.value_cents, 5500);
    assert.equal(ok(await bar.get('/api/stock')).items.find((i) => i.name === 'Kafe').avg_cost_cents_per_pack, undefined, 'bartenders see no money');
    ok(await owner.put(`/api/admin/products/${product('Espresso dopio').id}`, { price_cents: 200 }));
    const o = await sell(w1, [['Espresso dopio', 1]]);
    assert.equal(ok(await w1.get(`/api/orders/${o.id}`)).items[0].cost_cents, 50);
    ok(await w1.post(`/api/orders/${o.id}/pay`, { payment_id: uid(), type: 'cash' }));
    const rep = ok(await manager.get('/api/reports/day'));
    const row = rep.stock.products.find((p) => p.name === 'Espresso dopio');
    assert.equal(row.cost_cents, 50);
    assert.equal(row.profit_cents, 150);
  });

  await t.test('corrections: a delivery typed twice is taken back once, sales cannot be corrected', async () => {
    const k = await itemOf('Kafe');
    const d = ok(await manager.post('/api/stock/deliveries', { stock_item_id: k.id, packs: 1, total_cents: 2750 }));
    ok(await manager.post(`/api/stock/moves/${d.move_id}/correct`));
    assert.equal((await itemOf('Kafe')).qty, k.qty);
    assert.equal((await itemOf('Kafe')).avg_cost_cents_per_pack, 2750);
    assert.equal((await manager.post(`/api/stock/moves/${d.move_id}/correct`)).status, 409);
    assert.equal((await bar.post(`/api/stock/moves/${d.move_id}/correct`)).status, 403);
    const sale = ok(await manager.get('/api/stock/moves?kind=sale&limit=1'))[0];
    assert.equal((await manager.post(`/api/stock/moves/${sale.id}/correct`)).status, 400);
  });

  await t.test('waste needs a reason', async () => {
    const k = await itemOf('Kola');
    assert.equal((await bar.post('/api/stock/waste', { stock_item_id: k.id, units: 1 })).status, 400);
    ok(await bar.post('/api/stock/waste', { stock_item_id: k.id, units: 1, reason: 'broken' }));
    assert.equal(await qty('Kola'), k.qty - 1);
  });

  await t.test('wiping the test data keeps items and recipes and asks for a new count', async () => {
    const day = ok(await manager.get('/api/day'));
    for (const o of ok(await w1.get('/api/tables')).tables.filter((x) => x.order_id)) {
      const v = ok(await w1.get(`/api/orders/${o.order_id}`));
      if (v.due_cents > 0) ok(await w1.post(`/api/orders/${o.order_id}/pay`, { payment_id: uid(), type: 'cash' }));
    }
    for (const s of ok(await manager.get('/api/day')).sessions.filter((x) => !x.settled_at)) ok(await manager.post(`/api/sessions/${s.id}/settle`, { handed_cents: s.owed_cents }));
    assert.ok(day);
    ok(await manager.post('/api/day/close'));
    ok(await owner.post('/api/system/reset', { pin: PIN.owner }));
    const s = await st();
    assert.ok(s.items.length > 3);
    assert.ok(s.items.every((i) => i.qty === 0 && i.live_state === 'unknown'));
    assert.ok(s.recipes.length > 5);
    assert.equal(ok(await manager.get('/api/stock/moves')).length, 0);
  });
});
