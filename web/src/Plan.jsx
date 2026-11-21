// The floor as the owner drew it: tables where they really stand, with the bar, chairs, walls and labels
// around them. Staff tap a table exactly as on the grid; a manager or owner can switch to drawing.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { post, put, money } from './api.js';
import { t } from './i18n.js';
import { useUi, useKeys, typingIn, modalsOpen } from './ui.jsx';
import { errText } from './util.js';

const SNAP = 10;
const snap = (n) => Math.max(0, Math.round(n / SNAP) * SNAP);
const NEW = { bar: [300, 70], chair: [36, 36], wall: [300, 14], label: [150, 40], plant: [44, 44], door: [80, 14] };
const KIND_NAME = { bar: 'Bar', chair: 'Chair', wall: 'Wall', label: 'Text', plant: 'Plant', door: 'Door' };

// Tables that were never placed line up in rows, so a new plan starts tidy instead of in a heap.
const autoPlace = (i) => ({ px: 20 + (i % 4) * 130, py: 20 + Math.floor(i / 4) * 130, pw: 110, ph: 110 });

export function PlanView({ app, data, zone, sel, onSelect, reload, onDrawing }) {
  const ui = useUi();
  const [edit, setEdit] = useState(false);
  useEffect(() => { onDrawing?.(edit); return () => onDrawing?.(false); }, [edit]);
  const [pos, setPos] = useState({});          // table id -> { px, py, pw, ph, shape } while drawing
  const [items, setItems] = useState([]);      // decorations while drawing
  const [picked, setPicked] = useState(null);  // 't:12' or 'i:key'
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const drag = useRef(null);
  const nextKey = useRef(1);

  const tables = useMemo(() => data.tables.filter((x) => x.zone_id === zone), [data, zone]);
  const saved = useMemo(() => (data.plan || []).filter((x) => x.zone_id === zone), [data, zone]);
  const placed = tables.map((tb, i) => {
    const base = tb.px == null ? { ...autoPlace(i), shape: tb.shape || 'square' } : { px: tb.px, py: tb.py, pw: tb.pw, ph: tb.ph, shape: tb.shape || 'square' };
    return { ...tb, ...base, ...(edit ? pos[tb.id] : null) };
  });
  const shown = edit ? items : saved.map((x) => ({ ...x, key: 's' + x.id }));
  const width = Math.max(900, ...placed.map((x) => x.px + x.pw + 200), ...shown.map((x) => x.x + x.w + 200));
  const height = Math.max(560, ...placed.map((x) => x.py + x.ph + 200), ...shown.map((x) => x.y + x.h + 200));

  useEffect(() => { setEdit(false); setPicked(null); }, [zone]);
  useKeys((e) => {
    if (!edit || e.key !== 'Escape' || modalsOpen() || typingIn(e)) return;
    e.preventDefault();
    if (picked) setPicked(null); else { setEdit(false); }
  });

  const start = () => { setPos({}); setItems(saved.map((x) => ({ ...x, key: 'k' + nextKey.current++ }))); setPicked(null); setEdit(true); };
  const save = async () => {
    setBusy(true);
    try {
      await put(`/api/plan/${zone}`, { tables: placed.map((x) => ({ id: x.id, px: x.px, py: x.py, pw: x.pw, ph: x.ph, shape: x.shape })),
        items: items.map(({ kind, x, y, w, h, label }) => ({ kind, x, y, w, h, label })) });
      ui.toast(t('Saved')); setEdit(false); setPicked(null); reload();
    } catch (e) { ui.toast(errText(e), 'bad'); }
    setBusy(false);
  };
  const addItem = (kind) => { const [w, h] = NEW[kind]; const key = 'k' + nextKey.current++; setItems((all) => [...all, { key, kind, x: 40, y: 40, w, h, label: kind === 'label' ? t('Text') : kind === 'bar' ? t('Bar') : '' }]); setPicked('i:' + key); };
  const addTable = async () => {
    const n = name.trim(); if (!n) return;
    try { await post('/api/admin/tables', { zone_id: zone, name: n, sort: tables.length + 1 }); setName(''); reload(); } catch (e) { ui.toast(errText(e), 'bad'); }
  };

  // one finger or the mouse moves the thing that was touched; the page scrolls when empty floor is dragged
  const down = (key, x, y) => (e) => {
    if (!edit) return;
    e.stopPropagation(); e.currentTarget.setPointerCapture?.(e.pointerId);
    setPicked(key);
    drag.current = { key, sx: e.clientX, sy: e.clientY, x, y };
  };
  const move = (e) => {
    const d = drag.current; if (!d) return;
    const nx = snap(d.x + e.clientX - d.sx), ny = snap(d.y + e.clientY - d.sy);
    if (d.key.startsWith('t:')) { const id = Number(d.key.slice(2)); const cur = placed.find((x) => x.id === id); setPos((p) => ({ ...p, [id]: { px: nx, py: ny, pw: cur.pw, ph: cur.ph, shape: cur.shape } })); }
    else setItems((all) => all.map((x) => ('i:' + x.key === d.key ? { ...x, x: nx, y: ny } : x)));
  };
  const up = () => { drag.current = null; };

  const pickedTable = picked?.startsWith('t:') ? placed.find((x) => 't:' + x.id === picked) : null;
  const pickedItem = picked?.startsWith('i:') ? items.find((x) => 'i:' + x.key === picked) : null;
  const resize = (dw, dh) => {
    if (pickedTable) setPos((p) => ({ ...p, [pickedTable.id]: { px: pickedTable.px, py: pickedTable.py, shape: pickedTable.shape, pw: Math.max(60, pickedTable.pw + dw), ph: Math.max(60, pickedTable.ph + dh) } }));
    if (pickedItem) setItems((all) => all.map((x) => (x.key === pickedItem.key ? { ...x, w: Math.max(10, x.w + dw), h: Math.max(10, x.h + dh) } : x)));
  };

  return (
    <div className={'plan' + (edit ? ' editing' : '')}>
      {app.boss && (
        <div className="plan-tools noprint">
          {!edit ? <button className="btn" onClick={start}>✎ {t('Draw the plan')}</button> : (
            <>
              <div className="row wrap">
                {Object.keys(NEW).map((k) => <button key={k} className="btn" onClick={() => addItem(k)}>+ {t(KIND_NAME[k])}</button>)}
                <span className="row"><input className="input auto" style={{ width: 90 }} placeholder={t('Table')} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTable()} />
                  <button className="btn" disabled={!name.trim()} onClick={addTable}>+ {t('Table')}</button></span>
              </div>
              {(pickedTable || pickedItem) && (
                <div className="row wrap plan-picked">
                  <b>{pickedTable ? `${t('Table')} ${pickedTable.name}` : t(KIND_NAME[pickedItem.kind])}</b>
                  <button className="btn" onClick={() => resize(-SNAP * 2, 0)}>↔ −</button><button className="btn" onClick={() => resize(SNAP * 2, 0)}>↔ +</button>
                  <button className="btn" onClick={() => resize(0, -SNAP * 2)}>↕ −</button><button className="btn" onClick={() => resize(0, SNAP * 2)}>↕ +</button>
                  {pickedItem && <button className="btn" onClick={() => setItems((all) => all.map((x) => (x.key === pickedItem.key ? { ...x, w: x.h, h: x.w } : x)))}>⟳</button>}
                  {pickedTable && <button className="btn" onClick={() => setPos((p) => ({ ...p, [pickedTable.id]: { px: pickedTable.px, py: pickedTable.py, pw: pickedTable.pw, ph: pickedTable.ph, shape: pickedTable.shape === 'round' ? 'square' : 'round' } }))}>{pickedTable.shape === 'round' ? '◻' : '◯'}</button>}
                  {pickedItem && (pickedItem.kind === 'label' || pickedItem.kind === 'bar') && <input className="input auto" style={{ width: 140 }} value={pickedItem.label || ''} maxLength={40} onChange={(e) => setItems((all) => all.map((x) => (x.key === pickedItem.key ? { ...x, label: e.target.value } : x)))} />}
                  {pickedItem && <button className="btn danger" onClick={() => { setItems((all) => all.filter((x) => x.key !== pickedItem.key)); setPicked(null); }}>{t('Remove')}</button>}
                </div>
              )}
              <div className="row">
                <button className="btn primary" disabled={busy} onClick={save}>{t('Save')}</button>
                <button className="btn ghost" onClick={() => { setEdit(false); setPicked(null); }}>{t('Cancel')}</button>
                <small className="muted">{t('Drag things where they stand. Drag the empty floor to move around.')}</small>
              </div>
            </>
          )}
        </div>
      )}
      <div className="plan-wrap" onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerDown={() => edit && setPicked(null)}>
        <div className="plan-canvas" style={{ width, height }}>
          {shown.map((it) => (
            <div key={it.key} className={`plan-item ${it.kind}${picked === 'i:' + it.key ? ' picked' : ''}`} style={{ left: it.x, top: it.y, width: it.w, height: it.h }}
              onPointerDown={down('i:' + it.key, it.x, it.y)}>{it.kind === 'label' || it.kind === 'bar' ? it.label : ''}</div>
          ))}
          {placed.map((x) => {
            const state = !x.order_id ? 'free' : x.waiter_id === app.user.id ? 'mine' : 'theirs';
            return (
              <button key={x.id} className={`tile plan-table ${state}${x.shape === 'round' ? ' round' : ''}${sel === x.id ? ' sel' : ''}${picked === 't:' + x.id ? ' picked' : ''}`}
                style={{ left: x.px, top: x.py, width: x.pw, height: x.ph }} onPointerDown={down('t:' + x.id, x.px, x.py)} onClick={() => !edit && onSelect(x.id)}>
                <b>{x.name}</b>
                {x.order_id ? <><span className="due">{money(x.due_cents)}</span><small>{x.waiter_name}</small></> : <small>{t('Free')}</small>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
