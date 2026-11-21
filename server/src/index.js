import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from './db.js';
import { createRouter, HttpError, readBody, parseCookies, sendJson } from './http.js';
import { userFromToken } from './auth.js';
import { registerRoutes, lanUrls } from './routes.js';
import { startQueue, stopQueue } from './print/queue.js';
import { runBackup } from './services/backup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.map': 'application/json' };

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onErr); resolve(server.address().port); };
    server.once('error', onErr); server.once('listening', onOk);
    server.listen(port, '0.0.0.0');
  });
}

export async function start(opts = {}) {
  const dataDir = opts.dataDir || process.env.POS_DATA_DIR || path.join(root, 'data');
  const webDir = opts.webDir || process.env.POS_WEB_DIR || path.join(root, 'web', 'dist');
  openDb(dataDir);
  const cfg = { version: VERSION, port: 0, test: !!(opts.test || process.env.POS_TEST) };
  const router = createRouter();
  registerRoutes(router, cfg);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return serveStatic(res, url.pathname);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.code, message: e.message, ...(e.extra || {}) });
      console.error(e);
      sendJson(res, 500, { error: 'server_error', message: String(e.message || e) });
    }
  });

  async function api(req, res, url) {
    const m = router.match(req.method, url.pathname);
    if (!m) throw new HttpError(404, 'not_found');
    const token = parseCookies(req).pos_token || null;
    const user = userFromToken(token);
    if (!m.opts.public) {
      if (!user) throw new HttpError(401, 'not_logged_in');
      if (m.opts.roles && !m.opts.roles.includes(user.role)) throw new HttpError(403, 'forbidden', 'Your role cannot do this');
    }
    const body = req.method === 'GET' ? {} : await readBody(req);
    const ctx = { req, res, params: m.params, query: Object.fromEntries(url.searchParams), body, user, token,
      device: (req.socket.remoteAddress || '?').replace('::ffff:', '') };
    const out = await m.handler(ctx);
    if (out && out.__stream) return;
    const headers = ctx.setCookie ? { 'Set-Cookie': ctx.setCookie } : {};
    if (out && out.__raw != null) {
      res.writeHead(200, { 'Content-Type': out.type, 'Cache-Control': 'no-store', ...(out.filename ? { 'Content-Disposition': `attachment; filename="${out.filename}"` } : {}), ...headers });
      return res.end(out.__raw);
    }
    sendJson(res, 200, out ?? { ok: true }, headers);
  }

  function serveStatic(res, pathname) {
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    let file = path.join(webDir, rel);
    if (file !== webDir && !file.startsWith(webDir + path.sep)) throw new HttpError(403, 'forbidden');
    if (!rel || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(webDir, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('Cafe POS server is running. The web app is not built yet: run "npm run build:web".'); }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  }

  // Port 80 first so the address needs no number. If it is taken, fall back to 8080.
  const wanted = opts.port ?? (process.env.POS_PORT ? Number(process.env.POS_PORT) : process.argv.includes('--dev') ? 8080 : null);
  if (wanted != null) cfg.port = await listen(server, wanted);
  else { try { cfg.port = await listen(server, 80); } catch { cfg.port = await listen(server, 8080); } }

  startQueue(opts.queueIntervalMs);
  if (!opts.noStartupBackup) runBackup('startup').catch((e) => console.error('Startup backup failed:', e.message));

  return {
    port: cfg.port, server, urls: lanUrls(cfg.port),
    async close() { stopQueue(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); closeDb(); },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().then((s) => {
    console.log(`Cafe POS ${VERSION} running`);
    console.log(`On this PC:   http://localhost${s.port === 80 ? '' : ':' + s.port}`);
    for (const u of s.urls) console.log(`On the Wi-Fi: ${u}`);
    if (process.send) process.send({ type: 'ready', port: s.port, urls: s.urls });
  }).catch((e) => { console.error('Could not start:', e); process.exit(1); });
}
