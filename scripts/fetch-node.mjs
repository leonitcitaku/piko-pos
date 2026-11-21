// Downloads the pinned Node for Windows into vendor/node/node.exe so the installer can bundle it.
// The POS server runs on this exact Node, not on the one inside Electron.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_VERSION = '24.15.0';   // pin it. node:sqlite is release candidate from 24.15. Never auto update.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'vendor', 'node', 'node.exe');
if (fs.existsSync(dest)) { console.log('node.exe already there:', dest); process.exit(0); }
const url = `https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`;
console.log('Downloading', url);
const res = await fetch(url);
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
console.log('Saved', dest);
