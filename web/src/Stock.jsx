// Stock: what is on the shelf, deliveries, breakage, counting, the shopping list, and for managers and the
// owner also the stock items, recipes, prices and history. Stock never blocks a sale; it warns.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { get, post, put, money, toCents, dateTime, useEvents } from './api.js';
import { t } from './i18n.js';
import { Modal, useUi, Field } from './ui.jsx';
import { errText } from './util.js';

const useAct = () => { const { toast } = useUi(); return async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg); return r ?? true; } catch (e) { toast(errText(e), 'bad'); return null; } }; };
const num = (s) => Number(String(s).replace(',', '.'));
// "1.6 kg (176 shote)" on the screen, the same as on the server and the slip.
export function fmtQty(s, units = s.qty) {
  if (s.pack_size <= 1) return `${units} ${s.unit}`;
  const packs = Math.round((units / s.pack_size) * 10) / 10;
  return `${String(packs).replace(/\.0$/, '')} ${s.pack_name} (${units} ${s.unit})`;
}
const STATE = { ok: ['ok', 'Enough'], low: ['warn', 'Low'], out: ['bad', 'Out'], unknown: ['', 'Not counted yet'] };
const StatePill = ({ s }) => { const [cls, label] = STATE[s] || STATE.unknown; return <span className={'pill ' + cls}>{t(label)}</span>; };

// An amount in packs (decimals allowed: 0.6 kg) or in single units. Things counted one by one have only units.
function Amount({ item, value, onChange, autoFocus }) {
  const packs = item.pack_size > 1;
  const mode = packs ? value.mode || 'packs' : 'units';
  return (
    <div className="row">
      <input className="input auto" inputMode="decimal" autoFocus={autoFocus} value={value.n ?? ''} onChange={(e) => onChange({ ...value, mode, n: e.target.value })} placeholder="0" style={{ width: '7em' }} />
      {packs ? (
        <div className="seg" style={{ margin: 0 }}>
          <button className={mode === 'packs' ? 'on' : ''} onClick={() => onChange({ ...value, mode: 'packs' })}>{item.pack_name}</button>
          <button className={mode === 'units' ? 'on' : ''} onClick={() => onChange({ ...value, mode: 'units' })}>{item.unit}</button>
        </div>
      ) : <span>{item.unit}</span>}
    </div>
  );
}
const unitsOf = (item, v) => {
  if (v.n == null || String(v.n).trim() === '' || !Number.isFinite(num(v.n))) return null;
  return (v.mode || (item.pack_size > 1 ? 'packs' : 'units')) === 'packs' ? Math.round(num(v.n) * item.pack_size) : Math.round(num(v.n));
};
const amountBody = (item, v) => ((v.mode || (item.pack_size > 1 ? 'packs' : 'units')) === 'packs' ? { packs: String(v.n) } : { units: num(v.n) });

export function StockPage({ app, start }) {
  const boss = app.boss;
  const [d, setD] = useState(null);
  const [tab, setTab] = useState(start || 'levels');
  const load = useCallback(() => get('/api/stock').then(setD).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  useEvents({ stock: load, tables: load, menu: load, hello: load });
  if (!d) return <p className="muted">{t('Loading')}</p>;
  const tabs = [['levels', 'Stock levels'], ['count', 'Count'], ['list', 'Shopping list'], ...(boss ? [['items', 'Stock items'], ['history', 'History']] : [])];
  if (boss && !d.items.length) return <SetupWizard onDone={() => { load(); setTab('count'); }} />;
  if (!d.items.length) return <p className="notice">{t('Stock is not set up yet. A manager sets it up in Manager, Stock.')}</p>;
  return (
    <div className="stock">
      <div className="seg noprint">{tabs.map(([k, label]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t(label)}</button>)}</div>
      {tab === 'levels' && <Levels d={d} boss={boss} reload={load} />}
      {tab === 'count' && <Count d={d} reload={load} onDone={() => setTab('levels')} />}
      {tab === 'list' && <Shopping />}
      {tab === 'items' && boss && <Items d={d} reload={load} />}
      {tab === 'history' && boss && <History d={d} />}
    </div>
  );
}

// ---------------------------------------------------------------- levels, deliveries, breakage
function Levels({ d, boss, reload }) {
  const [dlg, setDlg] = useState(null);
  const notCounted = d.items.filter((i) => i.active && i.live_state === 'unknown').length;
  return (
    <>
      {notCounted > 0 && <p className="notice warn">{t('Some items were never counted. Do the opening count so the warnings know what is on the shelf.')}</p>}
      <table className="grid">
        <thead><tr><th>{t('Item')}</th><th className="r">{t('On the shelf')}</th><th>{t('State')}</th><th className="r">{t('Warn at')}</th>{boss && <th className="r">{t('Value')}</th>}<th /></tr></thead>
        <tbody>{d.items.filter((i) => i.active).map((i) => (
          <tr key={i.id}>
            <td><b>{i.name}</b></td>
            <td className={'r' + (i.qty < 0 ? ' neg' : '')}>{i.text}</td>
            <td><StatePill s={i.live_state} /></td>
            <td className="r"><small>{i.low_level ? fmtQty(i, i.low_level) : ''}</small></td>
            {boss && <td className="r">{i.value_cents == null ? <small>{t('no price')}</small> : money(i.value_cents)}</td>}
            <td className="r"><div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn primary" onClick={() => setDlg({ kind: 'delivery', item: i, v: {}, price: '', note: '' })}>+ {t('Delivery')}</button>
              <button className="btn" onClick={() => setDlg({ kind: 'waste', item: i, v: {}, reason: '' })}>{t('Waste')}</button>
            </div></td>
          </tr>
        ))}</tbody>
      </table>
      {dlg?.kind === 'delivery' && <Delivery dlg={dlg} setDlg={setDlg} boss={boss} reload={reload} />}
      {dlg?.kind === 'waste' && <Waste dlg={dlg} setDlg={setDlg} reload={reload} />}
    </>
  );
}

function Delivery({ dlg, setDlg, boss, reload }) {
  const act = useAct();
  const units = unitsOf(dlg.item, dlg.v);
  const priceOk = dlg.price === '' || Number.isFinite(toCents(dlg.price));
  return (
    <Modal title={`${t('Delivery')}: ${dlg.item.name}`} onClose={() => setDlg(null)}>
      <Field label={t('How much came in')}><Amount item={dlg.item} value={dlg.v} onChange={(v) => setDlg({ ...dlg, v })} autoFocus /></Field>
      {units > 0 && <p className="muted">= {fmtQty(dlg.item, units)}. {t('After')}: {fmtQty(dlg.item, dlg.item.qty + units)}</p>}
      {boss && <Field label={t('Paid for all of it, euro (optional)')}><input className="input" inputMode="decimal" value={dlg.price} onChange={(e) => setDlg({ ...dlg, price: e.target.value })} placeholder="0.00" /></Field>}
      <Field label={t('Note (supplier, invoice)')}><input className="input" value={dlg.note} onChange={(e) => setDlg({ ...dlg, note: e.target.value })} /></Field>
      <button className="btn primary big" disabled={!(units > 0) || !priceOk} onClick={async () => {
        const body = { stock_item_id: dlg.item.id, ...amountBody(dlg.item, dlg.v), note: dlg.note, ...(boss && dlg.price !== '' ? { total_cents: toCents(dlg.price) } : {}) };
        if (await act(() => post('/api/stock/deliveries', body), t('Delivery recorded'))) { setDlg(null); reload(); }
      }}>{t('Save')}</button>
    </Modal>
  );
}

function Waste({ dlg, setDlg, reload }) {
  const act = useAct();
  const units = unitsOf(dlg.item, dlg.v);
  return (
    <Modal title={`${t('Waste')}: ${dlg.item.name}`} onClose={() => setDlg(null)}>
      <Field label={t('How much was thrown away')}><Amount item={dlg.item} value={dlg.v} onChange={(v) => setDlg({ ...dlg, v })} autoFocus /></Field>
      {units > 0 && <p className="muted">= {fmtQty(dlg.item, units)}</p>}
      <div className="row wrap">{['broken', 'spilled', 'expired', 'staff drink'].map((r) => <button key={r} className={'btn' + (dlg.reason === t(r) ? ' primary' : '')} onClick={() => setDlg({ ...dlg, reason: t(r) })}>{t(r)}</button>)}</div>
      <Field label={t('Reason')}><input className="input" value={dlg.reason} onChange={(e) => setDlg({ ...dlg, reason: e.target.value })} /></Field>
      <button className="btn danger big" disabled={!(units > 0) || !dlg.reason.trim()} onClick={async () => {
        if (await act(() => post('/api/stock/waste', { stock_item_id: dlg.item.id, ...amountBody(dlg.item, dlg.v), reason: dlg.reason }), t('Saved'))) { setDlg(null); reload(); }
      }}>{t('Save')}</button>
    </Modal>
  );
}

// ---------------------------------------------------------------- the stock take
// What the screen showed when the form opened is sent along, so sales made while counting are not lost.
function Count({ d, reload, onDone }) {
  const act = useAct();
  const items = d.items.filter((i) => i.active);
  const [seen] = useState(() => Object.fromEntries(items.map((i) => [i.id, i.qty])));
  const [v, setV] = useState({});
  const [reason, setReason] = useState('');
  const rows = items.map((i) => { const u = unitsOf(i, v[i.id] || {}); return { i, u, diff: u == null ? null : u - (seen[i.id] ?? i.qty) }; });
  const filled = rows.filter((r) => r.u != null);
  const big = filled.some((r) => r.i.live_state !== 'unknown' && Math.abs(r.diff) > Math.max(2, r.i.pack_size * 0.1));
  return (
    <>
      <p className="muted">{t('Count what is on the shelf now. Leave an item empty to skip it.')}</p>
      <table className="grid">
        <thead><tr><th>{t('Item')}</th><th className="r">{t('Expected')}</th><th>{t('Counted')}</th><th className="r">{t('Difference')}</th></tr></thead>
        <tbody>{rows.map(({ i, u, diff }) => (
          <tr key={i.id}><td><b>{i.name}</b>{i.live_state === 'unknown' && <small> · {t('opening count')}</small>}</td>
            <td className="r">{i.live_state === 'unknown' ? '' : fmtQty(i, seen[i.id])}</td>
            <td><Amount item={i} value={v[i.id] || {}} onChange={(x) => setV({ ...v, [i.id]: x })} /></td>
            <td className={'r' + (diff < 0 ? ' neg' : '')}>{u == null || i.live_state === 'unknown' ? '' : (diff > 0 ? '+' : '') + diff + ' ' + i.unit}</td></tr>
        ))}</tbody>
      </table>
      {big && <Field label={t('Big difference. What happened?')}><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
      <div className="row"><button className="btn primary big" disabled={!filled.length || (big && !reason.trim())} onClick={async () => {
        const entries = filled.map(({ i }) => ({ stock_item_id: i.id, seen_qty: seen[i.id], reason: reason || undefined, ...amountBody(i, v[i.id]) }));
        if (await act(() => post('/api/stock/counts', { entries }), t('Count saved'))) { reload(); onDone(); }
      }}>{t('Save the count')} ({filled.length})</button></div>
    </>
  );
}

function Shopping() {
  const [list, setList] = useState(null);
  const act = useAct();
  const load = useCallback(() => get('/api/stock/shopping-list').then(setList).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  useEvents({ stock: load });
  if (!list) return <p className="muted">{t('Loading')}</p>;
  return (
    <>
      {!list.length ? <p className="notice">{t('Nothing to buy. Everything is above its warning level.')}</p> : (
        <table className="grid"><thead><tr><th>{t('Buy')}</th><th>{t('Item')}</th><th className="r">{t('On the shelf')}</th></tr></thead>
          <tbody>{list.map((l) => <tr key={l.stock_item_id}><td><b>{l.buy_text}</b></td><td>{l.name}</td><td className="r">{l.text}</td></tr>)}</tbody></table>
      )}
      <div className="row"><button className="btn" disabled={!list.length} onClick={() => act(() => post('/api/stock/shopping-list/print'), t('Ticket sent to the printer'))}>{t('Print')}</button></div>
    </>
  );
}

// ---------------------------------------------------------------- stock items (manager, owner)
function Items({ d, reload }) {
  const act = useAct();
  const [dlg, setDlg] = useState(null);
  const usedBy = (id) => d.recipes.filter((r) => r.stock_item_id === id).map((r) => `${r.product_name || r.modifier_name} ${r.amount}`).join(', ');
  const save = async () => {
    const body = { name: dlg.name, unit: dlg.unit, pack_name: dlg.pack_name, pack_size: Number(dlg.pack_size), low_level: Number(dlg.low_level || 0), full_level: Number(dlg.full_level || 0), active: !!dlg.active };
    if (await act(() => (dlg.id ? put('/api/stock/items/' + dlg.id, body) : post('/api/stock/items', body)), t('Saved'))) { setDlg(null); reload(); }
  };
  const fresh = { name: '', unit: 'copë', pack_name: 'arkë', pack_size: 24, low_level: 0, full_level: 0, active: 1 };
  return (
    <>
      <table className="grid">
        <thead><tr><th>{t('Item')}</th><th>{t('Bought as')}</th><th className="r">{t('Warn at')}</th><th className="r">{t('Full at')}</th><th className="r">{t('Average price')}</th><th>{t('Used by')}</th><th /></tr></thead>
        <tbody>{d.items.map((i) => (
          <tr key={i.id} className={i.active ? '' : 'dim'}>
            <td><b>{i.name}</b></td>
            <td>{i.pack_size > 1 ? `1 ${i.pack_name} = ${i.pack_size} ${i.unit}` : i.unit}</td>
            <td className="r">{i.low_level ? fmtQty(i, i.low_level) : ''}</td><td className="r">{i.full_level ? fmtQty(i, i.full_level) : ''}</td>
            <td className="r">{i.avg_cost_cents_per_pack == null ? '' : `${money(i.avg_cost_cents_per_pack)} / ${i.pack_size > 1 ? i.pack_name : i.unit}`}</td>
            <td><small>{usedBy(i.id) || t('Not used by any product')}</small></td>
            <td className="r"><button className="btn" onClick={() => setDlg({ ...i })}>✎</button></td>
          </tr>
        ))}</tbody>
      </table>
      <div className="row"><button className="btn primary" onClick={() => setDlg(fresh)}>{t('Add stock item')}</button></div>
      <p className="muted">{t('Which products use an item, and how much, is set per product in Manager, Menu.')}</p>
      {dlg && (
        <Modal title={dlg.id ? dlg.name : t('Add stock item')} onClose={() => setDlg(null)}>
          <Field label={t('Name')}><input className="input" autoFocus value={dlg.name} onChange={(e) => setDlg({ ...dlg, name: e.target.value })} /></Field>
          <div className="row">
            <Field label={t('Counted in (one serving)')}><input className="input" value={dlg.unit} onChange={(e) => setDlg({ ...dlg, unit: e.target.value })} placeholder="shote" /></Field>
            <Field label={t('Bought as')}><input className="input" value={dlg.pack_name} onChange={(e) => setDlg({ ...dlg, pack_name: e.target.value })} placeholder="kg" /></Field>
            <Field label={t('How many in one')}><input className="input" inputMode="numeric" value={dlg.pack_size} onChange={(e) => setDlg({ ...dlg, pack_size: e.target.value.replace(/\D/g, '') })} /></Field>
          </div>
          <p className="muted">{t('Example: coffee is counted in shots and bought by the kg, 1 kg = 110 shots. Tea: filters, a box of 20.')}</p>
          <div className="row">
            <Field label={`${t('Warn at')} (${dlg.unit})`}><input className="input" inputMode="numeric" value={dlg.low_level} onChange={(e) => setDlg({ ...dlg, low_level: e.target.value.replace(/\D/g, '') })} /></Field>
            <Field label={`${t('Full at')} (${dlg.unit})`}><input className="input" inputMode="numeric" value={dlg.full_level} onChange={(e) => setDlg({ ...dlg, full_level: e.target.value.replace(/\D/g, '') })} /></Field>
          </div>
          {dlg.id && dlg.pack_size != null && Number(dlg.pack_size) !== d.items.find((x) => x.id === dlg.id)?.pack_size && <p className="notice warn">{t('The count on the shelf stays the same in single units. Only new deliveries and the display change.')}</p>}
          {dlg.id && <label className="row"><input type="checkbox" checked={!!dlg.active} onChange={(e) => setDlg({ ...dlg, active: e.target.checked ? 1 : 0 })} /> {t('Active')}</label>}
          <button className="btn primary big" disabled={!dlg.name.trim() || !dlg.unit.trim() || !dlg.pack_name.trim() || !(Number(dlg.pack_size) >= 1)} onClick={save}>{t('Save')}</button>
        </Modal>
      )}
    </>
  );
}

function History({ d }) {
  const [item, setItem] = useState('');
  const [kind, setKind] = useState('');
  const [rows, setRows] = useState(null);
  const act = useAct();
  const load = useCallback(() => get(`/api/stock/moves?limit=400${item ? '&item=' + item : ''}${kind ? '&kind=' + kind : ''}`).then(setRows).catch(() => {}), [item, kind]);
  useEffect(() => { load(); }, [load]);
  const KINDS = ['open', 'delivery', 'sale', 'return', 'waste', 'count', 'correction'];
  return (
    <>
      <div className="row wrap noprint">
        <select className="input auto" value={item} onChange={(e) => setItem(e.target.value)}><option value="">{t('All items')}</option>{d.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
        <select className="input auto" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">{t('Everything')}</option>{KINDS.map((k) => <option key={k} value={k}>{t('move_' + k)}</option>)}</select>
      </div>
      {!rows ? <p className="muted">{t('Loading')}</p> : (
        <table className="grid"><thead><tr><th>{t('Time')}</th><th>{t('Item')}</th><th>{t('What')}</th><th className="r">{t('Change')}</th><th className="r">{t('After')}</th><th>{t('Who')}</th><th>{t('Detail')}</th><th /></tr></thead>
          <tbody>{rows.map((m) => (
            <tr key={m.id} className={m.corrected ? 'dim' : ''}>
              <td><small>{dateTime(m.at)}</small></td><td>{m.item_name}</td><td>{t('move_' + m.kind)}</td>
              <td className={'r' + (m.delta < 0 ? ' neg' : '')}>{(m.delta > 0 ? '+' : '') + m.delta} {m.unit}</td><td className="r">{m.qty_after}</td>
              <td>{m.user_name || ''}</td>
              <td><small>{[m.reason, m.note, m.cost_cents != null ? money(m.cost_cents) : null, m.corrected ? t('corrected') : null].filter(Boolean).join(' · ')}</small></td>
              <td className="r">{['delivery', 'waste', 'count', 'open'].includes(m.kind) && !m.corrected && <button className="btn" onClick={async () => { if (window.confirm(t('Undo this entry? A correction row is added, nothing is deleted.')) && await act(() => post(`/api/stock/moves/${m.id}/correct`), t('Saved'))) load(); }}>{t('Undo')}</button>}</td>
            </tr>
          ))}</tbody></table>
      )}
    </>
  );
}

// ---------------------------------------------------------------- first setup
function SetupWizard({ onDone }) {
  const act = useAct();
  const [p, setP] = useState(null);
  const [skip, setSkip] = useState({});
  useEffect(() => { get('/api/stock/setup').then((x) => setP(x.items)).catch(() => setP([])); }, []);
  if (!p) return <p className="muted">{t('Loading')}</p>;
  const edit = (k, patch) => setP(p.map((x) => (x.key === k ? { ...x, ...patch } : x)));
  const editUse = (k, list, idx, amount) => setP(p.map((x) => (x.key === k ? { ...x, [list]: x[list].map((u, j) => (j === idx ? { ...u, amount } : u)) } : x)));
  const chosen = p.filter((x) => !skip[x.key]);
  return (
    <div className="narrow wide-ok">
      <h1>{t('Set up stock')}</h1>
      <p className="muted">{t('Here is a starting point from your menu. Untick what you do not want to track and change any number. Everything can be changed later.')}</p>
      {p.map((x) => (
        <section key={x.key} className={'card' + (skip[x.key] ? ' dim' : '')} style={{ marginBottom: 10 }}>
          <label className="row"><input type="checkbox" checked={!skip[x.key]} onChange={(e) => setSkip({ ...skip, [x.key]: !e.target.checked })} /> <b>{x.name}</b></label>
          {!skip[x.key] && (
            <>
              <div className="row wrap">
                <span>1</span><input className="input auto" style={{ width: '5em' }} value={x.pack_name} onChange={(e) => edit(x.key, { pack_name: e.target.value })} />
                <span>=</span><input className="input auto" style={{ width: '5em' }} inputMode="numeric" value={x.pack_size} onChange={(e) => edit(x.key, { pack_size: Number(e.target.value.replace(/\D/g, '')) || 1 })} />
                <input className="input auto" style={{ width: '6em' }} value={x.unit} onChange={(e) => edit(x.key, { unit: e.target.value })} />
                <span className="muted">· {t('Warn at')}</span><input className="input auto" style={{ width: '5em' }} inputMode="numeric" value={x.low_level} onChange={(e) => edit(x.key, { low_level: Number(e.target.value.replace(/\D/g, '')) || 0 })} /><span>{x.unit}</span>
              </div>
              {(x.uses.length > 1 || x.extras.length > 0 || x.uses[0]?.amount !== 1) && (
                <div className="row wrap">{[...x.uses.map((u, j) => ['uses', u, j]), ...x.extras.map((u, j) => ['extras', u, j])].map(([list, u, j]) => (
                  <span key={list + j} className="tchip">{u.name} <input className="inline r" style={{ width: '3em' }} inputMode="numeric" value={u.amount} onChange={(e) => editUse(x.key, list, j, Number(e.target.value.replace(/\D/g, '')) || 1)} /> {x.unit}</span>
                ))}</div>
              )}
            </>
          )}
        </section>
      ))}
      <button className="btn primary big" disabled={!chosen.length} onClick={async () => { if (await act(() => post('/api/stock/setup', { items: chosen }), t('Saved'))) onDone(); }}>{t('Create')} ({chosen.length}) · {t('then count the shelf')}</button>
    </div>
  );
}

// ---------------------------------------------------------------- recipes, used from Manager, Menu
export function useStockData(enabled = true) {
  const [d, setD] = useState(null);
  const load = useCallback(() => (enabled ? get('/api/stock').then(setD).catch(() => {}) : null), [enabled]);
  useEffect(() => { load(); }, [load]);
  return [d, load];
}
export function RecipeCell({ stock, owner, id, onEdit }) {
  if (!stock) return null;
  const col = owner === 'product' ? 'product_id' : 'modifier_id';
  const lines = stock.recipes.filter((r) => r[col] === id);
  const name = (sid) => stock.items.find((i) => i.id === sid);
  return (
    <button className="btn ghost" onClick={onEdit} title={t('Stock use')}>
      {lines.length ? lines.map((l) => { const i = name(l.stock_item_id); return `${l.amount} ${i?.unit || ''} ${i?.name || ''}`; }).join(' + ') : <small className="muted">{t('Not tracked')}</small>}
    </button>
  );
}
export function RecipeEditor({ stock, owner, target, onClose, onSaved }) {
  const act = useAct();
  const col = owner === 'product' ? 'product_id' : 'modifier_id';
  const [lines, setLines] = useState(() => stock.recipes.filter((r) => r[col] === target.id).map((r) => ({ stock_item_id: r.stock_item_id, amount: r.amount })));
  const items = stock.items.filter((i) => i.active);
  return (
    <Modal title={`${t('Stock use')}: ${target.name}`} onClose={onClose}>
      <p className="muted">{t(owner === 'product' ? 'What one of these uses from stock.' : 'What this extra adds on top of the product.')}</p>
      {lines.map((l, i) => (
        <div key={i} className="row">
          <input className="input auto" style={{ width: '5em' }} inputMode="numeric" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value.replace(/\D/g, '')) || '' } : x)))} />
          <select className="input" value={l.stock_item_id} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, stock_item_id: Number(e.target.value) } : x)))}>
            {items.map((s) => <option key={s.id} value={s.id}>{s.unit} {s.name}</option>)}
          </select>
          <button className="btn" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      {items.length > 0 && <button className="btn" onClick={() => setLines([...lines, { stock_item_id: items[0].id, amount: 1 }])}>+ {t('Add a stock item')}</button>}
      {!items.length && <p className="notice">{t('Set up stock first, in Manager, Stock.')}</p>}
      <button className="btn primary big" disabled={lines.some((l) => !(l.amount >= 1)) || new Set(lines.map((l) => l.stock_item_id)).size !== lines.length} onClick={async () => {
        if (await act(() => put(`/api/stock/recipes/${owner}/${target.id}`, { lines }), t('Saved'))) onSaved();
      }}>{t('Save')}</button>
    </Modal>
  );
}

// ---------------------------------------------------------------- the banner under the top bar
// Bartenders, managers and the owner see what is low until someone has seen it or it is restocked.
export function StockBanner({ app, onOpen }) {
  const shelf = ['bartender', 'manager', 'owner'].includes(app.user.role);
  const [alerts, setAlerts] = useState([]);
  const { toast } = useUi();
  const load = useCallback(() => { if (shelf) get('/api/stock/alerts').then(setAlerts).catch(() => {}); }, [shelf]);
  useEffect(() => { load(); }, [load]);
  useEvents({
    hello: load,
    stock: (e) => {
      load();
      // Whoever sent the order that crossed the line hears about it at once, waiters too.
      if (e?.by === app.user.id && e.alerts?.length) {
        const tell = ['waiter', 'bartender'].includes(app.user.role) ? ' ' + t('Tell the manager.') : '';
        toast(e.alerts.map((a) => `${a.name}: ${a.text}`).join(' · ') + '.' + tell, e.alerts.some((a) => a.level === 'out') ? 'bad' : 'ok', 6000);
      }
    },
  });
  const unseen = useMemo(() => alerts.filter((a) => !a.seen), [alerts]);
  if (!shelf || !unseen.length) return null;
  const out = unseen.filter((a) => a.level === 'out'), low = unseen.filter((a) => a.level === 'low' && !out.some((o) => o.stock_item_id === a.stock_item_id));
  const seeAll = async () => { for (const a of unseen) await post(`/api/stock/alerts/${a.id}/seen`).catch(() => {}); load(); };
  return (
    <div className={'banner stockbar ' + (out.length ? 'bad' : 'warn')}>
      <span>{out.length > 0 && <>{t('Out of stock')}: {out.map((a) => `${a.name} ${a.text}`).join(', ')}. </>}
        {low.length > 0 && <>{t('Low stock')}: {low.map((a) => `${a.name} ${a.text}`).join(', ')}</>}</span>
      <span className="row"><button className="chip" onClick={onOpen}>{t('Stock')} ›</button><button className="chip" onClick={seeAll}>{t('Seen')}</button></span>
    </div>
  );
}

// ---------------------------------------------------------------- in the reports
const Money = ({ c }) => <span className={'num' + (c < 0 ? ' neg' : '')}>{money(c)}</span>;
// What the tracked products earned after their stock cost, and what was lost on the way.
export function StockSection({ s }) {
  if (!s || (!s.products.length && !s.items.length)) return null;
  const x = s.totals;
  return (
    <>
      <h2>{t('Stock and profit')}</h2>
      <div className="stats">
        <div className="bignum"><span>{t('Cost of goods')}</span><b>{money(x.cost_cents)}</b></div>
        <div className="bignum"><span>{t('Gross profit')}</span><b className={x.profit_cents < 0 ? 'neg' : ''}>{money(x.profit_cents)}</b></div>
        <div className="bignum"><span>{t('On the house cost')}</span><b>{money(x.house_cost_cents)}</b></div>
        <div className="bignum"><span>{t('Waste')}</span><b>{money(x.waste_cents)}</b></div>
        <div className="bignum"><span>{t('Count differences')}</span><b className={x.count_diff_cents < 0 ? 'neg' : ''}>{money(x.count_diff_cents)}</b></div>
      </div>
      {x.no_cost_qty > 0 && <p className="notice warn">{x.no_cost_qty} {t('sold before any delivery had a price, so their cost is unknown.')}</p>}
      {s.products.length > 0 && <table className="grid"><thead><tr><th>{t('Product')}</th><th className="r">{t('Qty')}</th><th className="r">{t('Sales')}</th><th className="r">{t('Cost')}</th><th className="r">{t('Profit')}</th><th className="r">{t('On the house')}</th></tr></thead>
        <tbody>{s.products.map((p) => <tr key={p.name}><td>{p.name}</td><td className="r">{p.qty}</td><td className="r"><Money c={p.sales_cents} /></td><td className="r"><Money c={p.cost_cents} /></td><td className="r"><Money c={p.profit_cents} /></td><td className="r">{p.house_qty || ''}</td></tr>)}</tbody></table>}
      {s.items.length > 0 && <><h2>{t('Stock used')}</h2><table className="grid"><thead><tr><th>{t('Item')}</th><th className="r">{t('Used')}</th><th className="r">{t('Delivered')}</th><th className="r">{t('Waste')}</th><th className="r">{t('Count differences')}</th></tr></thead>
        <tbody>{s.items.map((i) => <tr key={i.id}><td>{i.name}</td><td className="r">{i.used} {i.unit}</td><td className="r">{i.delivered || ''}</td><td className="r">{i.wasted || ''}</td><td className={'r' + (i.counted_diff < 0 ? ' neg' : '')}>{i.counted_diff || ''}</td></tr>)}</tbody></table></>}
    </>
  );
}
