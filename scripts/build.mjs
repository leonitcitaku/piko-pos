// Builds the web app into web/dist. Needs react, react-dom and esbuild (npm install).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const esbuild = require('esbuild');
const out = path.join(root, 'web', 'dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, 'web', 'src', 'main.jsx')],
  bundle: true, minify: true, sourcemap: false, format: 'iife', target: ['es2020'],
  jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  nodePaths: (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean),
  outfile: path.join(out, 'app.js'),
});
for (const f of ['index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg']) fs.copyFileSync(path.join(root, 'web', f), path.join(out, f));
console.log('Web app built:', out, (fs.statSync(path.join(out, 'app.js')).size / 1024).toFixed(0) + ' kB');
