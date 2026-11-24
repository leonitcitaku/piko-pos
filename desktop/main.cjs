// Cafe POS desktop application (Electron).
// It starts the POS server as its own process on the bundled Node, keeps it alive,
// shows Order mode and the manager area in a window, and lives in the tray when the window is closed.
// NOTE: written to plan but not yet run on Windows. See README, "What is tested and what is not".
const { app, BrowserWindow, Tray, Menu, Notification, clipboard, dialog, ipcMain, nativeImage, shell, powerSaveBlocker } = require('electron');
const { fork, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const packaged = app.isPackaged;
const appRoot = packaged ? path.join(process.resourcesPath, 'pos') : path.join(__dirname, '..');
const serverEntry = path.join(appRoot, 'server', 'src', 'index.js');
const bundledNode = path.join(process.resourcesPath || '', 'node', 'node.exe');
const nodePath = packaged && fs.existsSync(bundledNode) ? bundledNode : 'node';
const dataDir = process.platform === 'win32'
  ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'CafePOS')
  : path.join(app.getPath('userData'), 'data');

let win = null, tray = null, server = null, info = null, quitting = false, restarts = 0, fatal = null;

// A Windows notification from the server (low stock). Clicking it brings the till forward on the stock screen.
function notify(m) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: m.title || 'Cafe POS', body: m.body || '', silent: false });
  n.on('click', () => { showWindow(); if (win && info && m.path) win.loadURL(`http://localhost${info.port === 80 ? '' : ':' + info.port}${m.path}${m.path.includes('?') ? '&' : '?'}pc=1`); });
  n.show();
}

// A till draws text and buttons; it has no use for the graphics card. On older PCs and older Windows the
// accelerated path left the window open but empty (the "blank screen"), so everything is drawn in software.
app.disableHardwareAcceleration();

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

function startServer() {
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.openSync(path.join(dataDir, 'server.log'), 'a');
  server = fork(serverEntry, [], {
    execPath: nodePath, execArgv: ['--disable-warning=ExperimentalWarning'],
    env: { ...process.env, POS_DATA_DIR: dataDir, POS_WEB_DIR: path.join(appRoot, 'web', 'dist'), POS_VERSION: app.getVersion() },
    stdio: ['ignore', log, log, 'ipc'],
    windowsHide: true,   // no black console window for the server
  });
  server.on('message', (m) => {
    if (m && m.type === 'ready') { info = m; restarts = 0; refreshTray(); if (win) win.loadURL(localUrl()); else createWindow(); }
    if (m && m.type === 'fatal') { fatal = m; dialog.showMessageBox({ type: 'error', title: 'Cafe POS', message: 'Cafe POS cannot start', detail: m.message }).then(() => { quitting = true; app.quit(); }); }
    if (m && m.type === 'notify') notify(m);
  });
  server.on('exit', (code) => {
    server = null; info = null; refreshTray();
    if (quitting || fatal) return;
    restarts += 1;                                   // the server crashed: bring it back
    setTimeout(startServer, Math.min(1000 * restarts, 10000));
  });
}
const localUrl = () => `http://localhost${info.port === 80 ? '' : ':' + info.port}/?pc=1`;
const wifiUrl = () => (info && info.urls && info.urls[0]) || '';

function createWindow() {
  // The till owns the whole screen: no title bar, no borders, no menu. The ▁ button in the app minimises it,
  // F11 leaves and re-enters full screen, and quitting stays in the tray menu behind the manager PIN.
  win = new BrowserWindow({ width: 1366, height: 800, minWidth: 1000, minHeight: 640, frame: false, show: false, autoHideMenuBar: true,
    title: 'Cafe POS', backgroundColor: '#1f4d3a', webPreferences: { preload: path.join(__dirname, 'preload.cjs') } });
  win.once('ready-to-show', () => { win.show(); goFull(); });
  win.on('restore', goFull);
  win.loadURL(localUrl());
  // A blank window is never acceptable. If the page did not load (the server was still starting, or was
  // restarting), try again; if the page itself crashed, load it afresh.
  win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => { if (isMainFrame && code !== -3) setTimeout(() => { if (win && info) win.loadURL(localUrl()); }, 1200); });
  win.webContents.on('render-process-gone', () => setTimeout(() => { if (win && info) win.loadURL(localUrl()); }, 800));
  win.webContents.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'F11') { if (win.isFullScreen() || win.isKiosk()) { win.setKiosk(false); win.setFullScreen(false); } else goFull(); e.preventDefault(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // Closing the window must not stop the POS: phones would drop mid service. It goes to the tray instead.
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
}
// Cover the whole screen, taskbar included. Asking for full screen in the constructor of a frameless window
// left it one pixel short with the taskbar showing, so it is done after the window is up, and checked.
function goFull() {
  if (!win) return;
  win.setFullScreen(true);
  setTimeout(() => {
    if (!win || win.isMinimized()) return;
    const { screen } = require('electron');
    const d = screen.getDisplayMatching(win.getBounds()).bounds, b = win.getBounds();
    if (b.height < d.height || b.width < d.width) { win.setKiosk(true); }
  }, 700);
}
function showWindow() { if (!win) { if (info) createWindow(); return; } if (win.isMinimized()) win.restore(); win.show(); goFull(); win.focus(); }

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(info ? `Cafe POS: ${wifiUrl() || 'running'}` : 'Cafe POS: starting');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Cafe POS', click: showWindow },
    { label: info ? `Address for phones: ${wifiUrl()}` : 'Server is starting', enabled: false },
    { label: 'Copy address', enabled: !!info, click: () => clipboard.writeText(wifiUrl()) },
    { type: 'separator' },
    { label: 'Restart server', click: () => { if (server) server.kill(); else startServer(); } },
    { label: 'Open data folder', click: () => shell.openPath(dataDir) },
    { type: 'separator' },
    { label: 'Quit (needs manager PIN)', click: askQuit },
  ]));
}

// Quitting stops the POS for everyone, so it needs a manager or owner PIN.
function askQuit() {
  const w = new BrowserWindow({ width: 340, height: 230, resizable: false, minimizable: false, maximizable: false, autoHideMenuBar: true, parent: win || undefined, modal: !!win,
    title: 'Quit Cafe POS', webPreferences: { preload: path.join(__dirname, 'preload.cjs') } });
  w.loadFile(path.join(__dirname, 'quit.html'));
}
ipcMain.handle('win-minimise', () => { if (win) { if (win.isKiosk()) win.setKiosk(false); win.setFullScreen(false); win.minimize(); } });
// Start with the PC: on by default, and a switch in the System tab from then on. The choice is remembered,
// so an update or a restart never turns it back on behind the owner's back.
const autostartFile = () => path.join(app.getPath('userData'), 'autostart-chosen.json');
// ---------- keep this PC awake ----------
// A till that falls asleep takes every phone down with it. Two layers:
//  1. While the POS is open it asks Windows not to sleep from sitting idle. Automatic, changes no setting.
//  2. "Always on", a switch the owner turns on: sleep and hibernate set to never and the lid set to do nothing,
//     in the Windows power plan. Checked again at every start, in case something turned sleep back on.
//     What was there before is remembered, and turning the switch off puts it back.
const SLEEP_SETTINGS = [['SUB_SLEEP', 'STANDBYIDLE'], ['SUB_SLEEP', 'HIBERNATEIDLE'], ['SUB_BUTTONS', 'LIDACTION']];
const powerFile = () => path.join(app.getPath('userData'), 'always-on.json');
const powercfg = (args) => new Promise((resolve) => execFile('powercfg', args, { windowsHide: true, timeout: 15000 }, (err, out) => resolve(err ? '' : String(out))));
async function readSleep() {
  if (process.platform !== 'win32') return null;
  const out = {};
  for (const [sub, key] of SLEEP_SETTINGS) {
    const txt = await powercfg(['/query', 'SCHEME_CURRENT', sub, key]);
    const m = [...txt.matchAll(/Power Setting Index:\s*0x([0-9a-f]{8})/gi)].map((x) => parseInt(x[1], 16));
    if (m.length < 2) return null;                       // could not read this Windows: say so rather than guess
    out[key] = { ac: m[m.length - 2], dc: m[m.length - 1] };
  }
  return out;
}
const neverSleeps = (s) => !!s && SLEEP_SETTINGS.every(([, key]) => s[key].ac === 0 && s[key].dc === 0);
async function writeSleep(values) {
  for (const [sub, key] of SLEEP_SETTINGS) {
    await powercfg(['/setacvalueindex', 'SCHEME_CURRENT', sub, key, String(values[key].ac)]);
    await powercfg(['/setdcvalueindex', 'SCHEME_CURRENT', sub, key, String(values[key].dc)]);
  }
  await powercfg(['/setactive', 'SCHEME_CURRENT']);
}
const ZERO = Object.fromEntries(SLEEP_SETTINGS.map(([, key]) => [key, { ac: 0, dc: 0 }]));
const readChoice = () => { try { return JSON.parse(fs.readFileSync(powerFile(), 'utf8')); } catch { return { on: false }; } };
async function powerStatus() {
  const now = await readSleep(), choice = readChoice();
  return { supported: !!now, on: !!choice.on, awake: neverSleeps(now),
    sleep_ac_min: now ? Math.round(now.STANDBYIDLE.ac / 60) : null, sleep_dc_min: now ? Math.round(now.STANDBYIDLE.dc / 60) : null,
    lid_sleeps: now ? (now.LIDACTION.ac !== 0 || now.LIDACTION.dc !== 0) : null };
}
ipcMain.handle('power-get', () => powerStatus());
ipcMain.handle('power-set', async (_e, on) => {
  const now = await readSleep(), choice = readChoice();
  if (!now) return powerStatus();
  if (on) {
    const before = choice.on && choice.before ? choice.before : now;      // keep the very first "before", not our own zeros
    fs.writeFileSync(powerFile(), JSON.stringify({ on: true, before }));
    await writeSleep(ZERO);
  } else {
    if (choice.before) await writeSleep(choice.before);
    fs.writeFileSync(powerFile(), JSON.stringify({ on: false }));
  }
  return powerStatus();
});
// At every start: if the owner asked for always on and Windows has sleep enabled again, turn it back off.
async function enforceAlwaysOn() {
  try { if (readChoice().on && !neverSleeps(await readSleep())) await writeSleep(ZERO); } catch { /* never stop the POS over this */ }
}

ipcMain.handle('autostart-get', () => (packaged ? app.getLoginItemSettings().openAtLogin : false));
ipcMain.handle('autostart-set', (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on });
  try { fs.writeFileSync(autostartFile(), JSON.stringify({ on: !!on })); } catch { /* the setting itself still took */ }
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('quit-with-pin', async (_e, pin) => {
  if (!info) { quitting = true; app.quit(); return { ok: true }; }
  try {
    const res = await fetch(`http://localhost:${info.port}/api/system/check-boss-pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    if (!res.ok) return { ok: false, message: res.status === 429 ? 'Too many wrong PINs. Wait a minute.' : 'Wrong PIN' };
  } catch { /* server is down: allow quitting */ }
  quitting = true;
  if (server) server.kill();
  app.quit();
  return { ok: true };
});

app.whenReady().then(() => {
  if (packaged && !fs.existsSync(autostartFile())) app.setLoginItemSettings({ openAtLogin: true });   // start with Windows, until the owner says otherwise
  powerSaveBlocker.start('prevent-app-suspension');   // no idle sleep while the POS is open
  enforceAlwaysOn();
  const iconPath = path.join(__dirname, 'tray.png');
  tray = new Tray(fs.existsSync(iconPath) ? iconPath : nativeImage.createEmpty());
  tray.on('click', showWindow);
  refreshTray();
  startServer();
});
app.on('window-all-closed', () => { /* stay alive in the tray */ });
app.on('before-quit', (e) => { if (!quitting) { e.preventDefault(); askQuit(); } });
process.on('exit', () => { if (server) server.kill(); });
