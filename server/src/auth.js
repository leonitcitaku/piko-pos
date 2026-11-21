import crypto from 'node:crypto';
import { get, all, run, checkPin, hashPin } from './db.js';
import { HttpError, bad } from './http.js';
import { now } from './clock.js';

const MAX_TRIES = 5, LOCK_MS = 60_000;
export const APPROVERS = ['manager', 'owner'];

export function assertNotLocked(device) {
  const a = get('SELECT * FROM pin_attempts WHERE device = ?', device);
  if (a && a.locked_until > now()) {
    throw new HttpError(429, 'locked', 'Too many wrong PINs', { retry_in_sec: Math.ceil((a.locked_until - now()) / 1000) });
  }
}
function wrongPin(device) {
  const a = get('SELECT * FROM pin_attempts WHERE device = ?', device);
  const count = (a && a.locked_until <= now() && a.count >= MAX_TRIES ? 0 : (a?.count || 0)) + 1;
  const locked = count >= MAX_TRIES ? now() + LOCK_MS : 0;
  run('INSERT INTO pin_attempts(device, count, locked_until) VALUES(?,?,?) ON CONFLICT(device) DO UPDATE SET count = excluded.count, locked_until = excluded.locked_until',
    device, count, locked);
  throw new HttpError(401, 'wrong_pin', 'Wrong PIN', { tries_left: Math.max(0, MAX_TRIES - count) });
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
  const row = get('SELECT u.* FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ? AND u.active = 1', token);
  if (!row) return null;
  run('UPDATE auth_tokens SET last_seen = ? WHERE token = ?', now(), token);
  return publicUser(row);
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
  if (!/^\d{4,6}$/.test(String(pin))) throw bad('bad_pin', 'PIN must be 4 to 6 digits');
  const { salt, hash } = hashPin(pin);
  const r = run('INSERT INTO users(name, pin_hash, pin_salt, role, language) VALUES(?,?,?,?,?)', String(name).trim(), hash, salt, role, language);
  return Number(r.lastInsertRowid);
}
