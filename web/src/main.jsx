import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { get, post, put, ApiError, NetworkError, money } from './api.js';
import { t, setLang, getLang } from './i18n.js';
import { UiProvider, PinPad, useUi } from './ui.jsx';
import { Floor } from './Floor.jsx';
import { Manager } from './Manager.jsx';
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
        <label className="field"><span>{t('PIN (4 to 6 digits)')}</span><input value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })} inputMode="numeric" type="password" required minLength={4} /></label>
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
              {(users || []).map((u) => (
                <button key={u.id} className="name" onClick={() => { setWho(u); setErr(''); }}>
                  <b>{u.name}</b><small>{t(u.role)}</small>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <h1>{who.name}</h1>
            <p className="muted">{t('Enter your PIN')}</p>
            <PinPad onDone={tryPin} error={err} busy={busy} />
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

function Shell({ user, setUser, cafe }) {
  const boss = user.role === 'manager' || user.role === 'owner';
  const [view, setView] = useState('floor');
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

  const app = { user, boss, isPc: isPc(), info, reloadInfo: loadInfo, afterAction: () => { if (isPc()) setTimeout(logout, 900); } };
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
          <button className={view === 'floor' ? 'on' : ''} onClick={() => setView('floor')}>{t('Tables')}</button>
          <button className={view === 'me' ? 'on' : ''} onClick={() => setView('me')}>{t('My session')}</button>
          {boss && <button className={view === 'manager' ? 'on' : ''} onClick={() => setView('manager')}>{t('Manager')}</button>}
        </nav>
        <div className="bar-end">
          <button className="chip" onClick={switchLang}>{getLang() === 'sq' ? 'EN' : 'SQ'}</button>
          <button className="chip who" onClick={logout} title={t('Log out')}><b>{user.name}</b><span>{isPc() ? t('Lock') : t('Log out')}</span></button>
        </div>
      </header>
      {info?.clock_wrong && <div className="banner bad">{t('The PC clock is wrong. Fix it before taking orders.')}</div>}
      {info && !info.day_open && <div className="banner">{t('No business day is open. A manager has to open the day.')}</div>}
      {info?.catch_up && <div className="banner warn">{t('Catch up mode is on: orders are recorded without printing.')}</div>}
      {info && !info.printer.ok && info.printer.mode !== 'off' && <div className="banner bad">{t('Printer')}: {info.printer.error}</div>}
      <main className="main">
        {view === 'floor' && <Floor app={app} />}
        {view === 'me' && <MySession user={user} />}
        {view === 'manager' && boss && <Manager app={app} />}
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
  const setUser = (user) => { if (user) setLang(user.language); setState((s) => ({ ...s, user, setup: false })); if (!user) boot(); };
  if (state.loading) return <div className="gate"><p className="muted">{t('Loading')}</p></div>;
  if (state.offline) return <div className="gate"><div className="gate-card"><h1>{t('No connection to the POS. Check the Wi-Fi.')}</h1></div></div>;
  if (state.setup) return <Setup onDone={(u) => { setUser(u); boot(); }} />;
  if (!state.user) return <Login cafe={state.cafe} onDone={setUser} onLang={() => { setLang(getLang() === 'sq' ? 'en' : 'sq'); force((x) => x + 1); }} />;
  return <Shell key={state.user.id + getLang()} user={state.user} setUser={setUser} cafe={state.cafe} />;
}

createRoot(document.getElementById('root')).render(<UiProvider><App /></UiProvider>);
