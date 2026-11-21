// The printers installed on this PC, and the database with its backups. Manager and owner only.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { get, post, upload, money, dateTime } from './api.js';
import { t } from './i18n.js';
import { Modal, useUi } from './ui.jsx';
import { errText } from './util.js';

const size = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' kB');

// Lists every printer Windows knows about and lets the manager pick one with a tap.
export function PrinterFinder({ current, onPick }) {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useUi();
  const find = async () => {
    setBusy(true);
    try { setList((await get('/api/system/printers')).printers); } catch (e) { toast(errText(e), 'bad'); }
    setBusy(false);
  };
  useEffect(() => { find(); }, []);
  return (
    <div className="printers">
      <div className="row between"><h3>{t('Printers on this PC')}</h3><button className="btn" disabled={busy} onClick={find}>{busy ? t('Loading') : t('Refresh')}</button></div>
      {list && !list.length && <p className="muted">{t('No printer is installed on this PC.')}</p>}
      {list && list.length > 0 && (
        <ul className="printer-list">{list.map((p) => {
          const on = (current.printer_mode === 'winraw' && current.printer_name === p.name) || (current.printer_mode === 'network' && p.host && current.printer_host === p.host);
          return (
            <li key={p.name} className={on ? 'on' : ''}>
              <div><b>{p.name}</b>
                <small>{[p.driver, p.host ? p.host : p.port, p.is_default ? t('default') : '', p.shared ? t('shared') : '', p.offline ? t('offline') : ''].filter(Boolean).join(' · ')}</small></div>
              {on ? <span className="pill ok">{t('In use')}</span>
                : <button className="btn" onClick={() => onPick(p.host ? { printer_mode: 'network', printer_host: p.host, printer_port: '9100' } : { printer_mode: 'winraw', printer_name: p.name })}>{t('Use this one')}</button>}
            </li>
          );
        })}</ul>
      )}
    </div>
  );
}

// The database, every backup, a look inside one, bringing one in from a USB stick, and putting one back.
export function Backups({ owner }) {
  const ui = useUi();
  const [db, setDb] = useState(null);
  const [list, setList] = useState(null);
  const [view, setView] = useState(null);
  const file = useRef(null);
  const load = useCallback(() => { get('/api/system/db').then(setDb).catch(() => {}); get('/api/system/backups').then(setList).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (fn, ok) => { try { const r = await fn(); if (ok) ui.toast(ok); return r ?? true; } catch (e) { ui.toast(errText(e), 'bad'); return null; } };
  const look = async (name) => { const s = await act(() => get(`/api/system/backups/${encodeURIComponent(name)}/summary`)); if (s) setView({ name, s }); };
  const restore = async (name) => {
    const pin = await ui.askPin(t('Owner PIN'));
    if (!pin) return;
    const r = await act(() => post(`/api/system/backups/${encodeURIComponent(name)}/restore`, { pin }));
    if (r) { ui.toast(t('Backup put back. Log in again.'), 'ok', 5000); setView(null); setTimeout(() => location.reload(), 1200); }
  };
  const bring = async (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    const r = await act(() => upload('/api/system/backups/upload', f), t('Backup added'));
    if (r) { load(); setView({ name: r.name, s: r.summary }); }
  };
  return (
    <section className="backups">
      <h2>{t('Database and backups')}</h2>
      {db && (
        <dl className="facts">
          <div><dt>{t('Database')}</dt><dd>{db.file} · {size(db.size)}</dd></div>
          <div><dt>{t('Orders')}</dt><dd>{db.orders}</dd></div><div><dt>{t('Days')}</dt><dd>{db.days}</dd></div>
          <div><dt>{t('Backups kept')}</dt><dd>{db.backups} / {db.keep}</dd></div>
          <div><dt>{t('Backup folder')}</dt><dd>{db.backups_dir}</dd></div>
        </dl>
      )}
      <div className="row wrap">
        <button className="btn" onClick={async () => { if (await act(() => post('/api/system/backup'), t('Backup saved'))) load(); }}>{t('Back up now')}</button>
        {owner && <><button className="btn" onClick={() => file.current?.click()}>{t('Add a backup from a file')}</button>
          <input ref={file} type="file" accept=".db" hidden onChange={bring} /></>}
      </div>
      {list && !list.length && <p className="muted">{t('No backups yet.')}</p>}
      {list && list.length > 0 && (
        <div className="scroll-x"><table className="grid">
          <thead><tr><th>{t('Time')}</th><th>{t('Reason')}</th><th className="r">{t('Size')}</th><th /></tr></thead>
          <tbody>{list.map((b) => (
            <tr key={b.name}><td>{dateTime(b.at)}</td><td>{t(b.reason)}</td><td className="r">{size(b.size)}</td>
              <td className="r"><button className="btn" onClick={() => look(b.name)}>{t('Look inside')}</button></td></tr>
          ))}</tbody>
        </table></div>
      )}
      {view && (
        <Modal title={t('Backup')} onClose={() => setView(null)}>
          <p className="muted">{view.name}</p>
          <dl className="facts">
            <div><dt>{t('Cafe name')}</dt><dd>{view.s.cafe_name}</dd></div>
            <div><dt>{t('Total sales')}</dt><dd>{money(view.s.sales_cents)}</dd></div>
            <div><dt>{t('Days')}</dt><dd>{view.s.days}{view.s.open_days ? ` (${t('Still open')}: ${view.s.open_days})` : ''}</dd></div>
            <div><dt>{t('Orders')}</dt><dd>{view.s.orders}{view.s.open_orders ? ` (${t('Still open')}: ${view.s.open_orders})` : ''}</dd></div>
            <div><dt>{t('Last sale')}</dt><dd>{view.s.last_sale_at ? dateTime(view.s.last_sale_at) : '–'}</dd></div>
            <div><dt>{t('Staff')}</dt><dd>{view.s.staff.map((u) => u.name).join(', ')}</dd></div>
          </dl>
          {owner && (
            <div className="stack">
              <a className="btn" href={`/api/system/backups/${encodeURIComponent(view.name)}/download`}>{t('Download')}</a>
              <p className="notice warn">{t('Putting a backup back replaces everything recorded since it was made. Today\'s data is backed up first.')}</p>
              <button className="btn danger big" onClick={() => restore(view.name)}>{t('Put this backup back')}</button>
            </div>
          )}
        </Modal>
      )}
    </section>
  );
}

// A card to print and stand on the bar: the cafe's name, a big QR code and the address under it.
// Printed on its own; the rest of the screen is hidden while printing.
export function QrPrint({ url, cafe }) {
  const [on, setOn] = useState(false);
  const img = useRef(null);
  useEffect(() => {
    if (!on) return undefined;
    document.body.classList.add('print-qr');
    const done = () => { document.body.classList.remove('print-qr'); setOn(false); };
    window.addEventListener('afterprint', done);
    const go = () => setTimeout(() => window.print(), 50);
    if (img.current?.complete) go(); else img.current?.addEventListener('load', go, { once: true });
    return () => { window.removeEventListener('afterprint', done); document.body.classList.remove('print-qr'); };
  }, [on]);
  return (
    <>
      <button className="btn" onClick={() => setOn(true)}>{t('Print the QR code')}</button>
      {on && createPortal(
        <div className="qr-print">
          <h1>{cafe}</h1>
          <p>{t('Scan to open the POS on your phone')}</p>
          <img ref={img} src={'/api/system/qr.svg?url=' + encodeURIComponent(url)} alt="QR" />
          <strong>{url}</strong>
          <small>{t('Connect to the cafe Wi-Fi first.')}</small>
        </div>, document.body)}
    </>
  );
}
