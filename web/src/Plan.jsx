// The floor as the owner drew it.
//   PlanView   what staff use: the whole room scaled to fit, tap a table.
//   PlanEditor what a manager or owner uses to draw it: full screen, pick a tool, tap where it goes,
//              drag to move, drag the corner to resize. Nothing is saved until Save.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { post, put, money } from './api.js';
import { t } from './i18n.js';
import { useUi, useKeys, typingIn, modalsOpen, holdKeyboard } from './ui.jsx';
import { errText } from './util.js';

const SNAP = 10;
const snap = (n) => Math.round(n / SNAP) * SNAP;
const KINDS = { bar: [300, 70], chair: [36, 36], wall: [300, 14], label: [150, 40], plant: [44, 44], door: [80, 14] };
const KIND_NAME = { table: 'Table', bar: 'Bar', chair: 'Chair', wall: 'Wall', label: 'Text', plant: 'Plant', door: 'Door' };
const KIND_ICON = { select: '➤', table: '▢', bar: '▬', chair: '●', wall: '┃', label: 'T', plant: '✿', door: '⌐' };
const SIZES = [['S', 80, 80], ['M', 110, 110], ['L', 140, 140], ['↔', 190, 100]];

const tableBox = (tb) => (tb.px == null ? null : { x: tb.px, y: tb.py, w: tb.pw, h: tb.ph });
function bounds(boxes, pad = 30) {
  if (!boxes.length) return { x: 0, y: 0, w: 600, h: 360 };
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}
function Shape({ it }) { return it.kind === 'label' || it.kind === 'bar' ? it.label : null; }

// ---------------------------------------------------------------- the plan staff tap on
export function PlanView({ app, data, zone, sel, onSelect, reload, onDrawing, hot }) {
  const [editing, setEditing] = useState(false);
  const wrap = useRef(null);
  const [width, setWidth] = useState(0);
  const tables = useMemo(() => data.tables.filter((x) => x.zone_id === zone), [data, zone]);
  const items = useMemo(() => (data.plan || []).filter((x) => x.zone_id === zone), [data, zone]);
  const placed = tables.filter((x) => x.px != null), loose = tables.filter((x) => x.px == null);
  useEffect(() => { onDrawing?.(editing); return () => onDrawing?.(false); }, [editing]);
  // Sent here by "Draw the floor plan" in Manager > Tables: open straight in the editor.
  useEffect(() => { if (window.__posStartDrawing && app.boss) { window.__posStartDrawing = false; setEditing(true); } }, []);
  const empty = !placed.length && !items.length;
  useLayoutEffect(() => {
    if (!wrap.current) return undefined;
    const ro = new ResizeObserver(() => setWidth(wrap.current?.clientWidth || 0));
    ro.observe(wrap.current); setWidth(wrap.current.clientWidth);
    return () => ro.disconnect();
  }, [empty]);
  const b = bounds([...placed.map(tableBox), ...items]);
  const scale = width ? Math.min(1.25, Math.max(0.4, width / b.w)) : 1;   // the whole room fits the panel
  const state = (x) => (!x.order_id ? 'free' : x.waiter_id === app.user.id ? 'mine' : 'theirs');
  return (
    <div className="plan">
      {app.boss && <div className="row between plan-bar"><span className="muted">{empty ? t('No plan drawn for this area yet.') : ''}</span>
        <button className={'btn' + (empty ? ' primary' : '')} onClick={() => setEditing(true)}>✎ {t('Draw the plan')}</button></div>}
      {!empty && (
        <div className="plan-wrap" ref={wrap}>
          <div style={{ width: b.w * scale, height: b.h * scale }}>
            <div className="plan-canvas" style={{ width: b.w, height: b.h, transform: `scale(${scale})` }}>
              {items.map((it) => <div key={it.id} className={`plan-item ${it.kind}`} style={{ left: it.x - b.x, top: it.y - b.y, width: it.w, height: it.h }}><Shape it={it} /></div>)}
              {placed.map((x) => (
                <button key={x.id} data-tid={x.id} className={`plan-table ${state(x)}${x.shape === 'round' ? ' round' : ''}${sel === x.id ? ' sel' : ''}${hot === x.id ? ' kb' : ''}`}
                  style={{ left: x.px - b.x, top: x.py - b.y, width: x.pw, height: x.ph }} onClick={() => onSelect(x.id)}>
                  <b>{x.name}</b>{x.order_id ? <><span className="due">{money(x.due_cents)}</span><small>{x.waiter_name}</small></> : null}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {loose.length > 0 && (
        <div className="plan-loose">
          {!empty && <small className="muted">{t('Not on the plan')}</small>}
          <div className="tiles small">{loose.map((x) => (
            <button key={x.id} data-tid={x.id} className={`tile ${state(x)}${sel === x.id ? ' sel' : ''}${hot === x.id ? ' kb' : ''}`} onClick={() => onSelect(x.id)}><b>{x.name}</b>{x.order_id ? <small>{money(x.due_cents)}</small> : null}</button>
          ))}</div>
        </div>
      )}
      {editing && createPortal(<PlanEditor data={data} zone={zone} onClose={(saved) => { setEditing(false); if (saved) reload(); }} />, document.body)}
    </div>
  );
}

// ---------------------------------------------------------------- the editor
let seq = 1;
const newKey = () => 'n' + seq++;

function PlanEditor({ data, zone, onClose }) {
  const ui = useUi();
  const zoneName = data.zones.find((z) => z.id === zone)?.name || '';
  // Everything on the floor is one list: tables (placed, or waiting in the tray with x = null) and shapes.
  const [els, setEls] = useState(() => [
    ...data.tables.filter((x) => x.zone_id === zone).map((x) => ({ key: 't' + x.id, type: 'table', id: x.id, name: x.name, shape: x.shape || 'square', busy: !!x.order_id, ...(tableBox(x) || { x: null, y: null, w: 110, h: 110 }) })),
    ...(data.plan || []).filter((x) => x.zone_id === zone).map((x) => ({ key: 'i' + x.id, type: 'item', kind: x.kind, label: x.label || '', x: x.x, y: x.y, w: x.w, h: x.h })),
  ]);
  const [tool, setTool] = useState('select');     // 'select' | 'table' | a shape kind | { place: key } for a table from the tray
  const [picked, setPicked] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const undo = useRef([]);
  const depth = useRef(0);
  useEffect(() => { const h = holdKeyboard(); depth.current = h.depth; return h.release; }, []);
  const canvas = useRef(null), scroller = useRef(null), elsRef = useRef(els), zoomRef = useRef(zoom);
  elsRef.current = els; zoomRef.current = zoom;

  const remember = () => { undo.current.push(elsRef.current); if (undo.current.length > 60) undo.current.shift(); setDirty(true); };
  const change = (fn) => { remember(); setEls(fn); };
  const patch = (key, p) => setEls((all) => all.map((e) => (e.key === key ? { ...e, ...p } : e)));
  const undoOne = () => { const prev = undo.current.pop(); if (prev) { setEls(prev); setPicked(null); } };

  const onFloor = els.filter((e) => e.x != null), tray = els.filter((e) => e.type === 'table' && e.x == null);
  const size = { w: Math.max(1400, ...onFloor.map((e) => e.x + e.w + 400)), h: Math.max(900, ...onFloor.map((e) => e.y + e.h + 400)) };
  const cur = els.find((e) => e.key === picked) || null;

  const nextName = () => {
    const names = els.filter((e) => e.type === 'table').map((e) => e.name);
    const m = names.map((n) => /^(\D*)(\d+)$/.exec(n)).filter(Boolean);
    const prefix = m.length ? m[m.length - 1][1] : '';
    let n = Math.max(0, ...m.filter((x) => x[1] === prefix).map((x) => Number(x[2]))) + 1;
    while (names.includes(prefix + n)) n++;
    return prefix + n;
  };
  const point = (e) => { const r = canvas.current.getBoundingClientRect(); return { x: (e.clientX - r.left) / zoomRef.current, y: (e.clientY - r.top) / zoomRef.current }; };

  // Tap the floor with a tool in hand: the thing lands where the finger is.
  const floorDown = (e) => {
    if (e.target !== canvas.current) return;
    if (tool === 'select') { setPicked(null); return; }
    const p = point(e);
    const at = (w, h) => ({ x: Math.max(0, snap(p.x - w / 2)), y: Math.max(0, snap(p.y - h / 2)), w, h });
    if (tool.place) { change((all) => all.map((x) => (x.key === tool.place ? { ...x, ...at(x.w, x.h) } : x))); setPicked(tool.place); setTool('select'); return; }
    const key = newKey();
    if (tool === 'table') change((all) => [...all, { key, type: 'table', id: null, name: nextName(), shape: 'square', ...at(110, 110) }]);
    else { const [w, h] = KINDS[tool]; change((all) => [...all, { key, type: 'item', kind: tool, label: tool === 'label' ? t('Text') : tool === 'bar' ? t('Bar') : '', ...at(w, h) }]); if (tool !== 'chair') setTool('select'); }
    setPicked(key);
  };

  // Drag a thing to move it; drag its corner to resize it.
  const grab = (e, key, mode) => {
    if (tool !== 'select') return;
    e.stopPropagation(); e.preventDefault();
    setPicked(key);
    const o = elsRef.current.find((x) => x.key === key), sx = e.clientX, sy = e.clientY;
    let moved = false;
    const mv = (ev) => {
      const dx = (ev.clientX - sx) / zoomRef.current, dy = (ev.clientY - sy) / zoomRef.current;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!moved) { moved = true; remember(); }
      patch(key, mode === 'move' ? { x: Math.max(0, snap(o.x + dx)), y: Math.max(0, snap(o.y + dy)) } : { w: Math.max(20, snap(o.w + dx)), h: Math.max(10, snap(o.h + dy)) });
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };

  const removePicked = () => {
    if (!cur) return;
    if (cur.type === 'table' && cur.id != null) change((all) => all.map((x) => (x.key === cur.key ? { ...x, x: null, y: null } : x)));   // an existing table goes back to the tray
    else change((all) => all.filter((x) => x.key !== cur.key));
    setPicked(null);
  };
  const duplicate = () => {
    if (!cur || cur.type !== 'item') return;
    const key = newKey(); change((all) => [...all, { ...cur, key, x: cur.x + 20, y: cur.y + 20 }]); setPicked(key);
  };
  const placeAll = () => change((all) => {
    const base = Math.max(20, ...all.filter((x) => x.x != null).map((x) => x.y + x.h + 30));
    let i = 0;
    return all.map((x) => (x.type === 'table' && x.x == null ? { ...x, x: 20 + (i % 6) * 130, y: base + Math.floor(i++ / 6) * 130 } : x));
  });
  const fit = () => {
    const b = bounds(onFloor, 60), el = scroller.current;
    if (!el || !onFloor.length) { setZoom(1); return; }
    const z = Math.min(1.5, Math.max(0.4, Math.min(el.clientWidth / (b.x + b.w), el.clientHeight / (b.y + b.h))));
    setZoom(Math.round(z * 20) / 20);
  };

  const close = () => { if (!dirty || window.confirm(t('Leave without saving the plan?'))) onClose(false); };
  const save = async () => {
    const names = els.filter((e) => e.type === 'table').map((e) => e.name.trim());
    if (names.some((n) => !n)) { ui.toast(t('Every table needs a name'), 'bad'); return; }
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) { ui.toast(t('Two tables have the same name'), 'bad'); return; }
    setBusy(true);
    try {
      const tables = [];
      for (const e of els.filter((x) => x.type === 'table')) {
        let id = e.id;
        const orig = data.tables.find((x) => x.id === id);
        if (id == null) id = (await post('/api/admin/tables', { zone_id: zone, name: e.name.trim(), sort: 999 })).id;           // new tables exist only from here on
        else if (orig && orig.name !== e.name.trim()) await put(`/api/admin/tables/${id}`, { name: e.name.trim() });
        tables.push(e.x == null ? { id, px: null } : { id, px: e.x, py: e.y, pw: e.w, ph: e.h, shape: e.shape });
      }
      await put(`/api/plan/${zone}`, { tables, items: els.filter((x) => x.type === 'item').map(({ kind, x, y, w, h, label }) => ({ kind, x, y, w, h, label })) });
      ui.toast(t('Saved')); onClose(true);
    } catch (err) { ui.toast(errText(err), 'bad'); setBusy(false); }
  };

  useKeys((e) => {
    if (modalsOpen() > depth.current || typingIn(e)) return;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); undoOne(); return; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (k === 'Escape') { e.preventDefault(); if (tool !== 'select') setTool('select'); else if (picked) setPicked(null); else close(); return; }
    if (!cur || cur.x == null) return;
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); removePicked(); return; }
    const d = { ArrowLeft: [-SNAP, 0], ArrowRight: [SNAP, 0], ArrowUp: [0, -SNAP], ArrowDown: [0, SNAP] }[k];
    if (d) { e.preventDefault(); remember(); patch(cur.key, { x: Math.max(0, cur.x + d[0]), y: Math.max(0, cur.y + d[1]) }); }
  });

  const tools = ['select', 'table', ...Object.keys(KINDS)];
  const hint = tool === 'select' ? t('Drag to move. Drag the corner to resize.') : tool.place ? t('Tap the floor where this table stands.') : `${t('Tap the floor to place')}: ${t(KIND_NAME[tool])}`;
  return (
    <div className="pe">
      <header className="pe-top">
        <b>{t('Floor plan')} · {zoneName}</b>
        <span className="pe-hint">{hint}</span>
        <div className="row">
          <button className="btn" disabled={!undo.current.length} onClick={undoOne}>↶ {t('Undo')}</button>
          <button className="btn" onClick={() => setZoom((z) => Math.max(0.4, Math.round((z - 0.1) * 10) / 10))}>−</button>
          <button className="btn" onClick={fit}>{Math.round(zoom * 100)}%</button>
          <button className="btn" onClick={() => setZoom((z) => Math.min(1.5, Math.round((z + 0.1) * 10) / 10))}>+</button>
          <button className="btn ghost" onClick={close}>{t('Cancel')}</button>
          <button className="btn primary" disabled={busy} onClick={save}>{t('Save')}</button>
        </div>
      </header>
      <div className="pe-body">
        <aside className="pe-tools">
          {tools.map((k) => (
            <button key={k} className={tool === k ? 'on' : ''} onClick={() => { setTool(k); if (k !== 'select') setPicked(null); }}>
              <i>{KIND_ICON[k]}</i><span>{k === 'select' ? t('Move') : t(KIND_NAME[k])}</span>
            </button>
          ))}
        </aside>
        <div className="pe-scroll" ref={scroller}>
          <div style={{ width: size.w * zoom, height: size.h * zoom }}>
            <div ref={canvas} className={'pe-canvas' + (tool !== 'select' ? ' placing' : '')} style={{ width: size.w, height: size.h, transform: `scale(${zoom})` }} onPointerDown={floorDown}>
              {onFloor.map((e) => (
                <div key={e.key} className={(e.type === 'table' ? `plan-table free${e.shape === 'round' ? ' round' : ''}` : `plan-item ${e.kind}`) + (picked === e.key ? ' picked' : '')}
                  style={{ left: e.x, top: e.y, width: e.w, height: e.h }} onPointerDown={(ev) => grab(ev, e.key, 'move')}>
                  {e.type === 'table' ? <b>{e.name}</b> : <Shape it={e} />}
                  {picked === e.key && tool === 'select' && <span className="pe-handle" onPointerDown={(ev) => grab(ev, e.key, 'size')} />}
                </div>
              ))}
            </div>
          </div>
        </div>
        <aside className="pe-side">
          {cur && cur.x != null ? (
            <div className="pe-card">
              <h3>{cur.type === 'table' ? t('Table') : t(KIND_NAME[cur.kind])}</h3>
              {cur.type === 'table' && (
                <>
                  <label className="field"><span>{t('Name')}</span><input className="input" value={cur.name} maxLength={12} onFocus={remember} onChange={(e) => patch(cur.key, { name: e.target.value })} /></label>
                  <div className="seg">{[['square', '▢'], ['round', '◯']].map(([s, icon]) => <button key={s} className={cur.shape === s ? 'on' : ''} onClick={() => change((all) => all.map((x) => (x.key === cur.key ? { ...x, shape: s } : x)))}>{icon}</button>)}</div>
                  <div className="seg">{SIZES.map(([name, w, h]) => <button key={name} className={cur.w === w && cur.h === h ? 'on' : ''} onClick={() => change((all) => all.map((x) => (x.key === cur.key ? { ...x, w, h } : x)))}>{name}</button>)}</div>
                </>
              )}
              {cur.type === 'item' && (cur.kind === 'label' || cur.kind === 'bar') && (
                <label className="field"><span>{t('Text')}</span><input className="input" value={cur.label} maxLength={40} onFocus={remember} onChange={(e) => patch(cur.key, { label: e.target.value })} /></label>
              )}
              <button className="btn" onClick={() => change((all) => all.map((x) => (x.key === cur.key ? { ...x, w: x.h, h: x.w } : x)))}>⟳ {t('Turn')}</button>
              {cur.type === 'item' && <button className="btn" onClick={duplicate}>⧉ {t('Copy')}</button>}
              {cur.busy ? <p className="muted">{t('This table has an open order.')}</p> : null}
              <button className="btn danger" onClick={removePicked}>{cur.type === 'table' && cur.id != null ? t('Take off the plan') : t('Remove')}</button>
            </div>
          ) : <p className="muted pe-none">{t('Tap something on the floor to change it.')}</p>}
          {tray.length > 0 && (
            <div className="pe-card">
              <h3>{t('Not on the plan')} ({tray.length})</h3>
              <div className="pe-tray">{tray.map((e) => <button key={e.key} className={tool.place === e.key ? 'on' : ''} onClick={() => { setTool({ place: e.key }); setPicked(null); }}>{e.name}</button>)}</div>
              <button className="btn" onClick={placeAll}>{t('Place all in rows')}</button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
