#!/usr/bin/env node
// Builds the static GitHub Pages site into _site/.
// The browser runs the same src/ modules as the server; node:* imports are
// redirected by an import map to small shims (and the `buffer` package).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, process.argv[2] || '_site');

// Modules the browser needs; server/CLI/sync/verify stay Node-only.
const BROWSER_SRC = ['base58.js', 'pubkey.js', 'rpc.js', 'idl.js', 'layouts.js', 'identify.js', 'registry-core.js'];

const IMPORT_MAP = {
  imports: {
    'node:buffer': 'https://cdn.jsdelivr.net/npm/buffer@6.0.3/+esm',
    'node:crypto': './shims/node-crypto.js',
    'node:zlib': './shims/node-zlib.js',
  },
};

const repo = process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : null;
const config = { static: true, ...(repo && { repo }) };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, 'src'), { recursive: true });

const copy = (from, to = from) => cpSync(path.join(ROOT, from), path.join(OUT, to), { recursive: true });
copy('public/app.js', 'app.js');
copy('public/style.css', 'style.css');
copy('web/static-api.js', 'static-api.js');
copy('web/shims', 'shims');
for (const f of BROWSER_SRC) copy(`src/${f}`, `src/${f}`);
copy('data/registry.json');
copy('data/synced.json');
copy('data/idl');

const head = [
  `<script type="importmap">${JSON.stringify(IMPORT_MAP)}</script>`,
  `<script>window.INDEXER = ${JSON.stringify(config)};</script>`,
].join('\n  ');
const html = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').replace('</head>', `  ${head}\n</head>`);
if (!html.includes('importmap')) throw new Error('could not inject the import map into index.html');
writeFileSync(path.join(OUT, 'index.html'), html);
writeFileSync(path.join(OUT, '.nojekyll'), '');

const { entries, syncedAt } = JSON.parse(readFileSync(path.join(ROOT, 'data/synced.json'), 'utf8'));
console.log(`Built ${path.relative(ROOT, OUT)}/ (${entries.length} synced entries, synced ${syncedAt})`);
