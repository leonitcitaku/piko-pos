// Installing a new version over an old one must keep every row. The fixture was made with Cafe POS 1.0.0
// (data version 3): an owner, a manager and a waiter, real prices, a closed day with a paid order and a cancel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { boot, client, tmpDir } from './helpers.js';
import { SCHEMA_VERSION } from '../src/db.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'v1.0.0.db');
const withFixture = () => { const dir = tmpDir(); fs.copyFileSync(fixture, path.join(dir, 'pos.db')); return dir; };
const counts = (file) => {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    const n = (t) => d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    return { version: d.prepare('PRAGMA user_version').get().user_version, users: n('users'), orders: n('orders'), items: n('order_items'),
      payments: n('payments'), days: n('business_days'), products: n('products'), audit: n('audit_log'),
      espresso: d.prepare("SELECT price_cents FROM products WHERE name = 'Espresso'").get().price_cents,
      paid: d.prepare('SELECT SUM(amount_cents) AS s FROM payments').get().s,
      voids: d.prepare("SELECT COUNT(*) AS n FROM order_items WHERE status = 'void'").get().n };
  } finally { d.close(); }
};
const beforeUpdate = (dir) => fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.includes('before-update-v3'));

test('updating from 1.0.0 keeps all the data', async () => {
  const old = counts(fixture);
  assert.equal(old.version, 3);
  const dir = withFixture();
  let { app, base } = await boot(dir);
  // The people of 1.0.0 still log in with their own PIN.
  const c = client(base);
  const users = (await c.get('/api/auth/users')).data;
  assert.equal(users.length, 3);
  assert.equal((await c.post('/api/auth/login', { user_id: users.find((u) => u.role === 'owner').id, pin: '999999' })).status, 200);
  await app.close();

  const now = counts(path.join(dir, 'pos.db'));
  assert.equal(now.version, SCHEMA_VERSION);
  for (const k of ['users', 'orders', 'items', 'payments', 'days', 'products', 'espresso', 'paid', 'voids']) assert.equal(now[k], old[k], k);
  assert.ok(now.audit >= old.audit);

  // A copy of the data as 1.0.0 left it, untouched by the update.
  const copies = beforeUpdate(dir);
  assert.equal(copies.length, 1);
  assert.deepEqual(counts(path.join(dir, 'backups', copies[0])), old);

  // The next start has nothing to update and makes no second copy.
  ({ app } = await boot(dir));
  await app.close();
  assert.equal(beforeUpdate(dir).length, 1);
});

test('an older app refuses newer data and leaves it alone', async () => {
  const dir = withFixture();
  const file = path.join(dir, 'pos.db');
  const d = new DatabaseSync(file); d.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`); d.close();
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const before = hash();
  await assert.rejects(boot(dir), (e) => e.code === 'db_newer');
  assert.equal(hash(), before);
});

test('a backup from a newer version is not restored', async () => {
  const dir = tmpDir();
  const { app, base } = await boot(dir);
  try {
    const owner = client(base);
    assert.equal((await owner.post('/api/setup', { name: 'Pronari', pin: '999999', cafe_name: 'X' })).status, 200);
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    const newer = path.join(dir, 'backups', 'pos-20991231-000000-manual.db');
    fs.copyFileSync(fixture, newer);
    const d = new DatabaseSync(newer); d.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`); d.close();
    const r = await owner.post('/api/system/backups/pos-20991231-000000-manual.db/restore', { pin: '999999' });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, 'backup_newer');
  } finally { await app.close(); }
});
