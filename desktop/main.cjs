// Cafe POS desktop application (Electron).
// It starts the POS server as its own process on the bundled Node, keeps it alive,
// shows Order mode and the manager area in a window, and lives in the tray when the window is closed.
// NOTE: written to plan but not yet run on Windows. See README, "What is tested and what is not".
const { app, BrowserWindow, Tray, Menu, clipboard, dialog, ipcMain, nativeImage, shell } = require('electron');
const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const packaged = app.isPackaged;
const appRoot = packaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..');
const serverEntry = path.join(appRoot, 'server', 'src', 'index.js');
const bundledNode = path.join(process.resourcesPath || '', 'node', 'node.exe');
const nodePath = packaged && fs.existsSync(bundledNode) ? bundledNode : 'node';
const dataDir = process.platform === 'win32'
  ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'CafePOS')
  : path.join(app.getPath('userData'), 'data');

let win = null, tray = null, server = null, info = null, quitting = false, restarts = 0;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

function startServer() {
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.openSync(path.join(dataDir, 'server.log'), 'a');
  server = fork(serverEntry, [], {
    execPath: nodePath, execArgv: ['--disable-warning=ExperimentalWarning'],
    env: { ...process.env, POS_DATA_DIR: dataDir, POS_WEB_DIR: path.join(appRoot, 'web', 'dist') },
    stdio: ['ignore', log, log, 'ipc'],
  });
  server.on('message', (m) => {
    if (m && m.type === 'ready') { info = m; restarts = 0; refreshTray(); if (win) win.loadURL(localUrl()); else createWindow(); }
  });
  server.on('exit', (code) => {
    server = null; info = null; refreshTray();
    if (quitting) return;
    restarts += 1;                                   // the server crashed: bring it back
    setTimeout(startServer, Math.min(1000 * restarts, 10000));
  });
}
const localUrl = () => `http://localhost${info.port === 80 ? '' : ':' + info.port}/?pc=1`;
const wifiUrl = () => (info && info.urls && info.urls[0]) || '';

function createWindow() {
  win = new BrowserWindow({ width: 1366, height: 800, minWidth: 1000, minHeight: 640, autoHideMenuBar: true, title: 'Cafe POS', backgroundColor: '#1f4d3a' });
  win.loadURL(localUrl());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // Closing the window must not stop the POS: phones would drop mid service. It goes to the tray instead.
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
}
function showWindow() { if (!win) { if (info) createWindow(); return; } win.show(); win.focus(); }

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
  if (packaged) app.setLoginItemSettings({ openAtLogin: true });   // start with Windows
  const iconPath = path.join(__dirname, 'tray.png');
  tray = new Tray(fs.existsSync(iconPath) ? iconPath : nativeImage.createEmpty());
  tray.on('click', showWindow);
  refreshTray();
  startServer();
});
app.on('window-all-closed', () => { /* stay alive in the tray */ });
app.on('before-quit', (e) => { if (!quitting) { e.preventDefault(); askQuit(); } });
process.on('exit', () => { if (server) server.kill(); });
