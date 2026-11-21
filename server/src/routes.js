import os from 'node:os';
import { get, all, run, tx, getSetting, setSetting, hashPin, dataDir } from './db.js';
import { HttpError, bad, conflict, int, sendJson } from './http.js';
import { now, setClockOffset } from './clock.js';
import * as auth from './auth.js';
import * as orders from './services/orders.js';
import * as dayS from './services/day.js';
import * as reports from './services/reports.js';
import { audit } from './services/audit.js';
import { addClient, broadcast, clientCount } from './services/events.js';
import { runBackup, listBackups, backupSummary, backupFile, saveUploaded, restoreBackup, dbInfo } from './services/backup.js';
import { listPrinters } from './util/printers.js';
import fs from 'node:fs';
import { listTickets, reprint, skip, enqueueTicket, printerState, pump } from './print/queue.js';
import { qrSvg } from './util/qr.js';

const STAFF = ['waiter', 'bartender', 'manager', 'owner'];
const BOSS = ['manager', 'owner'];
const OWNER = ['owner'];
const COOKIE = (token, maxAge = 60 * 60 * 24 * 30) => `pos_token=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;

export function lanUrls(port) {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  ips.sort((a, b) => rank(a) - rank(b));
  return ips.map((ip) => `http://${ip}${port === 80 ? '' : ':' + port}`);
}

export function registerRoutes(r, cfg) {
  // ---------- first run and login ----------
  r.get('/api/setup/status', { public: true }, () => ({ needs_setup: !get('SELECT 1 AS x FROM users LIMIT 1'), cafe_name: getSetting('cafe_name', 'Cafe') }));
  r.post('/api/setup', { public: true }, (c) => {
    if (get('SELECT 1 AS x FROM users LIMIT 1')) throw conflict('already_set_up');
    const id = auth.createUser({ name: c.body.name, pin: c.body.pin, role: 'owner', language: c.body.language || 'sq' });
    if (c.body.cafe_name) setSetting('cafe_name', String(c.body.cafe_name).slice(0, 40));
    const out = auth.login(id, c.body.pin, c.device);
    c.setCookie = COOKIE(out.token);
    return out.user;
  });
  r.get('/api/auth/users', { public: true }, () => all("SELECT id, name, role FROM users WHERE active = 1 ORDER BY CASE role WHEN 'waiter' THEN 0 WHEN 'bartender' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END, name"));
  const doLogin = (c) => {
    const out = auth.login(int(c.body.user_id, 'user_id'), c.body.pin, c.device);
    if (c.token) auth.logout(c.token);
    c.setCookie = COOKIE(out.token);
    return out.user;
  };
  r.post('/api/auth/login', { public: true }, doLogin);
  r.post('/api/auth/switch', { public: true }, doLogin);
  r.post('/api/auth/logout', { public: true }, (c) => { if (c.token) auth.logout(c.token); c.setCookie = COOKIE('', 0); return { ok: true }; });
  r.get('/api/auth/me', { public: true }, (c) => ({ user: c.user || null }));
  r.put('/api/auth/language', { roles: STAFF }, (c) => {
    const lang = c.body.language === 'en' ? 'en' : 'sq';
    run('UPDATE users SET language = ? WHERE id = ?', lang, c.user.id);
    return { ...c.user, language: lang };
  });

  // ---------- menu and tables ----------
  r.get('/api/menu', { roles: STAFF }, () => ({
    categories: all('SELECT id, name FROM categories WHERE active = 1 ORDER BY sort, id'),
    products: all('SELECT id, category_id, name, price_cents, available FROM products WHERE active = 1 ORDER BY sort, id'),
    modifiers: all('SELECT id, name, price_cents, category_id FROM modifiers WHERE active = 1 ORDER BY id'),
  }));
  r.get('/api/tables', { roles: STAFF }, () => orders.tablesView());
  r.post('/api/products/:id/available', { roles: ['bartender', 'manager', 'owner'] }, (c) => {
    run('UPDATE products SET available = ? WHERE id = ?', c.body.available ? 1 : 0, int(c.params.id, 'id'));
    audit(c, c.body.available ? 'back_in_stock' : 'sold_out', c.params.id);
    broadcast('menu');
    return { ok: true };
  });

  // ---------- orders ----------
  r.post('/api/orders', { roles: STAFF }, (c) => orders.openOrder(c, c.body));
  r.get('/api/orders/:id', { roles: STAFF }, (c) => orders.orderView(c.params.id));
  r.post('/api/orders/:id/items', { roles: STAFF }, (c) => orders.addItems(c, c.params.id, c.body));
  r.post('/api/orders/:id/cancel-item', { roles: STAFF }, (c) => orders.cancelItem(c, c.params.id, c.body));
  r.post('/api/orders/:id/discount', { roles: STAFF }, (c) => orders.discount(c, c.params.id, c.body));
  r.post('/api/orders/:id/move', { roles: STAFF }, (c) => orders.moveOrder(c, c.params.id, c.body));
  r.post('/api/orders/:id/merge', { roles: STAFF }, (c) => orders.mergeOrder(c, c.params.id, c.body));
  r.post('/api/orders/:id/move-items', { roles: STAFF }, (c) => orders.moveItems(c, c.params.id, c.body));
  r.post('/api/orders/:id/pass', { roles: STAFF }, (c) => orders.passOrder(c, c.params.id, c.body));
  r.post('/api/orders/:id/pay', { roles: STAFF }, (c) => orders.pay(c, c.params.id, c.body));
  r.get('/api/me/session', { roles: BOSS }, (c) => orders.mySession(c));

  // ---------- tickets ----------
  r.get('/api/tickets', { roles: BOSS }, () => {
    const day = orders.currentDay();
    return { printer: { ...printerState, mode: getSetting('printer_mode', 'off') }, tickets: listTickets(day?.id) };
  });
  r.get('/api/orders/:id/tickets', { roles: STAFF }, (c) => all("SELECT id, kind, status, original_time, was_late FROM print_jobs WHERE order_id = ? ORDER BY id", c.params.id));
  r.post('/api/tickets/:id/reprint', { roles: STAFF }, (c) => {
    const id = reprint(int(c.params.id, 'id'), c.user.id);
    if (!id) throw new HttpError(404, 'no_ticket');
    audit(c, 'reprint', c.params.id);
    return { job_id: id };
  });
  r.post('/api/tickets/:id/skip', { roles: BOSS }, (c) => { skip(int(c.params.id, 'id')); audit(c, 'ticket_skipped', c.params.id); return { ok: true }; });

  // ---------- business day, sessions, cash ----------
  r.get('/api/day', { roles: BOSS }, () => dayS.dayView());
  r.get('/api/cash/live', { roles: BOSS }, () => dayS.cashLive());
  r.post('/api/day/open', { roles: BOSS }, (c) => dayS.openBusinessDay(c));
  r.post('/api/day/close', { roles: BOSS }, (c) => dayS.closeBusinessDay(c));
  r.post('/api/day/catch-up', { roles: BOSS }, (c) => dayS.setCatchUp(c, !!c.body.on));
  r.post('/api/sessions/float', { roles: BOSS }, (c) => dayS.giveFloat(c, c.body));
  r.post('/api/sessions/:id/settle', { roles: BOSS }, (c) => dayS.settle(c, int(c.params.id, 'id'), c.body));
  r.post('/api/cash/payout', { roles: BOSS }, (c) => dayS.payout(c, c.body));

  // ---------- reports ----------
  r.get('/api/reports/days', { roles: BOSS }, () => reports.listDays());
  r.get('/api/reports/day', { roles: BOSS }, (c) => reports.dayReport(c.query.id ? int(c.query.id, 'id') : null));
  r.get('/api/reports/day.csv', { roles: BOSS }, (c) => ({ __raw: reports.dayReportCsv(c.query.id ? int(c.query.id, 'id') : null), type: 'text/csv; charset=utf-8', filename: `day-${c.query.id || 'latest'}.csv` }));
  r.get('/api/reports/session/:id', { roles: BOSS }, (c) => orders.sessionTotals(int(c.params.id, 'id')));
  r.get('/api/reports/range', { roles: BOSS }, (c) => { const { from, to } = reports.parseRange(c.query); return reports.rangeReport(from, to); });
  r.get('/api/reports/range.csv', { roles: BOSS }, (c) => { const { from, to } = reports.parseRange(c.query);
    return { __raw: reports.rangeReportCsv(from, to), type: 'text/csv; charset=utf-8', filename: `report-${c.query.from || 'start'}-${c.query.to || 'now'}.csv` }; });
  r.get('/api/reports/staff', { roles: BOSS }, (c) => { const { from, to } = reports.parseRange(c.query); return reports.staffReport(from, to); });
  r.get('/api/reports/staff/:id', { roles: BOSS }, (c) => { const { from, to } = reports.parseRange(c.query); return reports.staffDetail(int(c.params.id, 'id'), from, to); });
  r.get('/api/audit', { roles: BOSS }, (c) => {
    const rows = all('SELECT l.*, u.name AS user_name, u.role AS user_role FROM audit_log l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT ?', Math.min(int(c.query.limit || 200, 'limit'), 1000));
    return rows.map((l) => { try { return { ...l, detail: JSON.parse(l.detail) }; } catch { return l; } });
  });

  // ---------- admin ----------
  const ENT = {
    categories: { fields: ['name', 'sort', 'active'], create: BOSS },
    products: { fields: ['category_id', 'name', 'price_cents', 'vat_rate', 'sort', 'active', 'available'], ownerOnly: ['price_cents', 'vat_rate'], create: OWNER, required: ['category_id', 'name', 'price_cents'] },
    modifiers: { fields: ['name', 'price_cents', 'category_id', 'active'], ownerOnly: ['price_cents'], create: OWNER, required: ['name'] },
    zones: { fields: ['name', 'sort', 'active'], create: BOSS, required: ['name'] },
    tables: { fields: ['zone_id', 'name', 'sort', 'active'], create: BOSS, required: ['zone_id', 'name'] },
  };
  const clean = (ent, body, user) => {
    const out = {};
    for (const f of ent.fields) {
      if (!(f in body)) continue;
      if (ent.ownerOnly?.includes(f) && user.role !== 'owner') throw new HttpError(403, 'owner_only', 'Only the owner can change prices');
      let v = body[f];
      if (f === 'name') { v = String(v).trim().slice(0, 60); if (!v) throw bad('name_required'); }
      else if (v === null && f === 'category_id') v = null;
      else if (typeof v === 'boolean') v = v ? 1 : 0;
      else { v = int(v, f); if (f === 'price_cents' && v < 0) throw bad('bad_price'); }
      out[f] = v;
    }
    return out;
  };
  r.get('/api/admin/all', { roles: BOSS }, () => ({
    categories: all('SELECT * FROM categories ORDER BY sort, id'), products: all('SELECT * FROM products ORDER BY category_id, sort, id'),
    modifiers: all('SELECT * FROM modifiers ORDER BY id'), zones: all('SELECT * FROM zones ORDER BY sort, id'), tables: all('SELECT * FROM tables ORDER BY zone_id, sort, id'),
    users: all('SELECT id, name, role, language, active FROM users ORDER BY active DESC, role, name'),
    settings: Object.fromEntries(all('SELECT key, value FROM settings').filter((s) => !s.key.startsWith('last_')).map((s) => [s.key, s.value])),
  }));
  r.post('/api/admin/:entity', { roles: BOSS }, (c) => {
    if (c.params.entity === 'users') return createUserRoute(c);
    const ent = ENT[c.params.entity];
    if (!ent) throw new HttpError(404, 'no_entity');
    if (!ent.create.includes(c.user.role)) throw new HttpError(403, 'owner_only');
    const v = clean(ent, c.body, c.user);
    for (const f of ent.required || ['name']) if (v[f] == null) throw bad('missing_field', f);
    const keys = Object.keys(v);
    const res = run(`INSERT INTO ${c.params.entity}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map((k) => v[k]));
    audit(c, 'admin_create', c.params.entity, v);
    broadcast('menu'); broadcast('tables');
    return { id: Number(res.lastInsertRowid) };
  });
  r.put('/api/admin/settings', { roles: BOSS }, (c) => {
    const managerKeys = ['printer_mode', 'printer_host', 'printer_port', 'printer_share', 'printer_name', 'ticket_width'];
    const ownerKeys = [...managerKeys, 'cafe_name', 'cancel_window_sec', 'backup_dir', 'idle_lock_sec', 'fiscal_mode', 'backups_keep', 'login_idle_days', 'late_after_sec'];
    const ranges = { cancel_window_sec: [0, 3600], idle_lock_sec: [10, 3600], backups_keep: [5, 365], login_idle_days: [1, 365], late_after_sec: [10, 3600] };
    const allowed = c.user.role === 'owner' ? ownerKeys : managerKeys;
    for (const [k, v] of Object.entries(c.body || {})) {
      if (!allowed.includes(k)) throw new HttpError(403, 'not_allowed', k);
      if (k === 'fiscal_mode' && v !== 'off') throw bad('fiscal_not_ready', 'No fiscal driver is installed yet');
      if (k === 'printer_mode' && !['off', 'network', 'windows', 'winraw', 'file'].includes(v)) throw bad('bad_value', k);
      if (k === 'ticket_width' && !['32', '42', '48'].includes(String(v))) throw bad('bad_value', k);
      if (ranges[k]) { const n = Number(v); if (!Number.isInteger(n) || n < ranges[k][0] || n > ranges[k][1]) throw bad('bad_value', `${k} must be between ${ranges[k][0]} and ${ranges[k][1]}`); }
      setSetting(k, String(v).slice(0, 200));
    }
    audit(c, 'settings', null, c.body);
    // A printer that was just changed starts with a clean slate: the old one's failure must not stay on every screen.
    if (Object.keys(c.body || {}).some((k) => k.startsWith('printer_'))) { printerState.ok = true; printerState.error = null; broadcast('printer', { ok: true }); }
    setImmediate(pump);
    return { ok: true };
  });
  function createUserRoute(c) {
    if (c.user.role !== 'owner') throw new HttpError(403, 'owner_only');
    if (!STAFF.includes(c.body.role)) throw bad('bad_role');
    const id = auth.createUser(c.body);
    audit(c, 'user_create', id, { name: c.body.name, role: c.body.role });
    return { id };
  }
  r.put('/api/admin/users/:id', { roles: OWNER }, (c) => {
    const id = int(c.params.id, 'id');
    const u = get('SELECT * FROM users WHERE id = ?', id);
    if (!u) throw new HttpError(404, 'no_user');
    const b = c.body;
    const next = { name: b.name != null ? String(b.name).trim() : u.name, role: b.role ?? u.role, language: b.language ?? u.language, active: b.active == null ? u.active : (b.active ? 1 : 0) };
    if (!next.name) throw bad('name_required');
    if (!STAFF.includes(next.role)) throw bad('bad_role');
    if (u.role === 'owner' && (next.role !== 'owner' || !next.active) && get("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND active = 1").n <= 1) throw conflict('last_owner', 'There must be at least one owner');
    run('UPDATE users SET name = ?, role = ?, language = ?, active = ? WHERE id = ?', next.name, next.role, next.language, next.active, id);
    // Promoting someone into an approver role needs a fresh 6 digit PIN, or they would
    // keep approving voids and free drinks with the 4 digits they had as a waiter.
    const becomingApprover = auth.APPROVERS.includes(next.role) && !auth.APPROVERS.includes(u.role);
    if (becomingApprover && (b.pin == null || b.pin === '')) throw bad('pin_required', 'Set a 6 digit PIN when making someone a manager or owner');
    if (b.pin != null && b.pin !== '') {
      const rule = auth.pinRule(next.role);
      if (!rule.re.test(String(b.pin))) throw bad('bad_pin', rule.message);
      const { salt, hash } = hashPin(b.pin);
      run('UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ?', hash, salt, id);
      auth.logoutUser(id);
    }
    if (!next.active) auth.logoutUser(id);
    audit(c, 'user_update', id, { name: next.name, role: next.role, active: next.active, pin_changed: !!b.pin });
    return { ok: true };
  });
  r.put('/api/admin/:entity/:id', { roles: BOSS }, (c) => {
    const ent = ENT[c.params.entity];
    if (!ent) throw new HttpError(404, 'no_entity');
    const v = clean(ent, c.body, c.user), keys = Object.keys(v);
    if (!keys.length) return { ok: true };
    run(`UPDATE ${c.params.entity} SET ${keys.map((k) => k + ' = ?').join(', ')} WHERE id = ?`, ...keys.map((k) => v[k]), int(c.params.id, 'id'));
    audit(c, 'admin_update', `${c.params.entity}:${c.params.id}`, v);
    broadcast('menu'); broadcast('tables');
    return { ok: true };
  });
  r.post('/api/system/reset', { roles: OWNER }, async (c) => {
    auth.requireOwnerPin(c, c.body.pin);
    if (orders.currentDay()) throw conflict('day_open', 'Close the business day before wiping test data');
    const backup = await runBackup('before-reset');
    tx(() => {
      for (const t of ['order_items', 'payments', 'batches', 'orders', 'cash_movements', 'print_jobs', 'sessions', 'business_days', 'audit_log']) run(`DELETE FROM ${t}`);
      run("DELETE FROM settings WHERE key = 'last_event_at'");
      run('UPDATE products SET available = 1');
    });
    audit(c, 'reset_test_data');
    broadcast('day'); broadcast('tables');
    return { ok: true, backup: backup.file };
  });

  // ---------- system ----------
  r.get('/api/system/info', { roles: STAFF }, (c) => {
    const day = orders.currentDay();
    const last = Number(getSetting('last_event_at', '0'));
    if (!BOSS.includes(c.user.role)) {
      return { cafe_name: getSetting('cafe_name', 'Cafe'), clock_wrong: !!last && now() < last - 5 * 60_000, day_open: !!day, catch_up: !!day?.catch_up,
        printer: { ok: printerState.ok, mode: getSetting('printer_mode', 'off'), error: printerState.ok ? null : 'problem' }, idle_lock_sec: Number(getSetting('idle_lock_sec', '60')) };
    }
    return {
      version: cfg.version, port: cfg.port, urls: lanUrls(cfg.port), cafe_name: getSetting('cafe_name', 'Cafe'), clock: now(),
      clock_wrong: !!last && now() < last - 5 * 60_000, phones_connected: clientCount(),
      printer: { ...printerState, mode: getSetting('printer_mode', 'off') },
      last_backup_at: Number(getSetting('last_backup_at', '0')) || null, last_backup_file: getSetting('last_backup_file', null),
      day_open: !!day, day_hours_open: day ? (now() - day.opened_at) / 3_600_000 : 0, catch_up: !!day?.catch_up,
      // The phones' address only stays the same if the router always gives this PC the same IP. The card's
      // MAC is what the router's "address reservation" asks for.
      nets: Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, address: a.address, mac: a.mac }))),
      idle_lock_sec: Number(getSetting('idle_lock_sec', '60')), data_dir: dataDir, fiscal_mode: getSetting('fiscal_mode', 'off'),
    };
  });
  r.get('/api/system/qr.svg', { roles: BOSS }, (c) => ({ __raw: qrSvg(c.query.url || lanUrls(cfg.port)[0] || `http://localhost:${cfg.port}`), type: 'image/svg+xml' }));
  r.post('/api/system/backup', { roles: BOSS }, async () => runBackup('manual'));
  // ---------- printers on this PC, the database and its backups ----------
  r.get('/api/system/printers', { roles: BOSS }, async () => ({ printers: await listPrinters() }));
  r.get('/api/system/db', { roles: BOSS }, () => dbInfo());
  r.get('/api/system/backups', { roles: BOSS }, () => listBackups());
  r.get('/api/system/backups/:name/summary', { roles: BOSS }, (c) => backupSummary(c.params.name));
  r.get('/api/system/backups/:name/download', { roles: OWNER }, (c) => ({ __raw: fs.readFileSync(backupFile(c.params.name)), type: 'application/octet-stream', filename: c.params.name }));
  r.post('/api/system/backups/upload', { roles: OWNER, raw: true }, (c) => { const out = saveUploaded(c.body); audit(c, 'backup_uploaded', out.name); return out; });
  r.post('/api/system/backups/:name/restore', { roles: OWNER }, async (c) => {
    auth.requireOwnerPin(c, c.body.pin);
    const out = await restoreBackup(c.params.name);
    audit(c, 'backup_restored', c.params.name, { safety: out.safety });
    broadcast('day'); broadcast('tables'); broadcast('menu');
    return out;
  });
  // The owner's floor plan for one zone: where the tables stand, and the bar, chairs, walls and labels around them.
  r.put('/api/plan/:zone', { roles: BOSS }, (c) => {
    const zone = int(c.params.zone, 'zone');
    if (!get('SELECT 1 AS x FROM zones WHERE id = ?', zone)) throw new HttpError(404, 'no_zone');
    const box = (o) => { const v = {}; for (const k of ['x', 'y', 'w', 'h']) { v[k] = int(o[k], k); if (v[k] < 0 || v[k] > 6000) throw bad('bad_value', k); } if (v.w < 10 || v.h < 10) throw bad('bad_value', 'size'); return v; };
    const KINDS = ['bar', 'chair', 'wall', 'label', 'plant', 'door'];
    tx(() => {
      for (const t of c.body.tables || []) {
        // No position means the table is taken off the plan; it stays a table and waits in the tray.
        if (t.px == null) { run('UPDATE tables SET px = NULL, py = NULL, pw = NULL, ph = NULL WHERE id = ? AND zone_id = ?', int(t.id, 'id'), zone); continue; }
        const b = box({ x: t.px, y: t.py, w: t.pw, h: t.ph });
        run("UPDATE tables SET px = ?, py = ?, pw = ?, ph = ?, shape = ? WHERE id = ? AND zone_id = ?", b.x, b.y, b.w, b.h, t.shape === 'round' ? 'round' : 'square', int(t.id, 'id'), zone);
      }
      run('DELETE FROM plan_items WHERE zone_id = ?', zone);
      for (const it of (c.body.items || []).slice(0, 400)) {
        if (!KINDS.includes(it.kind)) throw bad('bad_value', 'kind');
        const b = box(it);
        run('INSERT INTO plan_items(zone_id, kind, x, y, w, h, label) VALUES(?,?,?,?,?,?,?)', zone, it.kind, b.x, b.y, b.w, b.h, it.label ? String(it.label).slice(0, 40) : null);
      }
    });
    audit(c, 'plan_saved', zone, { tables: (c.body.tables || []).length, items: (c.body.items || []).length });
    broadcast('tables');
    return { ok: true };
  });
  // For a phone that went missing: every other device has to log in again. This screen stays in.
  r.post('/api/system/logout-all', { roles: OWNER }, (c) => {
    const n = auth.logoutEveryoneElse(c.token);
    audit(c, 'logout_all', null, { devices: n });
    return { logged_out: n };
  });
  r.post('/api/system/test-print', { roles: BOSS }, (c) => {
    const id = enqueueTicket({ day_id: orders.currentDay()?.id ?? null, user_id: c.user.id, kind: 'test', content: { cafe: getSetting('cafe_name', 'Cafe') } });
    return { job_id: id };
  });
  r.get('/api/events', { roles: STAFF }, (c) => {
    c.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    c.res.write('retry: 2000\n\nevent: hello\ndata: {}\n\n');
    addClient(c.res, c.user);
    return { __stream: true };
  });

  // Used by the desktop application before it quits: closing the POS stops every phone, so it needs a manager or owner.
  r.post('/api/system/check-boss-pin', { public: true }, (c) => {
    auth.approve({ user: { role: 'none' }, device: c.device }, String(c.body.pin ?? ''));
    return { ok: true };
  });

  if (cfg.test) r.post('/api/test/clock', { public: true }, (c) => { setClockOffset(Number(c.body.offset_ms) || 0); return { now: now() }; });
}
