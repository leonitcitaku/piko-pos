// Builds bar tickets. Text first (for the Tickets page and the file printer), then ESC/POS bytes.
const WIDTH = 32; // characters at normal size on 58 mm paper; 80 mm printers simply show wider margins

const TRANSLIT = { 'ë': 'e', 'Ë': 'E', 'ç': 'c', 'Ç': 'C' };
export const plain = (s) => String(s ?? '').replace(/[ëËçÇ]/g, (c) => TRANSLIT[c]).replace(/[^\x20-\x7E]/g, '?');

const hhmm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const TITLES = { order: 'POROSI', addition: 'SHTESE', cancel: '*** ANULIM ***', copy: 'POROSI', test: 'TEST' };

// 'big' lines print double width, so they only fit half as many characters as the rest.
const budget = (style) => (style === 'big' ? WIDTH / 2 : WIDTH);

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

// Returns a list of { text, style } lines. style: 'big' | 'bold' | 'center' | 'rule' | undefined
export function ticketLines(job) {
  const c = job.content, out = [];
  const push = (text, style, indent = '') => {
    const t = plain(text);
    if (style === 'rule') { out.push({ text: t, style }); return; }
    for (const line of wrapText(t, budget(style), indent)) out.push({ text: line, style });
  };
  // A reprint keeps its original kind (so a cancel stays a cancel) and carries the copy flag in its content.
  // Rows written before that change still have kind 'copy', which renders as a copy of an order.
  const isCopy = job.kind === 'copy' || c.copy === true;
  // Both languages, one per line: a 'big' line is double width, so it only fits 16 characters and
  // "*** VONESE / LATE ***" would wrap to a ragged orphan line on the paper.
  if (job.was_late) { push('*** VONESE ***', 'big'); push('*** LATE ***', 'big'); push('Derguar ne ' + hhmm(job.original_time), 'big'); }
  if (isCopy) { push('*** KOPJE ***', 'big'); push('*** COPY ***', 'big'); }
  push(TITLES[job.kind] || 'POROSI', 'center');
  if (job.kind === 'test') { push(c.cafe || 'Cafe', 'big'); push('Printeri punon', 'center'); push(hhmm(job.original_time), 'center'); return out; }
  push('TAVOLINA ' + c.table, 'big');
  push(`${c.zone} | ${c.waiter || ''} | ${hhmm(job.original_time)}`, 'center');
  push('', 'rule');
  for (const l of c.lines || []) {
    push(`${job.kind === 'cancel' ? 'ANULO ' : ''}${l.qty} x ${l.name}`, 'bold', '      ');
    for (const m of l.mods || []) push('   + ' + m, undefined, '     ');
    if (l.note) push('   ! ' + l.note, 'bold', '     ');
  }
  push('', 'rule');
  push('#' + job.id, 'center');
  return out;
}

export function ticketText(job) {
  return ticketLines(job).map((l) => {
    if (l.style === 'rule') return '-'.repeat(WIDTH);
    if (l.style === 'big' || l.style === 'center') {
      const pad = Math.max(0, Math.floor((WIDTH - l.text.length) / 2));
      return ' '.repeat(pad) + l.text;
    }
    return l.text;
  }).join('\n') + '\n';
}

const ESC = 0x1b, GS = 0x1d;
export function ticketBytes(job) {
  const parts = [Buffer.from([ESC, 0x40])]; // init
  for (const l of ticketLines(job)) {
    // Reset bold too, or a rule after a bold note line inherits it and prints heavy.
    if (l.style === 'rule') { parts.push(Buffer.from([ESC, 0x61, 0, GS, 0x21, 0x00, ESC, 0x45, 0]), Buffer.from('-'.repeat(WIDTH) + '\n', 'ascii')); continue; }
    const align = l.style === 'big' || l.style === 'center' ? 1 : 0;
    const size = l.style === 'big' ? 0x11 : 0x00;          // double width and height
    const bold = l.style === 'big' || l.style === 'bold' ? 1 : 0;
    parts.push(Buffer.from([ESC, 0x61, align, GS, 0x21, size, ESC, 0x45, bold]), Buffer.from(l.text + '\n', 'ascii'));
  }
  parts.push(Buffer.from([ESC, 0x61, 0, GS, 0x21, 0, ESC, 0x45, 0]), Buffer.from('\n\n\n\n', 'ascii'), Buffer.from([GS, 0x56, 0x42, 0x00])); // feed and cut
  return Buffer.concat(parts);
}
