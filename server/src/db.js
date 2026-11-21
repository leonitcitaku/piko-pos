import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export let db = null;
export let dataDir = null;

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, pin_hash TEXT NOT NULL, pin_salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner','manager','waiter','bartender')),
    language TEXT NOT NULL DEFAULT 'sq', active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE auth_tokens (
    token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
    device TEXT, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
  );
  CREATE TABLE pin_attempts (device TEXT PRIMARY KEY, count INTEGER NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE zones (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE tables (
    id INTEGER PRIMARY KEY, zone_id INTEGER NOT NULL REFERENCES zones(id), name TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE products (
    id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id), name TEXT NOT NULL,
    price_cents INTEGER NOT NULL, vat_rate INTEGER NOT NULL DEFAULT 18, sort INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1, available INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE modifiers (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL DEFAULT 0,
    category_id INTEGER REFERENCES categories(id), active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE business_days (
    id INTEGER PRIMARY KEY, opened_by INTEGER NOT NULL, opened_at INTEGER NOT NULL,
    closed_by INTEGER, closed_at INTEGER, status TEXT NOT NULL DEFAULT 'open', catch_up INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY, day_id INTEGER NOT NULL REFERENCES business_days(id), user_id INTEGER NOT NULL REFERENCES users(id),
    started_at INTEGER NOT NULL, float_cents INTEGER NOT NULL DEFAULT 0, expected_cents INTEGER, handed_cents INTEGER,
    difference_cents INTEGER, confirmed_by INTEGER, settled_at INTEGER
  );
  CREATE TABLE orders (
    id TEXT PRIMARY KEY, table_id INTEGER NOT NULL REFERENCES tables(id), day_id INTEGER NOT NULL REFERENCES business_days(id),
    waiter_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'open',
    opened_at INTEGER NOT NULL, closed_at INTEGER, entered_late INTEGER NOT NULL DEFAULT 0,
    fiscal_status TEXT, fiscal_receipt_no TEXT
  );
  CREATE INDEX orders_open ON orders(status, table_id);
  CREATE TABLE batches (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE order_items (
    id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL,
    name TEXT NOT NULL, price_cents INTEGER NOT NULL, vat_rate INTEGER NOT NULL, qty INTEGER NOT NULL,
    modifiers TEXT NOT NULL DEFAULT '[]', note TEXT, discount_pct INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'sent', void_reason TEXT, void_by INTEGER, voided_at INTEGER,
    batch_id TEXT NOT NULL, sent_by INTEGER NOT NULL, sent_at INTEGER NOT NULL, payment_id TEXT
  );
  CREATE INDEX items_order ON order_items(order_id);
  CREATE TABLE payments (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL, session_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('cash','house')), amount_cents INTEGER NOT NULL,
    approved_by INTEGER, created_at INTEGER NOT NULL
  );
  CREATE TABLE cash_movements (
    id INTEGER PRIMARY KEY, day_id INTEGER NOT NULL, session_id INTEGER, type TEXT NOT NULL CHECK (type IN ('float','payout')),
    amount_cents INTEGER NOT NULL, reason TEXT, approved_by INTEGER, created_at INTEGER NOT NULL
  );
  CREATE TABLE print_jobs (
    id INTEGER PRIMARY KEY, day_id INTEGER, order_id TEXT, batch_id TEXT, user_id INTEGER, kind TEXT NOT NULL,
    content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'waiting', attempts INTEGER NOT NULL DEFAULT 0,
    original_time INTEGER NOT NULL, last_error TEXT, printed_at INTEGER, was_late INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX jobs_status ON print_jobs(status, id);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL, target TEXT, detail TEXT, device TEXT, at INTEGER NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // 2: remember when a device last got a PIN wrong, so the lockout can grow and then be forgotten.
  `ALTER TABLE pin_attempts ADD COLUMN last_fail INTEGER NOT NULL DEFAULT 0;`,
  // 3: a floor plan the owner draws. Where each table stands, plus the bar, chairs, walls and labels around them.
  `
  ALTER TABLE tables ADD COLUMN px INTEGER;
  ALTER TABLE tables ADD COLUMN py INTEGER;
  ALTER TABLE tables ADD COLUMN pw INTEGER;
  ALTER TABLE tables ADD COLUMN ph INTEGER;
  ALTER TABLE tables ADD COLUMN shape TEXT NOT NULL DEFAULT 'square';
  CREATE TABLE plan_items (
    id INTEGER PRIMARY KEY, zone_id INTEGER NOT NULL REFERENCES zones(id), kind TEXT NOT NULL,
    x INTEGER NOT NULL, y INTEGER NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL, label TEXT
  );
  CREATE INDEX plan_zone ON plan_items(zone_id);
  `,
];

export function openDb(dir) {
  dataDir = dir;
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, 'pos.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const v = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try { db.exec(MIGRATIONS[i]); db.exec(`PRAGMA user_version = ${i + 1}`); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  if (!get('SELECT 1 AS x FROM categories LIMIT 1')) seed();
  return db;
}

export function closeDb() { if (db) { db.close(); db = null; } }

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s || s.__db !== db) { s = db.prepare(sql); s.__db = db; cache.set(sql, s); }
  return s;
}
export const get = (sql, ...p) => stmt(sql).get(...p);
export const all = (sql, ...p) => stmt(sql).all(...p);
export const run = (sql, ...p) => stmt(sql).run(...p);

let depth = 0;
export function tx(fn) {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE'); depth++;
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { depth--; }
}

export function getSetting(key, fallback = null) {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : fallback;
}
export function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

export function hashPin(pin, salt = crypto.randomBytes(8).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pin), salt, 32).toString('hex') };
}
export function checkPin(user, pin) {
  const h = crypto.scryptSync(String(pin), user.pin_salt, 32);
  return crypto.timingSafeEqual(h, Buffer.from(user.pin_hash, 'hex'));
}

// Starter data. Prices are placeholders: the owner sets the real ones before opening.
function seed() {
  const P = 100, VAT = 18;
  const menu = [
    ['Kafe', ['Espresso', 'Espresso dopio', 'Makiato e vogel', 'Makiato e madhe', 'Kapucino', 'Latte', 'Amerikano', 'Kafe e ftohte']],
    ['Pije te nxehta', ['Caj', 'Cokollate e nxehte']],
    ['Pije freskuese', ['Kola', 'Fanta', 'Tonik', 'Caj i ftohte', 'Pije energjike']],
    ['Lengje', ['Leng portokalli', 'Leng molle', 'Portokall i shtrydhur']],
    ['Uje', ['Uje natyral', 'Uje mineral']],
    ['Birra', ['Birre e vogel', 'Birre e madhe', 'Birre shishe']],
    ['Vera', ['Vere e kuqe gote', 'Vere e bardhe gote', 'Shishe vere']],
    ['Pije alkoolike', ['Raki', 'Uiski', 'Vodke', 'Xhin', 'Koktej']],
  ];
  tx(() => {
    menu.forEach(([cat, items], ci) => {
      const c = run('INSERT INTO categories(name, sort) VALUES(?, ?)', cat, ci).lastInsertRowid;
      items.forEach((n, pi) => run('INSERT INTO products(category_id, name, price_cents, vat_rate, sort) VALUES(?,?,?,?,?)', c, n, P, VAT, pi));
    });
    const coffee = get("SELECT id FROM categories WHERE name = 'Kafe'").id;
    run('INSERT INTO modifiers(name, price_cents, category_id) VALUES(?,?,?)', 'Shot shtese', 50, coffee);
    run('INSERT INTO modifiers(name, price_cents, category_id) VALUES(?,?,?)', 'Qumesht tershere', 30, coffee);
    run('INSERT INTO modifiers(name, price_cents, category_id) VALUES(?,?,?)', 'Pa sheqer', 0, coffee);
    const zones = [['Brenda', 15, ''], ['Terasa', 12, 'T'], ['Banaku', 3, 'B']];
    zones.forEach(([z, n, prefix], zi) => {
      const zid = run('INSERT INTO zones(name, sort) VALUES(?, ?)', z, zi).lastInsertRowid;
      for (let i = 1; i <= n; i++) run('INSERT INTO tables(zone_id, name, sort) VALUES(?,?,?)', zid, prefix + i, i);
    });
    const defaults = { cafe_name: 'Cafe', printer_mode: 'off', printer_host: '', printer_port: '9100', printer_share: '',
      fiscal_mode: 'off', cancel_window_sec: '120', backup_dir: '', idle_lock_sec: '60' };
    for (const [k, v] of Object.entries(defaults)) setSetting(k, v);
  });
}
