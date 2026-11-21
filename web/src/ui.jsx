import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { t } from './i18n.js';

const Ctx = createContext(null);

// ---------------------------------------------------------------- keyboard
// One rule for the whole app: function keys and Esc always work; letters, digits and Enter only act when
// nobody is typing in a box, and only for the screen in front. A dialog in front owns the keyboard.
let modalDepth = 0;
export const modalsOpen = () => modalDepth;
export const typingIn = (e) => { const el = e.target; return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable); };
export const hasKeyboard = () => { try { return matchMedia('(pointer: fine)').matches; } catch { return false; } };
// Listen to keys while a screen is mounted. The handler always sees the latest state.
export function useKeys(handler, active = true) {
  const ref = useRef(handler); ref.current = handler;
  useEffect(() => {
    if (!active) return undefined;
    const k = (e) => ref.current(e);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [active]);
}
export const useUi = () => useContext(Ctx);

export function UiProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [pinAsk, setPinAsk] = useState(null);
  const toast = useCallback((text, kind = 'ok', ms = 2600) => {
    const id = Math.random();
    setToasts((x) => [...x, { id, text, kind }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), kind === 'bad' ? 6000 : ms);
  }, []);
  // Ask for a PIN on the spot. Resolves with the PIN, or null if cancelled.
  const askPin = useCallback((title) => new Promise((resolve) => setPinAsk({ title, resolve })), []);
  const [help, setHelp] = useState(false);
  useKeys((e) => {
    if (e.key === 'F1' || (e.key === '?' && !typingIn(e))) { e.preventDefault(); setHelp((h) => !h); }
  });
  return (
    <Ctx.Provider value={{ toast, askPin }}>
      {children}
      <div className="toasts" aria-live="polite">{toasts.map((x) => <div key={x.id} className={'toast ' + x.kind}>{x.text}</div>)}</div>
      {pinAsk && (
        <Modal title={pinAsk.title} onClose={() => { pinAsk.resolve(null); setPinAsk(null); }}>
          <PinPad onDone={(pin) => { pinAsk.resolve(pin); setPinAsk(null); }} />
        </Modal>
      )}
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
    </Ctx.Provider>
  );
}

export function Modal({ title, children, onClose, wide }) {
  // Each dialog remembers how deep it opened, once. Only the one on top answers Esc.
  const mine = useRef(0);
  useEffect(() => { modalDepth++; mine.current = modalDepth; return () => { modalDepth--; }; }, []);
  // Esc closes only the dialog on top, not every dialog under it.
  useEffect(() => { const k = (e) => { if (e.key === 'Escape' && mine.current === modalDepth) { e.stopImmediatePropagation(); onClose?.(); } }; window.addEventListener('keydown', k, true); return () => window.removeEventListener('keydown', k, true); }, [onClose]);
  return (
    <div className="veil" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={'sheet' + (wide ? ' wide' : '')} role="dialog" aria-label={title}>
        <header className="sheet-head"><h2>{title}</h2>{onClose && <button className="btn ghost" onClick={onClose}>{t('Close')}</button>}</header>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

// The pad's buttons never take keyboard focus, so a key press cannot land on one of them.
const noFocus = { tabIndex: -1, onMouseDown: (e) => e.preventDefault() };

// len: how long this PIN must be. 4 for staff, 6 for a manager or owner (and so for every approval).
export function PinPad({ onDone, error, busy, len = 6 }) {
  const [pin, setPin] = useState('');
  const ref = useRef(pin); ref.current = pin;
  const press = (d) => setPin((p) => (p.length < 6 ? p + d : p));
  const submit = () => { if (ref.current.length >= 4) { onDone(ref.current); setPin(''); } };
  // PIN lengths are exact, so a complete PIN sends itself. OK stays for PINs set before that rule.
  useEffect(() => { if (pin.length === len && !busy) submit(); }, [pin]);
  useEffect(() => {
    // Enter and Space must not also "click" whichever digit button was touched last: that typed an extra digit.
    const k = (e) => { if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1)); else if (e.key === 'Enter') { e.preventDefault(); submit(); } else if (e.key === ' ') e.preventDefault(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);
  return (
    <div className="pinpad">
      <div className={'pin-dots' + (error ? ' shake' : '')} aria-label="PIN">{Array.from({ length: len }, (_, i) => <span key={i} className={i < pin.length ? 'on' : ''} />)}</div>
      {error && <p className="pin-error">{error}</p>}
      <div className="keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} {...noFocus} onClick={() => press(d)}>{d}</button>)}
        <button className="quiet" {...noFocus} onClick={() => setPin((p) => p.slice(0, -1))} aria-label="delete">⌫</button>
        <button {...noFocus} onClick={() => press('0')}>0</button>
        <button className="go" {...noFocus} disabled={pin.length < 4 || busy} onClick={submit}>OK</button>
      </div>
    </div>
  );
}

export function Stepper({ value, min = 0, max = 99, onChange }) {
  return (
    <div className="stepper">
      <button onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label="less">−</button>
      <output>{value}</output>
      <button onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label="more">+</button>
    </div>
  );
}

export const Field = ({ label, children }) => <label className="field"><span>{label}</span>{children}</label>;

// If any screen throws while drawing, show what happened and a way back, never a blank page.
export class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('Screen crashed:', error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="gate"><div className="gate-card">
        <h1>{t('Something went wrong on this screen.')}</h1>
        <p className="muted">{String(this.state.error?.message || this.state.error)}</p>
        <button className="btn primary big" onClick={() => location.reload()}>{t('Reload')}</button>
      </div></div>
    );
  }
}

// F1 anywhere, or ? when not typing: every shortcut on one screen.
const KEYS = [
  ['Everywhere', [['F1', 'This list of shortcuts'], ['Esc', 'Go back one step. On the tables screen with nothing open, log out'], ['F12', 'Lock the screen'], ['Alt 1 / 2 / 3', 'Tables, My session, Manager']]],
  ['Login', [['1 to 9', 'Pick the person with that number'], ['0 to 9', 'Type the PIN, it logs in by itself'], ['Esc', 'Back to the names']]],
  ['Tables', [['Table name, then Enter', 'Open that table'], ['Page Up / Page Down', 'Next or previous area'], ['F3', 'Switch between grid and plan']]],
  ['Order', [['Letters', 'Find a drink by name'], ['Arrow up / down', 'Choose in the list found'], ['Enter', 'Add the drink found, or send to the bar'], ['0 to 9', 'How many of the next drink'], ['+ / -', 'One more or one less of the last drink'], ['Delete', 'Remove the last drink'], ['F2', 'Take payment'], ['F4', 'More: move, merge, discount, reprint']]],
  ['Payment', [['0 to 9', 'Cash received'], ['Enter', 'Paid in cash'], ['F8', 'On the house']]],
];
function ShortcutHelp({ onClose }) {
  return (
    <Modal title={t('Keyboard shortcuts')} onClose={onClose} wide>
      <div className="keyhelp">{KEYS.map(([group, rows]) => (
        <section key={group}><h3>{t(group)}</h3>
          <dl>{rows.map(([k, what]) => <div key={k}><dt><kbd>{t(k)}</kbd></dt><dd>{t(what)}</dd></div>)}</dl>
        </section>
      ))}</div>
    </Modal>
  );
}
