// Builds bar tickets. Text first (for the Tickets page and the file printer), then ESC/POS bytes.
const DEFAULT_WIDTH = 32; // characters at normal size on 58 mm paper. 80 mm paper fits 48.

const TRANSLIT = { 'ë': 'e', 'Ë': 'E', 'ç': 'c', 'Ç': 'C' };
export const plain = (s) => String(s ?? '').replace(/[ëËçÇ]/g, (c) => TRANSLIT[c]).replace(/[^\x20-\x7E]/g, '?');

const hhmm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const TITLES = { order: 'POROSI', addition: 'SHTESE', cancel: '*** ANULIM ***', copy: 'POROSI', test: 'TEST', shift: 'RAPORTI I NDERRIMIT',
  stock: '*** STOKU I ULET ***', stock_list: 'LISTA E BLERJES' };
const eur = (c) => ((c || 0) / 100).toFixed(2) + ' EUR';
const hhmmDay = (ms) => { const d = new Date(ms); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hhmm(ms)}`; };

// 'big' and 'item' lines print double width, so they only fit half as many characters as the rest.
const budget = (style, width) => (style === 'big' || style === 'item' ? Math.floor(width / 2) : width);

// Word aware wrapping. Keeps the leading spaces of the first line, puts `indent` in front of the
// continuation lines so the bartender sees one item and not two, and hard splits a word that is too long.
export function wrapText(text, width, indent = '') {
  const s = String(text ?? '');
  if (!s.trim()) return [s];
  const lead = /^\s*/.exec(s)[0];
  const words = s.trim().split(/\s+/);
  const out = [];
  let prefix = lead, cur = '';
  const room = () => Math.max(1, width - prefix.length);
  const flush = () => { out.push(prefix + cur); cur = ''; prefix = indent; };
  for (const word of words) {
    let w = word;
    if (cur && cur.length + 1 + w.length <= room()) { cur += ' ' + w; continue; }
    if (cur) flush();
    while (w.length > room()) { cur = w.slice(0, room()); w = w.slice(room()); flush(); }
    cur = w;
  }
  if (cur) flush();
  if (!out.length) out.push(lead);
  return out;
}

// Returns a list of { text, style } lines. style: 'big' | 'item' | 'bold' | 'center' | 'rule' | undefined
// 'item' is as big as 'big' (double width and height) but stays on the left, for the bartender to read from a distance.
export function ticketLines(job, width = DEFAULT_WIDTH) {
  const c = job.content, out = [];
  const push = (text, style, indent = '') => {
    const t = plain(text);
    if (style === 'rule') { out.push({ text: t, style }); return; }
    for (const line of wrapText(t, budget(style, width), indent)) out.push({ text: line, style });
  };
  // A reprint keeps its original kind (so a cancel stays a cancel) and carries the copy flag in its content.
  // Rows written before that change still have kind 'copy', which renders as a copy of an order.
  const isCopy = job.kind === 'copy' || c.copy === true;
  // Both languages, one per line: a 'big' line is double width, so it only fits 16 characters and
  // "*** VONESE / LATE ***" would wrap to a ragged orphan line on the paper.
  if (job.was_late) { push('*** VONESE ***', 'big'); push('*** LATE ***', 'big'); push('Derguar ne ' + hhmm(job.original_time), 'big'); }
  if (isCopy) { push('*** KOPJE ***', 'big'); push('*** COPY ***', 'big'); }
  // A cancel must never pass for an order: its title is as big as the items, top and bottom.
  push(TITLES[job.kind] || 'POROSI', job.kind === 'cancel' ? 'big' : 'center');
  // The slip a waiter is settled with: what they started with, what they took, what they hand in.
  if (job.kind === 'shift') {
    // Label on the left, amount on the right. Added as is: the word wrapper would squeeze the gap out.
    const row = (label, value) => out.push({ text: plain(label + ' '.repeat(Math.max(1, width - label.length - value.length)) + value), style: undefined });
    push(c.cafe || 'Cafe', 'center');
    push(c.user || '', 'big');
    push(`${hhmmDay(c.started_at)} - ${hhmmDay(c.settled_at || job.original_time)}`, 'center');
    push('', 'rule');
    row('Para fillestare', eur(c.float_cents));
    row('Shitje kesh', eur(c.cash_cents));
    if (c.payout_cents) row('Pagesa nga arka', '-' + eur(c.payout_cents));
    push('', 'rule');
    push('PER DOREZIM', 'center');
    push(eur(c.owed_cents), 'big');
    if (c.settled_at) {
      push('', 'rule');
      row('Dorezoi', eur(c.handed_cents));
      row('Diferenca', (c.difference_cents > 0 ? '+' : '') + eur(c.difference_cents));
      if (c.confirmed_by) row('Pranoi', c.confirmed_by);
    }
    push('', 'rule');
    if (c.house_cents) row('Nga shtepia', eur(c.house_cents));
    row('Tavolina te paguara', String(c.tables_paid || 0));
    if ((c.open_tables || []).length) push('TAVOLINA TE HAPURA: ' + c.open_tables.join(', '), 'bold');
    if (!c.settled_at) { push(''); push('Nenshkrimi: ______________'); }
    push('#' + job.id, 'center');
    return out;
  }
  // A stock warning: which items are low or gone and what is left of them.
  if (job.kind === 'stock') {
    push(c.cafe || 'Cafe', 'center');
    push(hhmmDay(job.original_time), 'center');
    push('', 'rule');
    for (const l of c.lines || []) { push((l.level === 'out' ? 'MBAROI: ' : 'PAK: ') + l.name, 'bold', '  '); push('  Ka: ' + l.text, undefined, '  '); }
    push('', 'rule');
    push('#' + job.id, 'center');
    return out;
  }
  // What to buy: everything under its level, how much is left and how many packs bring it back to full.
  if (job.kind === 'stock_list') {
    push(c.cafe || 'Cafe', 'center');
    push(hhmmDay(job.original_time), 'center');
    push('', 'rule');
    if (!(c.lines || []).length) push('Asgje per te blere', 'center');
    for (const l of c.lines || []) { push(`[ ] ${l.buy_text}  ${l.name}`, 'bold', '    '); push('    Ka: ' + l.text, undefined, '    '); }
    push('', 'rule');
    push('#' + job.id, 'center');
    return out;
  }
  if (job.kind === 'test') { push(c.cafe || 'Cafe', 'big'); push('Printeri punon', 'center'); push(hhmm(job.original_time), 'center'); return out; }
  push('TAVOLINA ' + c.table, 'big');
  push(`${c.zone} | ${c.waiter || ''} | ${hhmm(job.original_time)}`, 'center');
  push('', 'rule');
  for (const l of c.lines || []) {
    // Items are big. On a cancel ticket the count carries a minus, so "-2 x Espresso" still fits one big line.
    push(`${job.kind === 'cancel' ? '-' : ''}${l.qty} x ${l.name}`, 'item', '    ');
    for (const m of l.mods || []) push('   + ' + m, undefined, '     ');
    if (l.note) push('   ! ' + l.note, 'bold', '     ');
  }
  push('', 'rule');
  if (job.kind === 'cancel') push(TITLES.cancel, 'big');
  push('#' + job.id, 'center');
  return out;
}

export function ticketText(job, width = DEFAULT_WIDTH) {
  return ticketLines(job, width).map((l) => {
    if (l.style === 'rule') return '-'.repeat(width);
    if (l.style === 'big' || l.style === 'center') {
      const pad = Math.max(0, Math.floor((width - l.text.length) / 2));
      return ' '.repeat(pad) + l.text;
    }
    return l.text;
  }).join('\n') + '\n';
}

const ESC = 0x1b, GS = 0x1d;
export function ticketBytes(job, width = DEFAULT_WIDTH) {
  const parts = [Buffer.from([ESC, 0x40])]; // init
  for (const l of ticketLines(job, width)) {
    // Reset bold too, or a rule after a bold note line inherits it and prints heavy.
    if (l.style === 'rule') { parts.push(Buffer.from([ESC, 0x61, 0, GS, 0x21, 0x00, ESC, 0x45, 0]), Buffer.from('-'.repeat(width) + '\n', 'ascii')); continue; }
    const align = l.style === 'big' || l.style === 'center' ? 1 : 0;
    const size = l.style === 'big' || l.style === 'item' ? 0x11 : 0x00;          // double width and height
    const bold = l.style === 'big' || l.style === 'item' || l.style === 'bold' ? 1 : 0;
    parts.push(Buffer.from([ESC, 0x61, align, GS, 0x21, size, ESC, 0x45, bold]), Buffer.from(l.text + '\n', 'ascii'));
  }
  parts.push(Buffer.from([ESC, 0x61, 0, GS, 0x21, 0, ESC, 0x45, 0]), Buffer.from('\n\n\n\n', 'ascii'), Buffer.from([GS, 0x56, 0x42, 0x00])); // feed and cut
  return Buffer.concat(parts);
}
