import React, { useCallback, useEffect, useState } from 'react';
import { get, post, put, money, toCents, clock, dateTime, useEvents } from './api.js';
import { t } from './i18n.js';
import { Modal, useUi, Field } from './ui.jsx';
import { errText } from './util.js';
import { RangeReport, StaffProfiles } from './Insights.jsx';
import { PrinterFinder, Backups } from './SystemExtras.jsx';

const TABS = ['Day', 'Tickets', 'Report', 'Menu', 'Staff', 'Tables', 'Settings', 'System', 'Log'];

export function Manager({ app }) {
  const [tab, setTab] = useState('Day');
  return (
    <div className="manager">
      <nav className="tabs">{TABS.map((x) => <button key={x} className={tab === x ? 'on' : ''} onClick={() => setTab(x)}>{t(x)}</button>)}</nav>
      <div className="page">
        {tab === 'Day' && <DayTab app={app} />}
        {tab === 'Tickets' && <TicketsTab app={app} />}
        {tab === 'Report' && <ReportTab />}
        {tab === 'Menu' && <MenuTab app={app} />}
        {tab === 'Staff' && <StaffTab app={app} />}
        {tab === 'Tables' && <TablesTab />}
        {tab === 'Settings' && <SettingsTab app={app} />}
        {tab === 'System' && <SystemTab app={app} />}
        {tab === 'Log' && <LogTab />}
      </div>
    </div>
  );
}

function useLoad(url, deps = []) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => get(url).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(errText(e))), [url]);
  useEffect(() => { load(); }, [load, ...deps]);
  return [data, load, err];
}
const useAct = () => { const { toast } = useUi(); return async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg); return r ?? true; } catch (e) { toast(errText(e), 'bad'); return null; } }; };
const Money = ({ c }) => <span className={'num' + (c < 0 ? ' neg' : '')}>{money(c)}</span>;

// ---------------------------------------------------------------- Day
function DayTab({ app }) {
  const [d, load] = useLoad('/api/day');
  const [users] = useLoad('/api/auth/users');
  const [dlg, setDlg] = useState(null);
  const [problem, setProblem] = useState(null);
  const { toast } = useUi();
  const act = useAct();
  useEvents({ day: load, tables: load });
  if (!d) return <p className="muted">{t('Loading')}</p>;
  const refresh = () => { load(); app.reloadInfo(); };
  if (!d.day) return (
    <div className="narrow">
      <h1>{t('No day is open.')}</h1>
      <button className="btn primary big" onClick={async () => { if (await act(() => post('/api/day/open'))) refresh(); }}>{t('Open the day')}</button>
    </div>
  );
  const close = async () => {
    setProblem(null);
    try { await post('/api/day/close'); toast(t('Day closed. Backup saved.')); refresh(); }
    catch (e) { if (e.code === 'open_tables' || e.code === 'unsettled_sessions') setProblem(e); else toast(errText(e), 'bad'); }
  };
  return (
    <>
      <div className="row between wrap">
        <h1>{t('The day is open since')} {dateTime(d.day.opened_at)}</h1>
        <div className="row">
          <button className="btn" onClick={async () => { if (await act(() => post('/api/day/catch-up', { on: !d.day.catch_up }))) refresh(); }}>{t('Catch up mode')}: {d.day.catch_up ? t('Turn off') : t('Turn on')}</button>
          <button className="btn danger" onClick={close}>{t('Close the day')}</button>
        </div>
      </div>
      {d.day.hours_open > 20 && <p className="notice warn">{t('This day has been open for a long time. Did someone forget to close it?')}</p>}
      {problem?.code === 'open_tables' && <p className="notice bad">{t('Some tables are still open')}: {problem.data.tables.map((x) => `${x.table_name} (${x.waiter_name})`).join(', ')}</p>}
      {problem?.code === 'unsettled_sessions' && <p className="notice bad">{t('Some staff have not settled yet')}: {problem.data.sessions.map((x) => `${x.user_name} ${money(x.owed_cents)}`).join(', ')}</p>}

      <table className="grid">
        <thead><tr><th>{t('Staff')}</th><th className="r">{t('Starting change')}</th><th className="r">{t('Cash sales')}</th><th className="r">{t('Paid out')}</th><th className="r">{t('Owes')}</th><th className="r">{t('Handed over')}</th><th className="r">{t('Difference')}</th><th /></tr></thead>
        <tbody>
          {d.sessions.map((s) => (
            <tr key={s.id} className={s.settled_at ? 'done' : ''}>
              <td><b>{s.user_name}</b> <small>{t(s.role)}{s.open_tables.length ? ` · ${t('Open tables')}: ${s.open_tables.map((o) => o.table_name).join(', ')}` : ''}</small></td>
              <td className="r"><Money c={s.float_cents} /></td><td className="r"><Money c={s.cash_cents} /></td><td className="r"><Money c={s.payout_cents} /></td>
              <td className="r"><b><Money c={s.settled_at ? s.expected_cents : s.owed_cents} /></b></td>
              <td className="r">{s.settled_at ? <Money c={s.handed_cents} /> : ''}</td>
              <td className="r">{s.settled_at ? <Money c={s.difference_cents} /> : ''}</td>
              <td className="r">{s.settled_at ? <small>{t('Settled')} {clock(s.settled_at)}</small> : <button className="btn primary" onClick={() => setDlg({ type: 'settle', s, handed: '' })}>{t('Settle')}</button>}</td>
            </tr>
          ))}
          {!d.sessions.length && <tr><td colSpan="8" className="muted">–</td></tr>}
        </tbody>
      </table>
      <div className="row">
        <button className="btn" onClick={() => setDlg({ type: 'float', user_id: '', amount: '' })}>{t('Give change money')}</button>
        <button className="btn" onClick={() => setDlg({ type: 'payout', amount: '', reason: '', session_id: '' })}>{t('Pay a supplier from the cash')}</button>
      </div>
      {d.payouts.length > 0 && (
        <><h2>{t('Payouts today')}</h2>
          <table className="grid"><tbody>{d.payouts.map((p) => <tr key={p.id}><td>{clock(p.created_at)}</td><td>{p.reason}</td><td>{p.user_name || t('House cash')}</td><td className="r"><Money c={p.amount_cents} /></td></tr>)}</tbody></table></>
      )}

      {dlg?.type === 'settle' && (
        <Modal title={`${t('Settle')}: ${dlg.s.user_name}`} onClose={() => setDlg(null)}>
          <div className="bignum"><span>{t('Owes')}</span><b>{money(dlg.s.owed_cents)}</b></div>
          {dlg.s.open_tables.length > 0 && <p className="notice bad">{t('Open tables')}: {dlg.s.open_tables.map((o) => o.table_name).join(', ')}</p>}
          <Field label={t('Cash handed over')}><input className="input" inputMode="decimal" autoFocus value={dlg.handed} onChange={(e) => setDlg({ ...dlg, handed: e.target.value })} placeholder="0.00" /></Field>
          {dlg.handed !== '' && Number.isFinite(toCents(dlg.handed)) && <p>{t('Difference')}: <Money c={toCents(dlg.handed) - dlg.s.owed_cents} /></p>}
          <button className="btn primary big" disabled={dlg.handed === '' || !Number.isFinite(toCents(dlg.handed))} onClick={async () => {
            if (await act(() => post(`/api/sessions/${dlg.s.id}/settle`, { handed_cents: toCents(dlg.handed) }), t('Settled'))) { setDlg(null); refresh(); } }}>{t('Settle')}</button>
        </Modal>
      )}
      {dlg?.type === 'float' && (
        <Modal title={t('Give change money')} onClose={() => setDlg(null)}>
          <Field label={t('Staff')}><select className="input" value={dlg.user_id} onChange={(e) => setDlg({ ...dlg, user_id: e.target.value })}><option value="">–</option>{(users || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
          <Field label={t('Amount')}><input className="input" inputMode="decimal" value={dlg.amount} onChange={(e) => setDlg({ ...dlg, amount: e.target.value })} placeholder="0.00" /></Field>
          <button className="btn primary big" disabled={!dlg.user_id || !(toCents(dlg.amount) > 0)} onClick={async () => {
            if (await act(() => post('/api/sessions/float', { user_id: Number(dlg.user_id), amount_cents: toCents(dlg.amount) }), t('Float given'))) { setDlg(null); refresh(); } }}>{t('Save')}</button>
        </Modal>
      )}
      {dlg?.type === 'payout' && (
        <Modal title={t('Pay a supplier from the cash')} onClose={() => setDlg(null)}>
          <Field label={t('Amount')}><input className="input" inputMode="decimal" value={dlg.amount} onChange={(e) => setDlg({ ...dlg, amount: e.target.value })} placeholder="0.00" /></Field>
          <Field label={t('Reason')}><input className="input" value={dlg.reason} onChange={(e) => setDlg({ ...dlg, reason: e.target.value })} /></Field>
          <Field label={t('From')}><select className="input" value={dlg.session_id} onChange={(e) => setDlg({ ...dlg, session_id: e.target.value })}><option value="">{t('House cash')}</option>{d.sessions.filter((s) => !s.settled_at).map((s) => <option key={s.id} value={s.id}>{s.user_name}</option>)}</select></Field>
          <button className="btn primary big" disabled={!(toCents(dlg.amount) > 0) || !dlg.reason.trim()} onClick={async () => {
            if (await act(() => post('/api/cash/payout', { amount_cents: toCents(dlg.amount), reason: dlg.reason, session_id: dlg.session_id ? Number(dlg.session_id) : undefined }), t('Payout recorded'))) { setDlg(null); refresh(); } }}>{t('Record payout')}</button>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Tickets
function TicketsTab({ app }) {
  const [d, load] = useLoad('/api/tickets');
  const [open, setOpen] = useState(null);
  const act = useAct();
  useEvents({ tickets: load, printer: load, tables: load });
  if (!d) return <p className="muted">{t('Loading')}</p>;
  const p = d.printer;
  return (
    <>
      <div className="row between wrap">
        <h1>{t('Printer')}: <span className={'pill ' + (p.mode === 'off' ? '' : p.ok ? 'ok' : 'bad')}>{p.mode === 'off' ? t('off') : p.ok ? t('working') : t('problem')}</span></h1>
        <button className="btn" onClick={load}>{t('Refresh')}</button>
      </div>
      {!p.ok && p.mode !== 'off' && <p className="notice bad">{p.error}</p>}
      {!d.tickets.length && <p className="muted">{t('No tickets yet today.')}</p>}
      <ul className="tickets">
        {d.tickets.map((j) => (
          <li key={j.id} className={j.status}>
            <button className="ticket-row" onClick={() => setOpen(open === j.id ? null : j.id)}>
              <b>#{j.id}</b><span>{j.kind !== 'test' ? `${t('Table')} ${j.content.table}` : 'Test'}</span><span>{clock(j.original_time)}</span><span>{j.user_name}</span>
              <span className={'pill ' + (j.status === 'printed' ? 'ok' : j.status === 'waiting' ? 'bad' : '')}>{t(j.status)}</span>
              {j.was_late ? <span className="pill warn">{t('late')}</span> : null}{j.kind === 'copy' || j.content?.copy ? <span className="pill">{t('copy')}</span> : null}
            </button>
            {open === j.id && (
              <div className="ticket-open">
                <pre>{j.text}</pre>
                <div className="stack">
                  {j.last_error && <p className="notice bad">{j.last_error}</p>}
                  <button className="btn" onClick={async () => { if (await act(() => post(`/api/tickets/${j.id}/reprint`), t('Ticket sent to the printer'))) load(); }}>{t('Reprint')}</button>
                  {j.status === 'waiting' && <button className="btn danger" onClick={async () => { if (await act(() => post(`/api/tickets/${j.id}/skip`))) load(); }}>{t('Skip')}</button>}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------- Report
function ReportTab() {
  const [mode, setMode] = useState('period');
  return (
    <>
      <div className="seg noprint">
        <button className={mode === 'period' ? 'on' : ''} onClick={() => setMode('period')}>{t('By period')}</button>
        <button className={mode === 'shift' ? 'on' : ''} onClick={() => setMode('shift')}>{t('One business day in detail')}</button>
      </div>
      {mode === 'period' ? <RangeReport /> : <DayReport />}
    </>
  );
}
function DayReport() {
  const [days] = useLoad('/api/reports/days');
  const [id, setId] = useState(null);
  const [r, setR] = useState(null);
  useEffect(() => { if (days && days.length && id == null) setId(days[0].id); }, [days, id]);
  useEffect(() => { if (id != null) get('/api/reports/day?id=' + id).then(setR).catch(() => setR(null)); }, [id]);
  if (!days) return <p className="muted">{t('Loading')}</p>;
  if (!days.length) return <p className="muted">{t('No day to report yet.')}</p>;
  return (
    <div className="report">
      <div className="row between wrap noprint">
        <select className="input auto" value={id || ''} onChange={(e) => setId(Number(e.target.value))}>{days.map((d) => <option key={d.id} value={d.id}>{dateTime(d.opened_at)}{d.status === 'open' ? ' · ' + t('Still open') : ''}</option>)}</select>
        <div className="row"><button className="btn" onClick={() => window.print()}>{t('Print')}</button><a className="btn" href={'/api/reports/day.csv?id=' + id}>{t('Download CSV')}</a></div>
      </div>
      {r && (
        <>
          <h1>{dateTime(r.day.opened_at)} {r.day.closed_at ? '→ ' + dateTime(r.day.closed_at) : ''}</h1>
          <p className="muted">{r.day.opened_by_name}{r.day.closed_by_name ? ' / ' + r.day.closed_by_name : ''}</p>
          <div className="stats">
            <div className="bignum"><span>{t('Total sales')}</span><b>{money(r.totals.sales_cents)}</b></div>
            <div className="bignum"><span>{t('Cash')}</span><b>{money(r.totals.cash_cents)}</b></div>
            <div className="bignum"><span>{t('On the house')}</span><b>{money(r.totals.house_cents)}</b></div>
            <div className="bignum"><span>{t('Paid out')}</span><b>{money(r.totals.payout_cents)}</b></div>
            <div className="bignum"><span>{t('Tables paid')}</span><b>{r.totals.tables_paid}</b></div>
          </div>
          <h2>{t('Staff')}</h2>
          <table className="grid"><thead><tr><th>{t('Name')}</th><th className="r">{t('Starting change')}</th><th className="r">{t('Cash sales')}</th><th className="r">{t('Paid out')}</th><th className="r">{t('Owes')}</th><th className="r">{t('Handed over')}</th><th className="r">{t('Difference')}</th></tr></thead>
            <tbody>{r.sessions.map((s) => <tr key={s.id}><td>{s.user_name}</td><td className="r"><Money c={s.float_cents} /></td><td className="r"><Money c={s.cash_cents} /></td><td className="r"><Money c={s.payout_cents} /></td><td className="r"><Money c={s.expected_cents ?? s.owed_cents} /></td><td className="r">{s.handed_cents == null ? '' : <Money c={s.handed_cents} />}</td><td className="r">{s.difference_cents == null ? '' : <Money c={s.difference_cents} />}</td></tr>)}</tbody></table>
          <div className="cols">
            <div><h2>{t('By category')}</h2><Breakdown rows={r.by_category} /></div>
            <div><h2>{t('By hour')}</h2><Breakdown rows={r.by_hour.map((x) => ({ ...x, key: x.key + ':00' }))} /></div>
          </div>
          <h2>{t('By item')}</h2><Breakdown rows={r.by_item} />
          {r.voids.length > 0 && <><h2>{t('Cancelled after approval')}</h2><table className="grid"><tbody>{r.voids.map((v, i) => <tr key={i}><td>{clock(v.at)}</td><td>{v.user_name}</td><td>{v.qty} × {v.item}</td><td>{t(v.reason)}</td><td>{t('Approved by')}: {v.approved_by_name}</td></tr>)}</tbody></table></>}
          {r.comps.length > 0 && <><h2>{t('On the house')}</h2><table className="grid"><tbody>{r.comps.map((v, i) => <tr key={i}><td>{clock(v.at)}</td><td>{v.user_name}</td><td className="r"><Money c={v.amount_cents} /></td><td>{t('Approved by')}: {v.approved_by_name}</td></tr>)}</tbody></table></>}
          {r.discounts.length > 0 && <><h2>{t('Discount')}</h2><table className="grid"><tbody>{r.discounts.map((v, i) => <tr key={i}><td>{clock(v.at)}</td><td>{v.user_name}</td><td>{v.pct}%</td><td>{t('Approved by')}: {v.approved_by_name}</td></tr>)}</tbody></table></>}
          {r.payouts.length > 0 && <><h2>{t('Payouts today')}</h2><table className="grid"><tbody>{r.payouts.map((p) => <tr key={p.id}><td>{clock(p.created_at)}</td><td>{p.reason}</td><td>{p.user_name || t('House cash')}</td><td className="r"><Money c={p.amount_cents} /></td></tr>)}</tbody></table></>}
          <dl className="facts">
            <div><dt>{t('Quick cancels')}</dt><dd>{r.quick_cancels.map((q) => `${q.user_name}: ${q.count}`).join(', ') || '0'}</dd></div>
            <div><dt>{t('Late tickets')}</dt><dd>{r.tickets.late}</dd></div>
            <div><dt>{t('Reprints')}</dt><dd>{r.tickets.reprints}</dd></div>
            <div><dt>{t('Entered in catch up mode')}</dt><dd>{r.catch_up_orders}</dd></div>
          </dl>
        </>
      )}
    </div>
  );
}
function Breakdown({ rows }) {
  const max = Math.max(1, ...rows.map((x) => x.cents));
  return <table className="grid bars"><tbody>{rows.map((x) => <tr key={x.key}><td>{x.key}</td><td className="r">{x.qty}</td><td className="bar-cell"><i style={{ width: (x.cents / max) * 100 + '%' }} /></td><td className="r"><Money c={x.cents} /></td></tr>)}</tbody></table>;
}

// ---------------------------------------------------------------- Menu
function MenuTab({ app }) {
  const [d, load] = useLoad('/api/admin/all');
  const act = useAct();
  const owner = app.user.role === 'owner';
  const [add, setAdd] = useState(null);
  if (!d) return <p className="muted">{t('Loading')}</p>;
  const save = async (entity, id, patch) => { if (await act(() => put(`/api/admin/${entity}/${id}`, patch))) load(); else load(); };
  return (
    <>
      {!owner && <p className="notice">{t('Only the owner can change prices.')}</p>}
      {d.categories.map((c) => (
        <section key={c.id} className={c.active ? '' : 'dim'}>
          <div className="row between">
            <Inline value={c.name} onSave={(name) => save('categories', c.id, { name })} className="h2" />
            <div className="row"><Toggle label={t('Active')} on={!!c.active} onChange={(v) => save('categories', c.id, { active: v })} />
              {owner && <button className="btn" onClick={() => setAdd({ type: 'product', category_id: c.id, name: '', price: '' })}>{t('Add product')}</button>}</div>
          </div>
          <table className="grid"><thead><tr><th>{t('Name')}</th><th className="r">{t('Price')}</th><th className="r">{t('VAT %')}</th><th>{t('Available')}</th><th>{t('Active')}</th></tr></thead>
            <tbody>{d.products.filter((p) => p.category_id === c.id).map((p) => (
              <tr key={p.id} className={p.active ? '' : 'dim'}>
                <td><Inline value={p.name} onSave={(name) => save('products', p.id, { name })} /></td>
                <td className="r"><Inline value={(p.price_cents / 100).toFixed(2)} disabled={!owner} numeric onSave={(v) => Number.isFinite(toCents(v)) && save('products', p.id, { price_cents: toCents(v) })} /></td>
                <td className="r"><Inline value={String(p.vat_rate)} disabled={!owner} numeric onSave={(v) => save('products', p.id, { vat_rate: Number(v) })} /></td>
                <td><Toggle on={!!p.available} onChange={(v) => act(() => post(`/api/products/${p.id}/available`, { available: v })).then(load)} /></td>
                <td><Toggle on={!!p.active} onChange={(v) => save('products', p.id, { active: v })} /></td>
              </tr>
            ))}</tbody></table>
        </section>
      ))}
      <div className="row"><button className="btn" onClick={() => setAdd({ type: 'category', name: '' })}>{t('Add category')}</button></div>
      <h2>{t('Extras')}</h2>
      <table className="grid"><thead><tr><th>{t('Name')}</th><th className="r">{t('Price')}</th><th>{t('Category')}</th><th>{t('Active')}</th></tr></thead>
        <tbody>{d.modifiers.map((m) => (
          <tr key={m.id}><td><Inline value={m.name} onSave={(name) => save('modifiers', m.id, { name })} /></td>
            <td className="r"><Inline value={(m.price_cents / 100).toFixed(2)} disabled={!owner} numeric onSave={(v) => Number.isFinite(toCents(v)) && save('modifiers', m.id, { price_cents: toCents(v) })} /></td>
            <td>{d.categories.find((c) => c.id === m.category_id)?.name || '–'}</td>
            <td><Toggle on={!!m.active} onChange={(v) => save('modifiers', m.id, { active: v })} /></td></tr>
        ))}</tbody></table>
      {owner && <div className="row"><button className="btn" onClick={() => setAdd({ type: 'modifier', name: '', price: '0', category_id: '' })}>{t('Add extra')}</button></div>}

      {add && (
        <Modal title={t(add.type === 'product' ? 'Add product' : add.type === 'category' ? 'Add category' : 'Add extra')} onClose={() => setAdd(null)}>
          <Field label={t('Name')}><input className="input" autoFocus value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} /></Field>
          {add.type !== 'category' && <Field label={t('Price')}><input className="input" inputMode="decimal" value={add.price} onChange={(e) => setAdd({ ...add, price: e.target.value })} placeholder="0.00" /></Field>}
          {add.type === 'modifier' && <Field label={t('Category')}><select className="input" value={add.category_id} onChange={(e) => setAdd({ ...add, category_id: e.target.value })}><option value="">–</option>{d.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
          <button className="btn primary big" disabled={!add.name.trim() || (add.type !== 'category' && !Number.isFinite(toCents(add.price)))} onClick={async () => {
            const body = add.type === 'category' ? { name: add.name, sort: d.categories.length }
              : add.type === 'product' ? { name: add.name, category_id: add.category_id, price_cents: toCents(add.price), sort: 99 }
              : { name: add.name, price_cents: toCents(add.price), category_id: add.category_id ? Number(add.category_id) : null };
            const ent = add.type === 'category' ? 'categories' : add.type === 'product' ? 'products' : 'modifiers';
            if (await act(() => post('/api/admin/' + ent, body), t('Saved'))) { setAdd(null); load(); } }}>{t('Add')}</button>
        </Modal>
      )}
    </>
  );
}

function Inline({ value, onSave, disabled, numeric, className }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => { if (v !== value && String(v).trim() !== '') onSave(v); else setV(value); };
  return <input className={'inline ' + (className || '') + (numeric ? ' r' : '')} value={v} disabled={disabled} inputMode={numeric ? 'decimal' : undefined}
    onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />;
}
function Toggle({ on, onChange, label }) {
  return <button className={'toggle' + (on ? ' on' : '')} role="switch" aria-checked={on} onClick={() => onChange(!on)}><i />{label && <span>{label}</span>}</button>;
}

// ---------------------------------------------------------------- Staff
function StaffTab({ app }) {
  const [d, load] = useLoad('/api/admin/all');
  const [dlg, setDlg] = useState(null);
  const act = useAct();
  if (app.user.role !== 'owner') return <StaffProfiles />;
  if (!d) return <p className="muted">{t('Loading')}</p>;
  const roles = ['waiter', 'bartender', 'manager', 'owner'];
  return (
    <>
      <StaffProfiles />
      <h2>{t('Accounts and PINs')}</h2>
      <table className="grid"><thead><tr><th>{t('Name')}</th><th>{t('Role')}</th><th>{t('Language')}</th><th>{t('Active')}</th><th /></tr></thead>
        <tbody>{d.users.map((u) => (
          <tr key={u.id} className={u.active ? '' : 'dim'}><td><b>{u.name}</b></td><td>{t(u.role)}</td><td>{u.language === 'sq' ? 'Shqip' : 'English'}</td><td>{u.active ? '✓' : '–'}</td>
            <td className="r"><button className="btn" onClick={() => setDlg({ ...u, pin: '', isNew: false })}>✎</button></td></tr>
        ))}</tbody></table>
      <div className="row"><button className="btn primary" onClick={() => setDlg({ isNew: true, name: '', role: 'waiter', language: 'sq', active: 1, pin: '' })}>{t('Add staff member')}</button></div>
      {dlg && (
        <Modal title={dlg.isNew ? t('Add staff member') : dlg.name} onClose={() => setDlg(null)}>
          <Field label={t('Name')}><input className="input" value={dlg.name} onChange={(e) => setDlg({ ...dlg, name: e.target.value })} /></Field>
          <Field label={t('Role')}><select className="input" value={dlg.role} onChange={(e) => setDlg({ ...dlg, role: e.target.value })}>{roles.map((r) => <option key={r} value={r}>{t(r)}</option>)}</select></Field>
          <Field label={t('Language')}><select className="input" value={dlg.language} onChange={(e) => setDlg({ ...dlg, language: e.target.value })}><option value="sq">Shqip</option><option value="en">English</option></select></Field>
          <Field label={dlg.isNew ? t(dlg.role === 'manager' || dlg.role === 'owner' ? 'PIN (6 digits)' : 'PIN (4 digits)') : t('New PIN')}><input className="input" inputMode="numeric" value={dlg.pin} onChange={(e) => setDlg({ ...dlg, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })} /></Field>
          {!dlg.isNew && <Toggle label={t('Active')} on={!!dlg.active} onChange={(v) => setDlg({ ...dlg, active: v ? 1 : 0 })} />}
          <button className="btn primary big" disabled={!dlg.name.trim() || (dlg.isNew && dlg.pin.length < 4)} onClick={async () => {
            const body = { name: dlg.name, role: dlg.role, language: dlg.language, active: !!dlg.active, pin: dlg.pin || undefined };
            if (await act(() => (dlg.isNew ? post('/api/admin/users', body) : put('/api/admin/users/' + dlg.id, body)), t('Saved'))) { setDlg(null); load(); } }}>{t('Save')}</button>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Tables
function TablesTab() {
  const [d, load] = useLoad('/api/admin/all');
  const act = useAct();
  const [name, setName] = useState('');
  if (!d) return <p className="muted">{t('Loading')}</p>;
  const save = async (entity, id, patch) => { await act(() => put(`/api/admin/${entity}/${id}`, patch)); load(); };
  return (
    <>
      {d.zones.map((z) => (
        <section key={z.id} className={z.active ? '' : 'dim'}>
          <div className="row between"><Inline value={z.name} className="h2" onSave={(v) => save('zones', z.id, { name: v })} />
            <div className="row"><Toggle label={t('Active')} on={!!z.active} onChange={(v) => save('zones', z.id, { active: v })} />
              <button className="btn" onClick={async () => { const n = d.tables.filter((x) => x.zone_id === z.id).length + 1; await act(() => post('/api/admin/tables', { zone_id: z.id, name: String(n), sort: n })); load(); }}>{t('Add table')}</button></div></div>
          <div className="table-chips">{d.tables.filter((x) => x.zone_id === z.id).map((x) => (
            <span key={x.id} className={'tchip' + (x.active ? '' : ' dim')}><Inline value={x.name} onSave={(v) => save('tables', x.id, { name: v })} /><Toggle on={!!x.active} onChange={(v) => save('tables', x.id, { active: v })} /></span>
          ))}</div>
        </section>
      ))}
      <div className="row"><input className="input auto" placeholder={t('Zone')} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" disabled={!name.trim()} onClick={async () => { await act(() => post('/api/admin/zones', { name, sort: d.zones.length })); setName(''); load(); }}>{t('Add zone')}</button></div>
    </>
  );
}

// ---------------------------------------------------------------- Settings
function SettingsTab({ app }) {
  const [d, load] = useLoad('/api/admin/all');
  const [f, setF] = useState(null);
  const act = useAct();
  const owner = app.user.role === 'owner';
  useEffect(() => { if (d) setF(d.settings); }, [d]);
  if (!f) return <p className="muted">{t('Loading')}</p>;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (keys) => { if (await act(() => put('/api/admin/settings', Object.fromEntries(keys.map((k) => [k, f[k]]))), t('Saved'))) { load(); app.reloadInfo(); } };
  return (
    <div className="narrow">
      <h2>{t('Printer connection')}</h2>
      <Field label={t('Printer')}><select className="input" value={f.printer_mode} onChange={set('printer_mode')}>
        <option value="off">{t('No printer')}</option><option value="winraw">{t('Printer installed on this PC')}</option><option value="network">{t('Network printer')}</option><option value="windows">{t('USB printer shared in Windows')}</option><option value="file">{t('Save to files (testing)')}</option></select></Field>
      {f.printer_mode === 'winraw' && <Field label={t('Printer name')}><input className="input" value={f.printer_name || ''} onChange={set('printer_name')} /></Field>}
      {f.printer_mode === 'network' && <div className="row"><Field label={t('Printer address')}><input className="input" value={f.printer_host} onChange={set('printer_host')} placeholder="192.168.1.60" /></Field><Field label={t('Port')}><input className="input" value={f.printer_port} onChange={set('printer_port')} /></Field></div>}
      {f.printer_mode === 'windows' && <Field label={t('Windows share name')}><input className="input" value={f.printer_share} onChange={set('printer_share')} placeholder="POS80" /></Field>}
      <Field label={t('Paper width')}><select className="input" value={f.ticket_width || '32'} onChange={set('ticket_width')}><option value="32">58 mm (32)</option><option value="42">80 mm (42)</option><option value="48">80 mm (48)</option></select></Field>
      <div className="row"><button className="btn primary" onClick={() => save(['printer_mode', 'printer_host', 'printer_port', 'printer_share', 'printer_name', 'ticket_width'])}>{t('Save')}</button>
        <button className="btn" onClick={() => act(() => post('/api/system/test-print'), t('Ticket sent to the printer'))}>{t('Test print')}</button></div>
      <PrinterFinder current={f} onPick={async (patch) => { const next = { ...f, ...patch }; setF(next); if (await act(() => put('/api/admin/settings', { printer_mode: next.printer_mode, printer_host: next.printer_host || '', printer_port: next.printer_port || '9100', printer_name: next.printer_name || '' }), t('Saved'))) { load(); app.reloadInfo(); } }} />
      <h2>{t('Fiscal')}</h2>
      <p className="notice">{t('Off. No fiscal driver is installed yet.')}</p>
      {owner && (
        <>
          <h2>{t('Settings')}</h2>
          <Field label={t('Cafe name')}><input className="input" value={f.cafe_name} onChange={set('cafe_name')} /></Field>
          <Field label={t('Free cancel window, seconds')}><input className="input" inputMode="numeric" value={f.cancel_window_sec} onChange={set('cancel_window_sec')} /></Field>
          <Field label={t('Lock the PC after idle, seconds')}><input className="input" inputMode="numeric" value={f.idle_lock_sec} onChange={set('idle_lock_sec')} /></Field>
          <Field label={t('Mark a ticket late after, seconds')}><input className="input" inputMode="numeric" value={f.late_after_sec ?? '60'} onChange={set('late_after_sec')} /></Field>
          <Field label={t('Log a device out after days unused')}><input className="input" inputMode="numeric" value={f.login_idle_days ?? '14'} onChange={set('login_idle_days')} /></Field>
          <Field label={t('Backups to keep')}><input className="input" inputMode="numeric" value={f.backups_keep ?? '30'} onChange={set('backups_keep')} /></Field>
          <Field label={t('Second backup folder (USB stick)')}><input className="input" value={f.backup_dir} onChange={set('backup_dir')} placeholder="E:\\pos-backup" /></Field>
          <button className="btn primary" onClick={() => save(['cafe_name', 'cancel_window_sec', 'idle_lock_sec', 'late_after_sec', 'login_idle_days', 'backups_keep', 'backup_dir'])}>{t('Save')}</button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- System
function SystemTab({ app }) {
  const [i, load] = useLoad('/api/system/info');
  const ui = useUi();
  const act = useAct();
  if (!i) return <p className="muted">{t('Loading')}</p>;
  const url = i.urls[0] || location.origin;
  return (
    <div className="system">
      <div className="address">
        <p className="muted">{t('Open this address on the phones')}</p>
        <strong>{url}</strong>
        <img src={'/api/system/qr.svg?url=' + encodeURIComponent(url)} alt="QR" />
      </div>
      <dl className="facts">
        <div><dt>{t('Printer')}</dt><dd>{i.printer.mode === 'off' ? t('off') : i.printer.ok ? t('working') : `${t('problem')}: ${i.printer.error}`}</dd></div>
        <div><dt>{t('Devices connected')}</dt><dd>{i.phones_connected}</dd></div>
        <div><dt>{t('Last backup')}</dt><dd>{i.last_backup_at ? dateTime(i.last_backup_at) : t('never')}</dd></div>
        <div><dt>{t('PC clock')}</dt><dd>{dateTime(i.clock)}</dd></div>
        <div><dt>{t('Fiscal')}</dt><dd>{t('off')}</dd></div>
        <div><dt>{t('Version')}</dt><dd>{i.version}</dd></div>
        <div><dt>{t('Data folder')}</dt><dd>{i.data_dir}</dd></div>
      </dl>
      <Backups owner={app.user.role === 'owner'} />
      {app.user.role === 'owner' && (
        <section className="danger-zone">
          <h2>{t('Log out every other device')}</h2>
          <p>{t('For a phone that was lost. Everyone has to type their PIN again. This screen stays logged in.')}</p>
          <button className="btn danger" onClick={async () => {
            const r = await act(() => post('/api/system/logout-all'));
            if (r) ui.toast(`${t('Devices logged out')}: ${r.logged_out}`);
          }}>{t('Log out every other device')}</button>
        </section>
      )}
      {app.user.role === 'owner' && (
        <section className="danger-zone">
          <h2>{t('Wipe test data')}</h2>
          <p>{t('This deletes every sale, ticket and report. The menu, tables and staff stay. Close the day first.')}</p>
          <button className="btn danger" onClick={async () => { const pin = await ui.askPin(t('Owner PIN')); if (pin && await act(() => post('/api/system/reset', { pin }), t('Test data wiped.'))) { load(); app.reloadInfo(); } }}>{t('Wipe test data')}</button>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Log
function LogTab() {
  const [rows] = useLoad('/api/audit?limit=300');
  if (!rows) return <p className="muted">{t('Loading')}</p>;
  return (
    <table className="grid"><thead><tr><th>{t('Time')}</th><th>{t('Who')}</th><th>{t('Action')}</th><th>{t('Detail')}</th></tr></thead>
      <tbody>{rows.map((l) => <tr key={l.id}><td>{dateTime(l.at)}</td><td>{l.user_name}</td><td>{l.action}</td><td className="small">{l.detail ? (typeof l.detail === 'string' ? l.detail : Object.entries(l.detail).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ')) : ''}</td></tr>)}</tbody></table>
  );
}
