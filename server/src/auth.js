import crypto from 'node:crypto';
import { get, all, run, checkPin, hashPin } from './db.js';
import { HttpError, bad } from './http.js';
import { now } from './clock.js';

const MAX_TRIES = 5;
// Each further round of wrong PINs locks the device for longer, so guessing a PIN
// stops being a matter of waiting. An hour after the last lock ends, the slate is wiped.
const LOCK_STEPS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const FORGET_MS = 60 * 60_000;
// A phone left logged in forever is a key that never expires. Unused for this long, it stops working.
const TOKEN_IDLE_MS = 14 * 24 * 60 * 60_000;
export const APPROVERS = ['manager', 'owner'];
// Managers and owners approve voids, free drinks and discounts, so their PIN is worth guessing.
export const pinRule = (role) => (APPROVERS.includes(role)
  ? { re: /^\d{6}$/,   message: 'A manager or owner PIN must be 6 digits' }
  : { re: /^\d{4,6}$/, message: 'PIN must be 4 to 6 digits' });

export function assertNotLocked(device) {
  const a = get('SELECT * FROM pin_attempts WHERE device = ?', device);
  if (a && a.locked_until > now()) {
    throw new HttpError(429, 'locked', 'Too many wrong PINs', { retry_in_sec: Math.ceil((a.locked_until - now()) / 1000) });
  }
}
function wrongPin(device) {
  const a = get('SELECT * FROM pin_attempts WHERE device = ?', device);
  const forgotten = !a || (a.last_fail > 0 && now() - a.last_fail > FORGET_MS);
  const count = (forgotten ? 0 : a.count) + 1;
  const atLimit = count % MAX_TRIES === 0;
  const round = Math.floor(count / MAX_TRIES);
  const locked = atLimit ? now() + LOCK_STEPS[Math.min(round - 1, LOCK_STEPS.length - 1)] : (forgotten ? 0 : a.locked_until);
  run(`INSERT INTO pin_attempts(device, count, locked_until, last_fail) VALUES(?,?,?,?)
       ON CONFLICT(device) DO UPDATE SET count = excluded.count, locked_until = excluded.locked_until, last_fail = excluded.last_fail`,
    device, count, locked, now());
  throw new HttpError(401, 'wrong_pin', 'Wrong PIN', { tries_left: MAX_TRIES - (count % MAX_TRIES || MAX_TRIES) });
}
const clearTries = (device) => run('DELETE FROM pin_attempts WHERE device = ?', device);

export function login(userId, pin, device) {
  assertNotLocked(device);
  const user = get('SELECT * FROM users WHERE id = ? AND active = 1', userId);
  if (!user) throw bad('no_user');
  if (!checkPin(user, pin)) wrongPin(device);
  clearTries(device);
  const token = crypto.randomBytes(24).toString('hex');
  run('INSERT INTO auth_tokens(token, user_id, device, created_at, last_seen) VALUES(?,?,?,?,?)', token, user.id, device, now(), now());
  return { token, user: publicUser(user) };
}

export const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role, language: u.language });

export function userFromToken(token) {
  if (!token) return null;
  const row = get('SELECT u.*, t.last_seen FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ? AND u.active = 1', token);
  if (!row) return null;
  if (now() - row.last_seen > TOKEN_IDLE_MS) { run('DELETE FROM auth_tokens WHERE token = ?', token); return null; }
  // Only ever forward, like the clock guard. If the PC clock jumps back a year, stamping last_seen
  // into the past would log the whole cafe out the moment someone fixed the clock.
  if (now() > row.last_seen) run('UPDATE auth_tokens SET last_seen = ? WHERE token = ?', now(), token);
  return publicUser(row);
}

// Everyone off, except the screen the owner is standing at. For a phone that went missing.
export function logoutEveryoneElse(keepToken) {
  const r = run('DELETE FROM auth_tokens WHERE token != ?', keepToken ?? '');
  return Number(r.changes || 0);
}

export const logout = (token) => run('DELETE FROM auth_tokens WHERE token = ?', token);
export const logoutUser = (userId) => run('DELETE FROM auth_tokens WHERE user_id = ?', userId);

// A manager or owner types their PIN on someone else's screen to approve an action.
export function approve(ctx, pin) {
  if (APPROVERS.includes(ctx.user.role) && (pin == null || pin === '')) return ctx.user;
  if (pin == null || pin === '') throw new HttpError(403, 'need_approval', 'Manager or owner PIN needed');
  assertNotLocked(ctx.device);
  const approvers = all("SELECT * FROM users WHERE active = 1 AND role IN ('manager','owner')");
  const hit = approvers.find((u) => checkPin(u, pin));
  if (!hit) wrongPin(ctx.device);
  clearTries(ctx.device);
  return publicUser(hit);
}

export function requireOwnerPin(ctx, pin) {
  assertNotLocked(ctx.device);
  const owners = all("SELECT * FROM users WHERE active = 1 AND role = 'owner'");
  const hit = owners.find((u) => checkPin(u, String(pin ?? '')));
  if (!hit) wrongPin(ctx.device);
  clearTries(ctx.device);
  return publicUser(hit);
}

export function createUser({ name, pin, role, language = 'sq' }) {
  if (!name || !String(name).trim()) throw bad('name_required');
  const rule = pinRule(role);
  if (!rule.re.test(String(pin))) throw bad('bad_pin', rule.message);
  const { salt, hash } = hashPin(pin);
  const r = run('INSERT INTO users(name, pin_hash, pin_salt, role, language) VALUES(?,?,?,?,?)', String(name).trim(), hash, salt, role, language);
  return Number(r.lastInsertRowid);
}
