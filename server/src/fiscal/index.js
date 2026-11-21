import { get, run, getSetting } from '../db.js';

// Fiscal output is switched off in version 1. This is the one place a real driver plugs in later.
// A driver gets the paid order and returns { receipt_no }. If it throws, the sale still stands
// and the order is marked 'waiting' so it can be sent again. A fiscal problem never blocks service.
const drivers = {
  off: null,
  // printer: { issue(order) { ... } },
  // software: { issue(order) { ... } },
};

export function fiscalOrderPaid(orderId) {
  const driver = drivers[getSetting('fiscal_mode', 'off')];
  if (!driver) return;
  try {
    const order = get('SELECT * FROM orders WHERE id = ?', orderId);
    const res = driver.issue(order);
    run("UPDATE orders SET fiscal_status = 'issued', fiscal_receipt_no = ? WHERE id = ?", res?.receipt_no ?? null, orderId);
  } catch {
    run("UPDATE orders SET fiscal_status = 'waiting' WHERE id = ?", orderId);
  }
}
