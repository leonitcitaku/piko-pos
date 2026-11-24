import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { get, post, put, ApiError, NetworkError, money, useEvents } from './api.js';
import { t, setLang, getLang } from './i18n.js';
import { UiProvider, PinPad, useUi, ErrorBoundary, useKeys, typingIn, modalsOpen, hasKeyboard } from './ui.jsx';
import { Floor } from './Floor.jsx';
import { Manager } from './Manager.jsx';
import { StockPage, StockBanner } from './Stock.jsx';
import { errText, isPc } from './util.js';

function Setup({ onDone }) {
  const [f, setF] = useState({ name: '', pin: '', cafe_name: '' });
  const [err, setErr] = useState('');
  const go = async (e) => {
    e.preventDefault();
    try { onDone(await post('/api/setup', { ...f, language: getLang() })); } catch (x) { setErr(errText(x)); }
  };
  return (
    <div className="gate">
      <form className="gate-card" onSubmit={go}>
        <h1>{t('Welcome. Set up the owner account.')}</h1>
        <label className="field"><span>{t('Cafe name')}</span><input value={f.cafe_name} onChange={(e) => setF({ ...f, cafe_name: e.target.value })} autoFocus /></label>
        <label className="field"><span>{t('Your name')}</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
        <label className="field"><span>{t('PIN (6 digits)')}</span><input value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })} inputMode="numeric" type="password" required minLength={6} /></label>
        {err && <p className="pin-error">{err}</p>}
        <button className="btn primary big" type="submit">{t('Start')}</button>
      </form>
    </div>
  );
}

function Login({ cafe, onDone, onLang }) {
  const [users, setUsers] = useState(null);
  const [who, setWho] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { get('/api/auth/users').then(setUsers).catch((e) => setErr(errText(e))); }, []);
  // On the name list 1 to 9 picks a person; once one is picked the digits belong to the PIN pad.
  useKeys((e) => {
    if (modalsOpen() || typingIn(e)) return;
    if (!who && /^[1-9]$/.test(e.key) && users?.[Number(e.key) - 1]) { e.preventDefault(); setWho(users[Number(e.key) - 1]); setErr(''); }
    else if (who && e.key === 'Escape') { e.preventDefault(); setWho(null); setErr(''); }
  });
  const kb = hasKeyboard();
  const tryPin = async (pin) => {
    setBusy(true); setErr('');
    try { onDone(await post('/api/auth/login', { user_id: who.id, pin })); }
    catch (e) { setErr(errText(e)); }
    setBusy(false);
  };
  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-top">
          <strong className="brand">{cafe}</strong>
          <button className="btn ghost" onClick={onLang}>{getLang() === 'sq' ? 'English' : 'Shqip'}</button>
        </div>
        {!who ? (
          <>
            <h1>{t('Who are you?')}</h1>
            {err && <p className="pin-error">{err}</p>}
            <div className="names">
              {(users || []).map((u, i) => (
                <button key={u.id} className="name" onClick={() => { setWho(u); setErr(''); }}>
                  {kb && i < 9 && <kbd className="corner">{i + 1}</kbd>}<b>{u.name}</b><small>{t(u.role)}</small>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <h1>{who.name}</h1>
            <p className="muted">{t('Enter your PIN')}</p>
            <PinPad onDone={tryPin} error={err} busy={busy} len={who.role === 'manager' || who.role === 'owner' ? 6 : 4} />
            <button className="btn ghost" onClick={() => { setWho(null); setErr(''); }}>{t('Back')}</button>
          </>
        )}
      </div>
    </div>
  );
}

function MySession({ user }) {
  const [s, setS] = useState(null);
  useEffect(() => { get('/api/me/session').then(setS).catch(() => {}); }, []);
  if (!s) return <div className="page"><p className="muted">{t('Loading')}</p></div>;
  if (!s.day) return <div className="page"><p className="notice">{t('No business day is open. A manager has to open the day.')}</p></div>;
  const x = s.session;
  return (
    <div className="page narrow">
      <h1>{user.name}</h1>
      {!x ? <p className="muted">{t('No session yet. It starts with your first order.')}</p> : (
        <>
          <div className="bignum"><span>{t('Cash to hand over so far')}</span><b>{money(x.owed_cents)}</b></div>
          <dl className="facts">
            <div><dt>{t('Starting change')}</dt><dd>{money(x.float_cents)}</dd></div>
            <div><dt>{t('Cash sales')}</dt><dd>{money(x.cash_cents)}</dd></div>
            <div><dt>{t('Paid out')}</dt><dd>{money(x.payout_cents)}</dd></div>
            <div><dt>{t('On the house')}</dt><dd>{money(x.house_cents)}</dd></div>
            <div><dt>{t('Open tables')}</dt><dd>{x.open_tables.map((o) => o.table_name).join(', ') || '0'}</dd></div>
          </dl>
        </>
      )}
    </div>
  );
}

// For the owner and the manager only: the money so far today, always on screen, and who is holding it.
function CashStrip({ onDay }) {
  const [c, setC] = useState(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => get('/api/cash/live').then(setC).catch(() => {}), []);
  useEffect(() => { load(); const i = setInterval(load, 20000); return () => clearInterval(i); }, [load]);
  useEvents({ tables: load, day: load, hello: load });
  if (!c || !c.day) return null;
  return (
    <div className="cashstrip noprint">
      <button className="cash-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span><small>{t('Sales today')}</small><b>{money(c.sales_cents)}</b></span>
        <span><small>{t('Cash')}</small><b>{money(c.cash_cents)}</b></span>
        <span><small>{t('With staff')}</small><b>{money(c.with_staff_cents)}</b></span>
        <span><small>{t('Open tables')}</small><b>{c.open_tables} · {money(c.open_due_cents)}</b></span>
        <i>{open ? '▴' : '▾'}</i>
      </button>
      {open && (
        <div className="cash-open">
          <table className="grid">
            <thead><tr><th>{t('Staff')}</th><th className="r">{t('Cash sales')}</th><th className="r">{t('On the house')}</th><th className="r">{t('Owes')}</th><th className="r">{t('Handed over')}</th><th className="r">{t('Difference')}</th><th className="r">{t('Open tables')}</th></tr></thead>
            <tbody>
              {c.sessions.map((s) => (
                <tr key={s.id} className={s.settled ? 'done' : ''}><td><b>{s.user_name}</b> <small>{t(s.role)}</small></td>
                  <td className="r">{money(s.cash_cents)}</td><td className="r">{money(s.house_cents)}</td><td className="r"><b>{money(s.owed_cents)}</b></td>
                  <td className="r">{s.settled ? money(s.handed_cents) : ''}</td><td className={'r' + (s.difference_cents < 0 ? ' neg' : '')}>{s.settled ? money(s.difference_cents) : ''}</td><td className="r">{s.open_tables || ''}</td></tr>
              ))}
              {!c.sessions.length && <tr><td colSpan="7" className="muted">–</td></tr>}
            </tbody>
          </table>
          <div className="row between wrap">
            <span className="muted">{t('Paid out')}: {money(c.payout_cents)} · {t('On the house')}: {money(c.house_cents)} · {t('Handed over')}: {money(c.handed_cents)}</span>
            <button className="btn" onClick={() => { setOpen(false); onDay(); }}>{t('Settle')} ›</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Shell({ user, setUser, cafe }) {
  const boss = user.role === 'manager' || user.role === 'owner';
  const shelf = boss || user.role === 'bartender';
  // A click on the Windows stock notification opens the till on the stock screen.
  const [view, setView] = useState(() => (shelf && new URLSearchParams(window.location.search).get('stock') ? 'stock' : 'floor'));
  const [info, setInfo] = useState(null);
  const { toast } = useUi();
  const loadInfo = useCallback(() => get('/api/system/info').then(setInfo).catch(() => {}), []);
  useEffect(() => { loadInfo(); const i = setInterval(loadInfo, 30000); return () => clearInterval(i); }, [loadInfo]);

  const logout = useCallback(async () => { try { await post('/api/auth/logout'); } catch { /* offline: still leave the screen */ } setUser(null); }, [setUser]);

  // Shared PC: lock after a minute with no touch, mouse or key.
  const idleSec = info?.idle_lock_sec || 60;
  useEffect(() => {
    if (!isPc()) return undefined;
    let timer = setTimeout(logout, idleSec * 1000);
    const reset = () => { clearTimeout(timer); timer = setTimeout(logout, idleSec * 1000); };
    const evs = ['pointerdown', 'keydown', 'pointermove', 'wheel'];
    evs.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => { clearTimeout(timer); evs.forEach((e) => window.removeEventListener(e, reset)); };
  }, [idleSec, logout]);

  // From Manager > Tables: show the floor as a plan and start drawing it.
  const openPlan = () => { try { localStorage.setItem('floor_view', 'plan'); } catch { /* private window */ } window.__posStartDrawing = true; setView('floor'); };
  const app = { user, boss, isPc: isPc(), info, reloadInfo: loadInfo, logout, afterAction: () => {}, openPlan };   // after an order the user stays logged in, always
  useKeys((e) => {
    if (e.key === 'F12') { e.preventDefault(); logout(); return; }
    // Esc walks back one step at a time. From My session or Manager the step back is the tables screen,
    // which is home; the tables screen itself decides when Esc means log out.
    if (e.key === 'Escape' && view !== 'floor' && !modalsOpen() && !typingIn(e)) { e.preventDefault(); setView('floor'); return; }
    if (e.altKey && !e.ctrlKey && boss && ['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); setView({ 1: 'floor', 2: 'me', 3: 'manager', 4: 'stock' }[e.key]); }
  });
  const switchLang = async () => {
    const next = getLang() === 'sq' ? 'en' : 'sq';
    setLang(next);
    try { setUser(await put('/api/auth/language', { language: next })); } catch (e) { toast(errText(e), 'bad'); }
  };
  return (
    <div className="shell">
      <header className="bar">
        <strong className="brand">{cafe}</strong>
        <nav>
          {shelf && <button className={view === 'floor' ? 'on' : ''} onClick={() => setView('floor')}>{t('Tables')}</button>}
          {boss && <button className={view === 'me' ? 'on' : ''} onClick={() => setView('me')}>{t('My session')}</button>}
          {shelf && <button className={view === 'stock' ? 'on' : ''} onClick={() => setView('stock')}>{t('Stock')}</button>}
          {boss && <button className={view === 'manager' ? 'on' : ''} onClick={() => setView('manager')}>{t('Manager')}</button>}
        </nav>
        <div className="bar-end">
          {window.pos?.minimize && <button className="chip" onClick={() => window.pos.minimize()} title={t('Minimise')} aria-label={t('Minimise')}>▁</button>}
          <button className="chip" onClick={switchLang}>{getLang() === 'sq' ? 'EN' : 'SQ'}</button>
          <button className="chip who" onClick={logout} title={t('Log out')}><b>{user.name}</b><span>{isPc() ? t('Lock') : t('Log out')}</span></button>
        </div>
      </header>
      {boss && <CashStrip onDay={() => setView('manager')} />}
      {info?.clock_wrong && <div className="banner bad">{t('The PC clock is wrong. Fix it before taking orders.')}</div>}
      {info && !info.day_open && <div className="banner">{t('No business day is open. A manager has to open the day.')}</div>}
      {info?.catch_up && <div className="banner warn">{t('Catch up mode is on: orders are recorded without printing.')}</div>}
      {info && !info.printer.ok && info.printer.mode !== 'off' && <div className="banner bad">{t('Printer')}: {info.printer.error}</div>}
      <StockBanner app={app} onOpen={() => setView('stock')} />
      <main className="main">
        {view === 'floor' && <Floor app={app} />}
        {view === 'me' && boss && <MySession user={user} />}
        {view === 'manager' && boss && <Manager app={app} />}
        {view === 'stock' && shelf && <div className="page"><StockPage app={app} /></div>}
      </main>
    </div>
  );
}

function App() {
  const [state, setState] = useState({ loading: true });
  const [, force] = useState(0);
  const boot = useCallback(async () => {
    try {
      const [s, me] = await Promise.all([get('/api/setup/status'), get('/api/auth/me')]);
      if (me.user) setLang(me.user.language);
      setState({ loading: false, setup: s.needs_setup, cafe: s.cafe_name, user: me.user });
    } catch { setState({ loading: false, offline: true }); setTimeout(boot, 2500); }
  }, []);
  useEffect(() => { boot(); }, [boot]);
  // A login that ran out, or was ended from the owner's screen, lands back on the name list.
  useEffect(() => { const out = () => setState((s) => (s.user ? { ...s, user: null } : s)); window.addEventListener('pos-logged-out', out); return () => window.removeEventListener('pos-logged-out', out); }, []);
  const setUser = (user) => { if (user) setLang(user.language); setState((s) => ({ ...s, user, setup: false })); if (!user) boot(); };
  if (state.loading) return <div className="gate"><p className="muted">{t('Loading')}</p></div>;
  if (state.offline) return <div className="gate"><div className="gate-card"><h1>{t('No connection to the POS. Check the Wi-Fi.')}</h1></div></div>;
  if (state.setup) return <Setup onDone={(u) => { setUser(u); boot(); }} />;
  if (!state.user) return <Login cafe={state.cafe} onDone={setUser} onLang={() => { setLang(getLang() === 'sq' ? 'en' : 'sq'); force((x) => x + 1); }} />;
  return <Shell key={state.user.id + getLang()} user={state.user} setUser={setUser} cafe={state.cafe} />;
}

createRoot(document.getElementById('root')).render(<ErrorBoundary><UiProvider><App /></UiProvider></ErrorBoundary>);
