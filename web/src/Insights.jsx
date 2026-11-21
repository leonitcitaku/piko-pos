// Reports for any period, and what each member of staff did in it. Manager and owner only.
import React, { useEffect, useState } from 'react';
import { get, money, dateTime } from './api.js';
import { t } from './i18n.js';
import { Modal } from './ui.jsx';
import { errText } from './util.js';

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const KINDS = ['today', 'yesterday', 'this_month', 'last_month', 'this_year', 'last_year', 'all', 'day', 'month', 'year', 'custom'];
const LABEL = { today: 'Today', yesterday: 'Yesterday', this_month: 'This month', last_month: 'Last month', this_year: 'This year', last_year: 'Last year',
  all: 'All time', day: 'A day…', month: 'A month…', year: 'A year…', custom: 'Between two dates…' };

export const newPeriod = (kind = 'today') => { const n = new Date(); return { kind, day: iso(n), month: iso(n).slice(0, 7), year: String(n.getFullYear()), from: iso(new Date(n.getFullYear(), n.getMonth(), 1)), to: iso(n) }; };

// -> { from, to } as YYYY-MM-DD, both included. Empty object means all time.
export function rangeOf(p) {
  const n = new Date(), y = n.getFullYear(), m = n.getMonth();
  switch (p.kind) {
    case 'today': return { from: iso(n), to: iso(n) };
    case 'yesterday': { const d = new Date(y, m, n.getDate() - 1); return { from: iso(d), to: iso(d) }; }
    case 'this_month': return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
    case 'last_month': return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case 'this_year': return { from: `${y}-01-01`, to: `${y}-12-31` };
    case 'last_year': return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    case 'day': return { from: p.day, to: p.day };
    case 'month': { const [yy, mm] = p.month.split('-').map(Number); return { from: `${p.month}-01`, to: iso(new Date(yy, mm, 0)) }; }
    case 'year': return { from: `${p.year}-01-01`, to: `${p.year}-12-31` };
    case 'custom': return { from: p.from, to: p.to };
    default: return {};
  }
}
export const queryOf = (p) => new URLSearchParams(rangeOf(p)).toString();
const pretty = (s) => (s ? s.split('-').reverse().join('.') : '');
export const periodText = (p) => { const r = rangeOf(p); return !r.from ? t('All time') : r.from === r.to ? pretty(r.from) : `${pretty(r.from)} → ${pretty(r.to)}`; };

export function PeriodPicker({ value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const years = []; for (let y = new Date().getFullYear(); y >= 2024; y--) years.push(String(y));
  return (
    <div className="period noprint">
      <select className="input auto" value={value.kind} onChange={(e) => set({ kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{t(LABEL[k])}</option>)}</select>
      {value.kind === 'day' && <input className="input auto" type="date" value={value.day} onChange={(e) => e.target.value && set({ day: e.target.value })} />}
      {value.kind === 'month' && <input className="input auto" type="month" value={value.month} onChange={(e) => e.target.value && set({ month: e.target.value })} />}
      {value.kind === 'year' && <select className="input auto" value={value.year} onChange={(e) => set({ year: e.target.value })}>{years.map((y) => <option key={y}>{y}</option>)}</select>}
      {value.kind === 'custom' && <><input className="input auto" type="date" value={value.from} max={value.to} onChange={(e) => e.target.value && set({ from: e.target.value })} />
        <span className="muted">→</span><input className="input auto" type="date" value={value.to} min={value.from} onChange={(e) => e.target.value && set({ to: e.target.value })} /></>}
    </div>
  );
}

const Money = ({ c }) => <span className={'num' + (c < 0 ? ' neg' : '')}>{money(c)}</span>;
function Bars({ rows, qtyLabel }) {
  const max = Math.max(1, ...rows.map((x) => x.cents));
  if (!rows.length) return <p className="muted">–</p>;
  return <table className="grid bars"><tbody>{rows.map((x) => <tr key={x.key}><td>{x.key}</td><td className="r">{x.qty}{qtyLabel ? ' ' + qtyLabel : ''}</td><td className="bar-cell"><i style={{ width: (x.cents / max) * 100 + '%' }} /></td><td className="r"><Money c={x.cents} /></td></tr>)}</tbody></table>;
}
function useFetch(url) {
  const [state, setState] = useState({ data: null, err: '' });
  useEffect(() => { let on = true; setState((s) => ({ ...s, err: '' })); get(url).then((d) => on && setState({ data: d, err: '' })).catch((e) => on && setState({ data: null, err: errText(e) })); return () => { on = false; }; }, [url]);
  return state;
}

// ---------------------------------------------------------------- report for a period
export function RangeReport() {
  const [p, setP] = useState(() => newPeriod('today'));
  const q = queryOf(p);
  const { data: r, err } = useFetch('/api/reports/range?' + q);
  return (
    <div className="report">
      <div className="row between wrap noprint">
        <PeriodPicker value={p} onChange={setP} />
        <div className="row"><button className="btn" onClick={() => window.print()}>{t('Print')}</button><a className="btn" href={'/api/reports/range.csv?' + q}>{t('Download CSV')}</a></div>
      </div>
      <h1>{periodText(p)}</h1>
      {err && <p className="notice bad">{err}</p>}
      {!r && !err && <p className="muted">{t('Loading')}</p>}
      {r && (
        <>
          <div className="stats">
            <div className="bignum"><span>{t('Total sales')}</span><b>{money(r.totals.sales_cents)}</b></div>
            <div className="bignum"><span>{t('Cash')}</span><b>{money(r.totals.cash_cents)}</b></div>
            <div className="bignum"><span>{t('On the house')}</span><b>{money(r.totals.house_cents)}</b></div>
            <div className="bignum"><span>{t('Paid out')}</span><b>{money(r.totals.payout_cents)}</b></div>
            <div className="bignum"><span>{t('Cash kept')}</span><b>{money(r.totals.kept_cents)}</b></div>
            <div className="bignum"><span>{t('Tables paid')}</span><b>{r.totals.tables_paid}</b></div>
          </div>
          {!r.totals.payments && <p className="muted">{t('No sales in this period.')}</p>}
          {r.by_month.length > 0 && <><h2>{t('By month')}</h2><Bars rows={r.by_month} /></>}
          {r.by_day.length > 1 && r.by_day.length <= 62 && <><h2>{t('By day')}</h2><Bars rows={r.by_day.map((x) => ({ ...x, key: pretty(x.key) }))} /></>}
          <div className="cols">
            <div><h2>{t('Staff')}</h2><Bars rows={r.by_staff} /></div>
            <div><h2>{t('By category')}</h2><Bars rows={r.by_category} /></div>
          </div>
          <div className="cols">
            <div><h2>{t('By hour')}</h2><Bars rows={r.by_hour.map((x) => ({ ...x, key: String(x.key).padStart(2, '0') + ':00' }))} /></div>
            <div><h2>{t('By item')}</h2><Bars rows={r.by_item.slice(0, 40)} /></div>
          </div>
          {r.payouts.length > 0 && <><h2>{t('Paid out')}</h2><table className="grid"><tbody>{r.payouts.map((x) => <tr key={x.id}><td>{dateTime(x.created_at)}</td><td>{x.reason}</td><td>{x.user_name || t('House cash')}</td><td className="r"><Money c={x.amount_cents} /></td></tr>)}</tbody></table></>}
          <dl className="facts">
            <div><dt>{t('Surplus at settling')}</dt><dd><Money c={r.totals.surplus_cents} /></dd></div>
            <div><dt>{t('Shortage at settling')}</dt><dd><Money c={r.totals.shortage_cents} /></dd></div>
            <div><dt>{t('Cancelled after approval')}</dt><dd>{r.totals.voids}</dd></div>
            <div><dt>{t('Quick cancels')}</dt><dd>{r.totals.quick_cancels}</dd></div>
            <div><dt>{t('Discount')}</dt><dd>{r.totals.discounts}</dd></div>
          </dl>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- staff profiles
export function StaffProfiles() {
  const [p, setP] = useState(() => newPeriod('this_month'));
  const [open, setOpen] = useState(null);
  const q = queryOf(p);
  const { data: rows, err } = useFetch('/api/reports/staff?' + q);
  return (
    <div className="report">
      <div className="row between wrap"><h2>{t('What each person did')}</h2><PeriodPicker value={p} onChange={setP} /></div>
      {err && <p className="notice bad">{err}</p>}
      {!rows && !err && <p className="muted">{t('Loading')}</p>}
      {rows && (
        <div className="scroll-x"><table className="grid">
          <thead><tr><th>{t('Name')}</th><th className="r">{t('Total sales')}</th><th className="r">{t('Tables')}</th><th className="r">{t('items')}</th><th className="r">{t('Shifts')}</th><th className="r">{t('Surplus')}</th><th className="r">{t('Shortage')}</th><th className="r">{t('Difference')}</th><th /></tr></thead>
          <tbody>{rows.filter((u) => u.active || u.sales_cents || u.sessions).map((u) => (
            <tr key={u.id} className={u.active ? '' : 'dim'}>
              <td><b>{u.name}</b> <small>{t(u.role)}</small></td><td className="r"><b><Money c={u.sales_cents} /></b></td><td className="r">{u.tables}</td><td className="r">{u.items}</td><td className="r">{u.sessions}</td>
              <td className="r"><Money c={u.surplus_cents} /></td><td className="r"><Money c={u.shortage_cents} /></td><td className="r"><b><Money c={u.difference_cents} /></b></td>
              <td className="r"><button className="btn" onClick={() => setOpen(u)}>{t('Profile')}</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {open && <StaffProfile user={open} period={p} onClose={() => setOpen(null)} />}
    </div>
  );
}

function StaffProfile({ user, period, onClose }) {
  const [p, setP] = useState(period);
  const { data: d, err } = useFetch(`/api/reports/staff/${user.id}?${queryOf(p)}`);
  return (
    <Modal title={`${user.name} · ${t(user.role)}`} onClose={onClose} wide>
      <PeriodPicker value={p} onChange={setP} />
      <p className="muted">{periodText(p)}</p>
      {err && <p className="notice bad">{err}</p>}
      {!d && !err && <p className="muted">{t('Loading')}</p>}
      {d && (
        <>
          <div className="stats">
            <div className="bignum"><span>{t('Total sales')}</span><b>{money(d.sales_cents)}</b></div>
            <div className="bignum"><span>{t('Cash')}</span><b>{money(d.cash_cents)}</b></div>
            <div className="bignum"><span>{t('On the house')}</span><b>{money(d.house_cents)}</b></div>
            <div className="bignum"><span>{t('Surplus')}</span><b>{money(d.surplus_cents)}</b></div>
            <div className="bignum"><span>{t('Shortage')}</span><b className={d.shortage_cents < 0 ? 'neg' : ''}>{money(d.shortage_cents)}</b></div>
            <div className="bignum"><span>{t('Difference')}</span><b className={d.difference_cents < 0 ? 'neg' : ''}>{money(d.difference_cents)}</b></div>
          </div>
          <dl className="facts">
            <div><dt>{t('Tables')}</dt><dd>{d.tables}</dd></div><div><dt>{t('items')}</dt><dd>{d.items}</dd></div><div><dt>{t('Shifts')}</dt><dd>{d.sessions}</dd></div>
            <div><dt>{t('Cancelled after approval')}</dt><dd>{d.voids}</dd></div><div><dt>{t('Quick cancels')}</dt><dd>{d.quick_cancels}</dd></div><div><dt>{t('Discount')}</dt><dd>{d.discounts}</dd></div>
          </dl>
          <h2>{t('Shifts')}</h2>
          {!d.session_list.length ? <p className="muted">–</p> : (
            <div className="scroll-x"><table className="grid">
              <thead><tr><th>{t('Time')}</th><th className="r">{t('Starting change')}</th><th className="r">{t('Cash sales')}</th><th className="r">{t('Paid out')}</th><th className="r">{t('Owes')}</th><th className="r">{t('Handed over')}</th><th className="r">{t('Difference')}</th><th>{t('Approved by')}</th></tr></thead>
              <tbody>{d.session_list.map((s) => (
                <tr key={s.id}><td>{dateTime(s.started_at)}</td><td className="r"><Money c={s.float_cents} /></td><td className="r"><Money c={s.cash_cents} /></td><td className="r"><Money c={s.payout_cents} /></td>
                  <td className="r">{s.settled_at ? <Money c={s.expected_cents} /> : <small>{t('Still open')}</small>}</td><td className="r">{s.settled_at ? <Money c={s.handed_cents} /> : ''}</td>
                  <td className="r">{s.settled_at ? <b><Money c={s.difference_cents} /></b> : ''}</td><td>{s.confirmed_by_name || ''}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          <div className="cols">
            <div><h2>{t('By day')}</h2><Bars rows={d.by_day.slice(0, 31).map((x) => ({ ...x, key: pretty(x.key) }))} /></div>
            <div><h2>{t('By item')}</h2><Bars rows={d.top_items} /></div>
          </div>
        </>
      )}
    </Modal>
  );
}
