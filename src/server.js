import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { identify } from './identify.js';
import { CATEGORIES, TYPES } from './registry.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const WHOIS_TTL_MS = 30_000;

export function serve({ registry, rpc, port, host }) {
  const whoisCache = new Map();

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function readBody(req) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1e5) throw new Error('body too large');
    }
    return JSON.parse(body || '{}');
  }

  async function whois(address, fresh, holdings) {
    const key = `${address}|${holdings}`;
    const hit = whoisCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < WHOIS_TTL_MS) return hit.result;
    const result = await identify(address, { rpc, registry, holdings });
    whoisCache.set(key, { result, at: Date.now() });
    return result;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && STATIC[p]) {
        const [file, type] = STATIC[p];
        res.writeHead(200, { 'content-type': type });
        return res.end(await readFile(path.join(PUBLIC_DIR, file)));
      }
      if (req.method === 'GET' && p === '/api/search') {
        const q = Object.fromEntries(url.searchParams);
        return json(res, 200, registry.search({ ...q, limit: Number(q.limit) || 1000 }));
      }
      if (req.method === 'GET' && p === '/api/facets') {
        return json(res, 200, { ...registry.facets(), allCategories: CATEGORIES, allTypes: TYPES });
      }
      if (req.method === 'GET' && p.startsWith('/api/whois/')) {
        const address = decodeURIComponent(p.slice('/api/whois/'.length));
        return json(res, 200, await whois(address, url.searchParams.has('fresh'), url.searchParams.has('holdings')));
      }
      if (req.method === 'GET' && p === '/api/export') {
        return json(res, 200, { exportedAt: new Date().toISOString(), entries: registry.entries });
      }
      if (req.method === 'POST' && p === '/api/labels') {
        const entry = registry.addCustom(await readBody(req));
        whoisCache.clear();
        return json(res, 201, entry);
      }
      if (req.method === 'DELETE' && p.startsWith('/api/labels/')) {
        const address = decodeURIComponent(p.slice('/api/labels/'.length));
        whoisCache.clear();
        return json(res, 200, { removed: registry.removeCustom(address) });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, p.startsWith('/api/labels') ? 400 : 502, { error: e.message });
    }
  });

  server.listen(port, host, () => {
    console.log(`Address indexer on http://${host}:${port}  (RPC: ${new URL(rpc.url).host})`);
  });
  return server;
}
