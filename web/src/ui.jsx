import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { t } from './i18n.js';

const Ctx = createContext(null);
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
  return (
    <Ctx.Provider value={{ toast, askPin }}>
      {children}
      <div className="toasts" aria-live="polite">{toasts.map((x) => <div key={x.id} className={'toast ' + x.kind}>{x.text}</div>)}</div>
      {pinAsk && (
        <Modal title={pinAsk.title} onClose={() => { pinAsk.resolve(null); setPinAsk(null); }}>
          <PinPad onDone={(pin) => { pinAsk.resolve(pin); setPinAsk(null); }} />
        </Modal>
      )}
    </Ctx.Provider>
  );
}

export function Modal({ title, children, onClose, wide }) {
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose?.(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
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
      <div className={'pin-dots' + (error ? ' shake' : '')} aria-label="PIN">{[0, 1, 2, 3, 4, 5].map((i) => <span key={i} className={i < pin.length ? 'on' : ''} />)}</div>
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
