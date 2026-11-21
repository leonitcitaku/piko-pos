import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { start } from '../src/index.js';

export const uid = () => crypto.randomUUID();
export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pos-test-'));

export async function boot(dataDir) {
  const app = await start({ dataDir, port: 0, test: true, queueIntervalMs: 150, noStartupBackup: true });
  return { app, base: `http://127.0.0.1:${app.port}` };
}

// One client per "device", with its own cookie.
export function client(base) {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  return { get: (u) => call('GET', u), post: (u, b) => call('POST', u, b || {}), put: (u, b) => call('PUT', u, b || {}), setCookie: (c) => { cookie = c; }, cookie: () => cookie };
}

// A fake network printer that records what it receives and can be switched off.
export async function fakePrinter() {
  const received = [];
  let server = null, port = 0;
  const on = () => new Promise((resolve) => {
    server = net.createServer((sock) => { const chunks = []; sock.on('data', (d) => chunks.push(d)); sock.on('end', () => received.push(Buffer.concat(chunks).toString('latin1'))); sock.on('error', () => {}); });
    server.listen(port, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
  const off = () => new Promise((resolve) => server.close(() => { server = null; resolve(); }));
  await on();
  return { received, on, off, get port() { return port; } };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting'); await sleep(50); }
}
