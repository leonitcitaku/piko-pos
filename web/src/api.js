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
  if (!res.ok) throw new ApiError(res.status, data);
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

// Live updates. Reconnects by itself; on every reconnect the screen reloads its data so nothing is missed.
export function useEvents(handlers, enabled = true) {
  const ref = useRef(handlers); ref.current = handlers;
  useEffect(() => {
    if (!enabled) return undefined;
    const es = new EventSource('/api/events');
    const on = (type) => (e) => { let d = {}; try { d = JSON.parse(e.data); } catch { /* ignore */ } ref.current[type]?.(d); ref.current.any?.(type, d); };
    for (const type of ['hello', 'tables', 'menu', 'day', 'printer', 'tickets', 'ticket_failed']) es.addEventListener(type, on(type));
    es.onerror = () => ref.current.offline?.();
    return () => es.close();
  }, [enabled]);
}
