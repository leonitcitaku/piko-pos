import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, post, uid, money, clock, toCents, NetworkError, useEvents } from './api.js';
import { t } from './i18n.js';
import { Modal, Stepper, useUi } from './ui.jsx';
import { errText, sleep, withApproval } from './util.js';
import { PlanView } from './Plan.jsx';

function useWide() {
  const q = '(min-width: 900px)';
  const [wide, setWide] = useState(() => window.matchMedia(q).matches);
  useEffect(() => { const m = window.matchMedia(q); const f = () => setWide(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return wide;
}

export function Floor({ app }) {
  const { toast } = useUi();
  const wide = useWide();
  const [data, setData] = useState(null);
  const [menu, setMenu] = useState(null);
  const [zone, setZone] = useState(null);
  const [sel, setSel] = useState(null);
  const [err, setErr] = useState('');
  // Two ways to see the room: the plain grid, or the plan the owner drew. Each device remembers its own choice.
  const [mode, setMode] = useState(() => { try { return localStorage.getItem('floor_view') || 'grid'; } catch { return 'grid'; } });
  const pickMode = (m) => { setMode(m); try { localStorage.setItem('floor_view', m); } catch { /* private window */ } };
  const loadTables = useCallback(() => get('/api/tables').then((d) => { setData(d); setErr(''); }).catch((e) => setErr(errText(e))), []);
  const loadMenu = useCallback(() => get('/api/menu').then(setMenu).catch(() => {}), []);
  useEffect(() => { loadTables(); loadMenu(); }, [loadTables, loadMenu]);
  useEvents({
    hello: () => { loadTables(); loadMenu(); app.reloadInfo(); },
    tables: loadTables, menu: loadMenu, day: () => { loadTables(); app.reloadInfo(); }, printer: app.reloadInfo,
    ticket_failed: (d) => { if (d.user_id === app.user.id) toast(`${t('Table')} ${d.table}: ${t('The ticket did not print. Tell the bar.')}`, 'bad'); },
    offline: () => setErr(t('No connection to the POS. Check the Wi-Fi.')),
  });
  useEffect(() => { if (data && zone == null && data.zones.length) setZone(data.zones[0].id); }, [data, zone]);

  if (!data || !menu) return <div className="page"><p className={err ? 'notice bad' : 'muted'}>{err || t('Loading')}</p></div>;
  const table = sel != null ? data.tables.find((x) => x.id === sel) : null;
  const grid = (
    <section className="floor">
      {err && <p className="notice bad">{err}</p>}
      <div className="zones" role="tablist">
        {data.zones.map((z) => {
          const open = data.tables.filter((x) => x.zone_id === z.id && x.order_id).length;
          return <button key={z.id} role="tab" aria-selected={zone === z.id} className={zone === z.id ? 'on' : ''} onClick={() => setZone(z.id)}>{z.name}{open > 0 && <i>{open}</i>}</button>;
        })}
        <span className="view-toggle">
          <button className={mode === 'grid' ? 'on' : ''} onClick={() => pickMode('grid')} title={t('Grid')} aria-label={t('Grid')}>▦</button>
          <button className={mode === 'plan' ? 'on' : ''} onClick={() => pickMode('plan')} title={t('Plan')} aria-label={t('Plan')}>◰</button>
        </span>
      </div>
      {mode === 'plan' && zone != null ? <PlanView app={app} data={data} zone={zone} sel={sel} onSelect={setSel} reload={loadTables} /> : (
      <div className="tiles">
        {data.tables.filter((x) => x.zone_id === zone).map((x) => {
          const state = !x.order_id ? 'free' : x.waiter_id === app.user.id ? 'mine' : 'theirs';
          return (
            <button key={x.id} className={`tile ${state}${sel === x.id ? ' sel' : ''}`} onClick={() => setSel(x.id)}>
              <b>{x.name}</b>
              {x.order_id ? <><span className="due">{money(x.due_cents)}</span><small>{x.waiter_name}{x.part_paid ? ' · ' + t('part paid') : ''}</small></> : <small>{t('Free')}</small>}
            </button>
          );
        })}
      </div>
      )}
    </section>
  );
  const pane = table && (
    <OrderPane key={table.id} app={app} table={table} menu={menu} tables={data} onClose={() => setSel(null)} onGo={(id) => { setSel(id); loadTables(); }} reload={() => { loadTables(); loadMenu(); }} />
  );
  if (wide) return <div className={'split' + (mode === 'plan' ? ' with-plan' : '')}>{grid}<section className="pane">{pane || <div className="empty"><p>{t('Pick a table')}</p></div>}</section></div>;
  return table ? <section className="pane full">{pane}</section> : grid;
}

const lineCents = (it, qty = it.qty) => Math.round((it.price_cents * qty * (100 - (it.discount_pct || 0))) / 100);

function OrderPane({ app, table, menu, tables, onClose, onGo, reload }) {
  const ui = useUi();
  const { toast } = ui;
  const [order, setOrder] = useState(null);
  const [cart, setCart] = useState([]);
  const [cat, setCat] = useState(menu.categories[0]?.id);
  const [send, setSend] = useState('idle');
  const [dlg, setDlg] = useState(null);
  const [showSent, setShowSent] = useState(false);
  const ids = useRef({ order: uid(), batch: uid() });
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    if (!table.order_id) { setOrder(null); return; }
    get(`/api/orders/${table.order_id}`).then((o) => alive.current && setOrder(o)).catch(() => {});
  }, [table.order_id, table.due_cents, table.items]);

  const add = (p) => {
    if (!p.available) return;
    setCart((c) => {
      const i = c.findIndex((x) => x.product.id === p.id && !x.mods.length && !x.note);
      if (i >= 0) return c.map((x, j) => (j === i ? { ...x, qty: x.qty + 1 } : x));
      return [...c, { key: uid(), product: p, qty: 1, mods: [], note: '' }];
    });
  };
  const modsFor = (p) => menu.modifiers.filter((m) => m.category_id == null || m.category_id === p.category_id);
  const cartLine = (c) => (c.product.price_cents + c.mods.reduce((s, id) => s + (menu.modifiers.find((m) => m.id === id)?.price_cents || 0), 0)) * c.qty;
  const cartTotal = cart.reduce((s, c) => s + cartLine(c), 0);

  const sendCart = async () => {
    if (!cart.length || send !== 'idle') return;
    setSend('sending');
    for (;;) {
      try {
        let oid = order?.id;
        if (!oid) oid = (await post('/api/orders', { id: ids.current.order, table_id: table.id })).id;
        const o = await post(`/api/orders/${oid}/items`, { batch_id: ids.current.batch, items: cart.map((c) => ({ product_id: c.product.id, qty: c.qty, modifier_ids: c.mods, note: c.note || undefined })) });
        if (!alive.current) return;
        setOrder(o); setCart([]); ids.current.batch = uid(); setSend('idle');
        toast(t('Sent')); reload(); app.afterAction();
        if (!app.isPc) onClose();   // the PC goes back to the name list by itself
        return;
      } catch (e) {
        if (e instanceof NetworkError) { setSend('retrying'); await sleep(2000); if (!alive.current) return; continue; } // same ids: the server ignores a repeat
        setSend('idle'); toast(errText(e), 'bad'); reload();
        return;
      }
    }
  };

  const afterChange = (o) => { if (o.closed || o.status !== 'open') { toast(t('Table closed')); reload(); onClose(); } else { setOrder(o); reload(); } };
  const cancelItem = async (it, reason) => {
    try {
      const o = await withApproval(ui, (pin) => post(`/api/orders/${order.id}/cancel-item`, { item_id: it.id, reason, pin }));
      if (o) { setDlg(null); afterChange(o); }
    } catch (e) {
      if (e.code === 'reason_required') setDlg({ type: 'reason', item: it });
      else toast(errText(e), 'bad');
    }
  };

  const live = (order?.items || []).filter((i) => i.status === 'sent');
  const unpaid = live.filter((i) => !i.payment_id);
  const busyTables = tables.tables.filter((x) => x.order_id && x.id !== table.id);
  const freeTables = tables.tables.filter((x) => !x.order_id);
  const act = async (fn, okMsg) => { try { const r = await fn(); if (r !== null && okMsg) toast(okMsg); return r; } catch (e) { toast(errText(e), 'bad'); return undefined; } };

  return (
    <div className="order">
      <header className="order-head">
        <button className="btn ghost back" onClick={onClose}>‹ {t('Tables')}</button>
        <div className="order-title"><b>{t('Table')} {table.name}</b>{order && <small>{order.waiter_name} · {clock(order.opened_at)}</small>}</div>
        {order && <button className="btn" onClick={() => setDlg({ type: 'more' })}>{t('More')}</button>}
      </header>

      <div className="order-scroll">
        {order && order.items.length > 3 && (
          <button className="sent-sum" onClick={() => setShowSent((x) => !x)} aria-expanded={showSent}>
            <b>{live.reduce((n, i) => n + i.qty, 0)} {t('items')} · {money(order.total_cents)}</b>
            <span>{showSent ? t('Hide') : t('Show')} {showSent ? '▴' : '▾'}</span>
          </button>
        )}
        {order && order.items.length > 0 && (order.items.length <= 3 || showSent) && (
          <ul className="lines">
            {order.items.map((i) => (
              <li key={i.id} className={i.status === 'void' ? 'void' : i.payment_id ? 'paid' : ''}>
                <button className="line" disabled={i.status !== 'sent' || !!i.payment_id} onClick={() => setDlg({ type: 'item', item: i })}>
                  <span className="q">{i.qty}</span>
                  <span className="n">{i.name}{i.modifiers.map((m) => <em key={m.id}>+ {m.name}</em>)}{i.note && <em className="note">{i.note}</em>}{i.discount_pct > 0 && i.status === 'sent' && <em>−{i.discount_pct}%</em>}</span>
                  <span className="p">{i.status === 'void' ? t(i.void_reason || 'Cancel') : i.payment_id ? t('Paid') : money(i.total_cents)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {(!order || !order.items.length) && !cart.length && <p className="muted pad">{t('Nothing ordered yet. Pick items below.')}</p>}

        <div className="cats">{menu.categories.map((c) => <button key={c.id} className={cat === c.id ? 'on' : ''} onClick={() => setCat(c.id)}>{c.name}</button>)}</div>
        <div className="products">
          {menu.products.filter((p) => p.category_id === cat).map((p) => (
            <button key={p.id} className={'product' + (p.available ? '' : ' out')} onClick={() => add(p)} disabled={!p.available}>
              <b>{p.name}</b><span>{p.available ? money(p.price_cents) : t('Sold out')}</span>
            </button>
          ))}
        </div>
      </div>

      <footer className="order-foot">
        {cart.length > 0 && (
          <ul className="cart">
            {cart.map((c) => (
              <li key={c.key}>
                <button className="line" onClick={() => setDlg({ type: 'cart', key: c.key })}>
                  <span className="q">{c.qty}</span>
                  <span className="n">{c.product.name}{c.mods.map((id) => <em key={id}>+ {menu.modifiers.find((m) => m.id === id)?.name}</em>)}{c.note && <em className="note">{c.note}</em>}</span>
                  <span className="p">{money(cartLine(c))}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="foot-row">
          {cart.length > 0 ? (
            <button className="btn primary big grow" onClick={sendCart} disabled={send !== 'idle'}>
              {send === 'idle' ? `${t('Send to bar')} · ${money(cartTotal)}` : send === 'sending' ? t('Sending') + '…' : t('Retrying') + '…'}
            </button>
          ) : (
            <>
              <div className="due-box"><small>{t('Due')}</small><b>{money(order?.due_cents || 0)}</b></div>
              <button className="btn primary big grow" disabled={!unpaid.length} onClick={() => setDlg({ type: 'pay' })}>{t('Pay')}</button>
            </>
          )}
        </div>
      </footer>

      {dlg?.type === 'cart' && (() => {
        const c = cart.find((x) => x.key === dlg.key); if (!c) return null;
        const upd = (patch) => setCart((all) => all.map((x) => (x.key === c.key ? { ...x, ...patch } : x)));
        return (
          <Modal title={c.product.name} onClose={() => setDlg(null)}>
            <Stepper value={c.qty} min={1} onChange={(qty) => upd({ qty })} />
            {modsFor(c.product).length > 0 && <div className="checks">{modsFor(c.product).map((m) => (
              <label key={m.id}><input type="checkbox" checked={c.mods.includes(m.id)} onChange={(e) => upd({ mods: e.target.checked ? [...c.mods, m.id] : c.mods.filter((x) => x !== m.id) })} />{m.name}{m.price_cents > 0 && <small>+{money(m.price_cents)}</small>}</label>
            ))}</div>}
            <input className="input" placeholder={t('Note, for example no ice')} value={c.note} maxLength={80} onChange={(e) => upd({ note: e.target.value })} />
            <div className="row">
              <button className="btn danger" onClick={() => { setCart((all) => all.filter((x) => x.key !== c.key)); setDlg(null); }}>{t('Remove')}</button>
              <button className="btn primary grow" onClick={() => setDlg(null)}>{t('Done')}</button>
            </div>
          </Modal>
        );
      })()}

      {dlg?.type === 'item' && (
        <Modal title={`${dlg.item.qty} × ${dlg.item.name}`} onClose={() => setDlg(null)}>
          <p className="muted">{dlg.item.sent_by_name} · {clock(dlg.item.sent_at)}</p>
          <button className="btn danger big" onClick={() => cancelItem(dlg.item)}>{t('Cancel item')}</button>
        </Modal>
      )}
      {dlg?.type === 'reason' && (
        <Modal title={t('Why is it cancelled?')} onClose={() => setDlg(null)}>
          <div className="stack">{['mistake', 'spilled', 'customer left', 'other'].map((r) => <button key={r} className="btn big" onClick={() => cancelItem(dlg.item, r)}>{t(r)}</button>)}</div>
        </Modal>
      )}

      {dlg?.type === 'pay' && order && <PayDialog app={app} order={order} unpaid={unpaid} onClose={() => setDlg(null)} onPaid={(r) => {
        setDlg(null);
        if (r.order.status === 'paid') { toast(t('Table closed')); reload(); onClose(); } else { setOrder(r.order); toast(`${t('Still to pay')}: ${money(r.order.due_cents)}`); reload(); }
        app.afterAction();
      }} />}

      {dlg?.type === 'more' && (
        <Modal title={`${t('Table')} ${table.name}`} onClose={() => setDlg(null)}>
          <div className="stack">
            <button className="btn big" onClick={() => setDlg({ type: 'move' })}>{t('Move table')}</button>
            <button className="btn big" disabled={!busyTables.length} onClick={() => setDlg({ type: 'merge' })}>{t('Merge with another table')}</button>
            <button className="btn big" disabled={!unpaid.length} onClick={() => setDlg({ type: 'pick-items', picked: [] })}>{t('Move items')}</button>
            <button className="btn big" onClick={async () => setDlg({ type: 'pass', users: await get('/api/auth/users') })}>{t('Pass to another waiter')}</button>
            <button className="btn big" disabled={!unpaid.length} onClick={() => setDlg({ type: 'discount', pct: '10' })}>{t('Discount')}</button>
            <button className="btn big" onClick={async () => setDlg({ type: 'reprint', list: await get(`/api/orders/${order.id}/tickets`) })}>{t('Reprint ticket')}</button>
          </div>
        </Modal>
      )}
      {dlg?.type === 'move' && <TablePicker title={t('Pick a free table')} tables={tables} list={freeTables} onClose={() => setDlg(null)} onPick={async (tb) => {
        const o = await act(() => post(`/api/orders/${order.id}/move`, { table_id: tb.id })); if (o) { setDlg(null); onGo(tb.id); } }} />}
      {dlg?.type === 'merge' && <TablePicker title={t('Pick the table to merge into')} tables={tables} list={busyTables} onClose={() => setDlg(null)} onPick={async (tb) => {
        const o = await act(() => post(`/api/orders/${order.id}/merge`, { into_order_id: tb.order_id })); if (o) { setDlg(null); onGo(tb.id); } }} />}
      {dlg?.type === 'pick-items' && (
        <Modal title={t('Pick the items to move')} onClose={() => setDlg(null)}>
          <div className="checks">{unpaid.map((i) => (
            <label key={i.id}><input type="checkbox" checked={dlg.picked.includes(i.id)} onChange={(e) => setDlg({ ...dlg, picked: e.target.checked ? [...dlg.picked, i.id] : dlg.picked.filter((x) => x !== i.id) })} />{i.qty} × {i.name}<small>{money(i.total_cents)}</small></label>
          ))}</div>
          <button className="btn primary big" disabled={!dlg.picked.length} onClick={() => setDlg({ type: 'items-to', picked: dlg.picked })}>{t('Next')}</button>
        </Modal>
      )}
      {dlg?.type === 'items-to' && <TablePicker title={t('Pick a table')} tables={tables} list={tables.tables.filter((x) => x.id !== table.id)} onClose={() => setDlg(null)} onPick={async (tb) => {
        const r = await act(() => post(`/api/orders/${order.id}/move-items`, { item_ids: dlg.picked, table_id: tb.id, new_order_id: uid() }));
        if (r) { setDlg(null); if (r.source.status !== 'open') { reload(); onGo(tb.id); } else { setOrder(r.source); reload(); } } }} />}
      {dlg?.type === 'pass' && (
        <Modal title={t('Pick who takes this table')} onClose={() => setDlg(null)}>
          <div className="stack">{dlg.users.filter((u) => u.id !== order.waiter_id).map((u) => (
            <button key={u.id} className="btn big" onClick={async () => { const o = await act(() => post(`/api/orders/${order.id}/pass`, { user_id: u.id })); if (o) { setDlg(null); setOrder(o); reload(); } }}>{u.name} <small>{t(u.role)}</small></button>
          ))}</div>
        </Modal>
      )}
      {dlg?.type === 'discount' && (
        <Modal title={t('Discount')} onClose={() => setDlg(null)}>
          <label className="field"><span>{t('Discount percent')}</span><input className="input" inputMode="numeric" value={dlg.pct} onChange={(e) => setDlg({ ...dlg, pct: e.target.value.replace(/\D/g, '').slice(0, 3) })} /></label>
          <button className="btn primary big" onClick={async () => {
            const o = await act(() => withApproval(ui, (pin) => post(`/api/orders/${order.id}/discount`, { pct: Number(dlg.pct || 0), pin })));
            if (o) { setDlg(null); setOrder(o); reload(); } }}>{t('Save')}</button>
        </Modal>
      )}
      {dlg?.type === 'reprint' && (
        <Modal title={t('Reprint ticket')} onClose={() => setDlg(null)}>
          <div className="stack">{dlg.list.map((j) => (
            <button key={j.id} className="btn big" onClick={async () => { const r = await act(() => post(`/api/tickets/${j.id}/reprint`), t('Ticket sent to the printer')); if (r) setDlg(null); }}>#{j.id} · {clock(j.original_time)} · {t(j.status)}</button>
          ))}</div>
        </Modal>
      )}
    </div>
  );
}

function TablePicker({ title, tables, list, onPick, onClose }) {
  return (
    <Modal title={title} onClose={onClose} wide>
      {tables.zones.map((z) => {
        const rows = list.filter((x) => x.zone_id === z.id);
        if (!rows.length) return null;
        return <div key={z.id} className="pick-zone"><h3>{z.name}</h3><div className="tiles small">{rows.map((x) => (
          <button key={x.id} className={'tile ' + (x.order_id ? 'theirs' : 'free')} onClick={() => onPick(x)}><b>{x.name}</b>{x.order_id && <small>{money(x.due_cents)}</small>}</button>
        ))}</div></div>;
      })}
    </Modal>
  );
}

function PayDialog({ app, order, unpaid, onClose, onPaid }) {
  const ui = useUi();
  const [qty, setQty] = useState(() => Object.fromEntries(unpaid.map((i) => [i.id, i.qty])));
  const [received, setReceived] = useState('');
  const [busy, setBusy] = useState(false);
  const pid = useRef(uid());
  const total = unpaid.reduce((s, i) => s + (qty[i.id] ? lineCents(i, qty[i.id]) : 0), 0);
  const all = unpaid.every((i) => qty[i.id] === i.qty);
  const rc = toCents(received);
  const change = received && Number.isFinite(rc) ? rc - total : null;
  const pay = async (type) => {
    setBusy(true);
    try {
      const body = { payment_id: pid.current, type, items: all ? undefined : unpaid.filter((i) => qty[i.id] > 0).map((i) => ({ id: i.id, qty: qty[i.id] })) };
      const r = await withApproval(ui, (pin) => post(`/api/orders/${order.id}/pay`, { ...body, pin }));
      if (r) onPaid(r);
    } catch (e) { ui.toast(errText(e), 'bad'); }
    setBusy(false);
  };
  return (
    <Modal title={t('Take payment')} onClose={onClose}>
      <div className="row between"><span className="muted">{t('Pick what is being paid')}</span>
        <button className="btn ghost" onClick={() => setQty(Object.fromEntries(unpaid.map((i) => [i.id, all ? 0 : i.qty])))}>{t('Everything')}</button></div>
      <ul className="paylist">{unpaid.map((i) => (
        <li key={i.id} className={qty[i.id] ? '' : 'off'}>
          <span className="n">{i.name}{i.modifiers.map((m) => <em key={m.id}>+ {m.name}</em>)}</span>
          <Stepper value={qty[i.id]} min={0} max={i.qty} onChange={(v) => setQty({ ...qty, [i.id]: v })} />
          <span className="p">{money(qty[i.id] ? lineCents(i, qty[i.id]) : 0)}</span>
        </li>
      ))}</ul>
      <div className="payfoot">
      <div className="paytotal"><span>{t('Total')}</span><b>{money(total)}</b></div>
      <div className="row">
        <label className="field grow"><span>{t('Cash received')}</span><input className="input" inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} placeholder="0.00" /></label>
        <div className={'change' + (change != null && change < 0 ? ' neg' : '')}><small>{t('Change to give back')}</small><b>{change == null ? '–' : money(change)}</b></div>
      </div>
      <div className="row">
        <button className="btn" disabled={busy || total <= 0} onClick={() => pay('house')}>{t('On the house')}</button>
        <button className="btn primary big grow" disabled={busy || total <= 0} onClick={() => pay('cash')}>{t('Cash')} · {money(total)}</button>
      </div>
      </div>
    </Modal>
  );
}
