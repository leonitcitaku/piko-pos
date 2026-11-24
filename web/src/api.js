import { useEffect, useRef } from 'react';

export class ApiError extends Error {
  constructor(status, data) { super(data?.message || data?.error || 'error'); this.status = status; this.code = data?.error || 'error'; this.data = data || {}; }
}
export class NetworkError extends Error {}

export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  } catch { throw new NetworkError('offline'); }
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    // The login ran out or was ended from another screen: go back to the name list instead of showing a broken page.
    if (res.status === 401 && data?.error === 'not_logged_in') window.dispatchEvent(new Event('pos-logged-out'));
    throw new ApiError(res.status, data);
  }
  return data;
}
export const get = (u) => api('GET', u);
export const post = (u, b) => api('POST', u, b || {});
export const put = (u, b) => api('PUT', u, b || {});

// crypto.randomUUID is not available on plain http, which is what phones use on the Wi-Fi. getRandomValues is.
export function uid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const money = (cents) => ((cents || 0) / 100).toFixed(2) + ' €';
export const toCents = (text) => { const n = Number(String(text).replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
export const clock = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
export const dateTime = (ms) => { if (!ms) return ''; const d = new Date(ms); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${clock(ms)}`; };

// Live updates. One connection for the whole app, however many parts of the screen are listening.
// It reconnects by itself; on every reconnect the screens reload their data so nothing is missed.
const TYPES = ['hello', 'tables', 'menu', 'day', 'printer', 'tickets', 'ticket_failed', 'stock'];
const listeners = new Set();
let source = null;
function connect() {
  source = new EventSource('/api/events');
  for (const type of TYPES) {
    source.addEventListener(type, (e) => {
      let d = {}; try { d = JSON.parse(e.data); } catch { /* ignore */ }
      for (const l of listeners) { l.current[type]?.(d); l.current.any?.(type, d); }
    });
  }
  source.onerror = () => {
    for (const l of listeners) l.current.offline?.();
    if (source && source.readyState === 2) source = null;          // refused for good (logged out): start fresh next time
  };
}
export function useEvents(handlers, enabled = true) {
  const ref = useRef(handlers); ref.current = handlers;
  useEffect(() => {
    if (!enabled) return undefined;
    listeners.add(ref);
    if (!source) connect();
    return () => { listeners.delete(ref); if (!listeners.size && source) { source.close(); source = null; } };
  }, [enabled]);
}

// Send a file as the request body (a backup brought on a USB stick).
export async function upload(url, file) {
  let res;
  try { res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, credentials: 'same-origin' }); }
  catch { throw new NetworkError('offline'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
