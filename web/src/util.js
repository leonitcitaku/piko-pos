import { ApiError, NetworkError } from './api.js';
import { t } from './i18n.js';

// The desktop application opens the POS with ?pc=1. That turns on shared PC behaviour:
// back to the name list after every Send or Pay, and after a minute idle.
const params = new URLSearchParams(location.search);
if (params.get('pc') === '1') sessionStorage.setItem('pc', '1');
if (params.get('pc') === '0') sessionStorage.removeItem('pc');
export const isPc = () => sessionStorage.getItem('pc') === '1';

export function errText(e) {
  if (e instanceof NetworkError) return t('No connection to the POS. Check the Wi-Fi.');
  if (e instanceof ApiError) {
    if (e.code === 'day_closed') return t('No business day is open. A manager has to open the day.');
    if (e.code === 'clock_wrong') return t('The PC clock is wrong. Fix it before taking orders.');
    if (e.code === 'locked') return t('Too many wrong PINs. Wait a minute.');
    if (e.code === 'wrong_pin') return t('Wrong PIN');
    if (e.code === 'owner_only') return t('Only the owner can change prices.');
    return e.message;
  }
  return String(e?.message || e);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs an action that may need a manager or owner PIN. Asks for the PIN only when the server says so.
export async function withApproval(ui, fn) {
  try { return await fn(undefined); }
  catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'need_approval') throw e;
    const pin = await ui.askPin(t('Manager or owner PIN'));
    if (pin == null) return null;
    return fn(pin);
  }
}
