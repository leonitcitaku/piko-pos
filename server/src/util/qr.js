// Small QR code generator (byte mode, error correction level M, versions 1 to 6). No dependencies.
import { bad } from '../http.js';
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
function generator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) { const next = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); } g = next; }
  return g;
}
function rs(data, n) {
  const gen = generator(n), rem = new Array(n).fill(0);
  for (const b of data) { const f = b ^ rem.shift(); rem.push(0); for (let j = 0; j < n; j++) rem[j] ^= mul(gen[j + 1], f); }
  return rem;
}
// version: [total codewords, error correction codewords per block, blocks]
const V = { 1: [26, 10, 1], 2: [44, 16, 1], 3: [70, 26, 1], 4: [100, 18, 2], 5: [134, 24, 2], 6: [172, 16, 4] };
const MASKS = [(r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0];

export function qrMatrix(text) {
  const bytes = [...Buffer.from(text, 'utf8')];
  let ver = 0;
  for (let v = 1; v <= 6; v++) { const [tot, ec, bl] = V[v]; if (bytes.length <= tot - ec * bl - 2) { ver = v; break; } }
  if (!ver) throw bad('qr_too_long', 'Text too long for QR');
  const [total, ecLen, blocks] = V[ver], dataLen = total - ecLen * blocks;
  const bits = [];
  const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4); put(bytes.length, 8); bytes.forEach((b) => put(b, 8));
  for (let i = 0; i < 4 && bits.length < dataLen * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let i = 0; data.length < dataLen; i++) data.push(i % 2 ? 0x11 : 0xec);
  const per = dataLen / blocks, dBlocks = [], eBlocks = [];
  for (let b = 0; b < blocks; b++) { const d = data.slice(b * per, (b + 1) * per); dBlocks.push(d); eBlocks.push(rs(d, ecLen)); }
  const code = [];
  for (let i = 0; i < per; i++) for (const d of dBlocks) code.push(d[i]);
  for (let i = 0; i < ecLen; i++) for (const e of eBlocks) code.push(e[i]);

  const size = 17 + 4 * ver;
  const m = Array.from({ length: size }, () => new Array(size).fill(0));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, v) => { if (r >= 0 && c >= 0 && r < size && c < size) { m[r][c] = v ? 1 : 0; fn[r][c] = true; } };
  const finder = (r0, c0) => { for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
    const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
    const dark = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
    set(r0 + r, c0 + c, dark); } };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  if (ver >= 2) { const p = size - 7; for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) set(p + r, p + c, Math.max(Math.abs(r), Math.abs(c)) !== 1); }
  // reserve format areas
  for (let i = 0; i <= 8; i++) { if (!fn[8][i]) set(8, i, 0); if (!fn[i][8]) set(i, 8, 0); }
  for (let i = 0; i < 8; i++) { set(8, size - 1 - i, 0); set(size - 1 - i, 8, 0); }
  set(size - 8, 8, 1);
  // place data
  const stream = []; code.forEach((b) => { for (let i = 7; i >= 0; i--) stream.push((b >>> i) & 1); });
  let k = 0, up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const r = up ? size - 1 - i : i;
      for (const c of [col, col - 1]) if (!fn[r][c]) { m[r][c] = k < stream.length ? stream[k] : 0; k++; }
    }
    up = !up;
  }
  const build = (mask) => {
    const g = m.map((row) => row.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fn[r][c] && MASKS[mask](r, c)) g[r][c] ^= 1;
    const d = mask; let rem = d; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((d << 10) | rem) ^ 0x5412; const bit = (i) => (f >>> i) & 1;
    for (let i = 0; i <= 5; i++) g[i][8] = bit(i);
    g[7][8] = bit(6); g[8][8] = bit(7); g[8][7] = bit(8);
    for (let i = 9; i < 15; i++) g[8][14 - i] = bit(i);
    for (let i = 0; i < 8; i++) g[8][size - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) g[size - 15 + i][8] = bit(i);
    g[size - 8][8] = 1;
    return g;
  };
  const penalty = (g) => {
    let p = 0;
    for (let r = 0; r < size; r++) for (const line of [g[r], g.map((row) => row[r])]) {
      let run = 1; for (let i = 1; i < size; i++) { if (line[i] === line[i - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; }
    }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) if (g[r][c] === g[r][c + 1] && g[r][c] === g[r + 1][c] && g[r][c] === g[r + 1][c + 1]) p += 3;
    return p;
  };
  let best = null, bestP = Infinity;
  for (let mk = 0; mk < 8; mk++) { const g = build(mk), p = penalty(g); if (p < bestP) { best = g; bestP = p; } }
  return best;
}

export function qrSvg(text, scale = 8, quiet = 4) {
  const g = qrMatrix(text), n = g.length, dim = (n + quiet * 2) * scale;
  let path = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (g[r][c]) path += `M${(c + quiet) * scale},${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
