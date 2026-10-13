// In-browser backend for the static (GitHub Pages) build. Answers the same
// /api/* routes as src/server.js, but runs lookups directly against an RPC
// from the visitor's browser and keeps custom labels in localStorage.
import { RegistryCore } from './src/registry-core.js';
import { Rpc } from './src/rpc.js';
import { identify } from './src/identify.js';

// api.mainnet-beta.solana.com answers 403 to any request carrying a browser Origin,
// so the static site defaults to a keyless endpoint that allows CORS.
const DEFAULT_RPC = 'https://solana-rpc.publicnode.com';
const KEYS = { labels: 'solidx.labels', rpc: 'solidx.rpc' };
const WHOIS_TTL_MS = 30_000;

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode / storage blocked: labels last for this page view only */
    }
  },
};

export async function createStaticApi() {
  const load = (p) => fetch(p).then((r) => (r.ok ? r.json() : null));
  const [curated, synced] = await Promise.all([load('data/registry.json'), load('data/synced.json')]);
  let labels = store.get(KEYS.labels, []);
  const registry = new RegistryCore({
    curated: () => curated,
    synced: () => synced,
    readCustom: () => labels,
    writeCustom: (list) => {
      labels = list;
      store.set(KEYS.labels, list);
    },
  });
  let rpc = new Rpc(store.get(KEYS.rpc, '') || DEFAULT_RPC);
  const cache = new Map();

  return async function handle(path, { method = 'GET', body } = {}) {
    const url = new URL(path, location.origin);
    const p = url.pathname;

    if (method === 'GET' && p === '/api/facets') {
      return {
        ...registry.facets(),
        mode: 'static',
        labelsNote: 'Saved in this browser only (localStorage). Add permanent labels to data/registry.json in the repo.',
        rpcUrl: rpc.url,
        defaultRpc: DEFAULT_RPC,
      };
    }
    if (method === 'GET' && p === '/api/search') {
      const q = Object.fromEntries(url.searchParams);
      return registry.search({ ...q, limit: Number(q.limit) || 1000 });
    }
    if (method === 'GET' && p.startsWith('/api/whois/')) {
      const address = decodeURIComponent(p.slice('/api/whois/'.length));
      const holdings = url.searchParams.has('holdings');
      const key = `${address}|${holdings}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < WHOIS_TTL_MS) return hit.result;
      const result = await identify(address, { rpc, registry, holdings });
      cache.set(key, { result, at: Date.now() });
      return result;
    }
    if (method === 'POST' && p === '/api/labels') {
      cache.clear();
      return registry.addCustom(JSON.parse(body));
    }
    if (method === 'DELETE' && p.startsWith('/api/labels/')) {
      cache.clear();
      return { removed: registry.removeCustom(decodeURIComponent(p.slice('/api/labels/'.length))) };
    }
    if (method === 'POST' && p === '/api/rpc') {
      const next = String(JSON.parse(body).url || '').trim();
      if (next && !/^https:\/\//.test(next)) throw new Error('RPC URL must start with https://');
      rpc = new Rpc(next || DEFAULT_RPC);
      store.set(KEYS.rpc, next);
      cache.clear();
      return { rpcUrl: rpc.url };
    }
    throw new Error('not found');
  };
}
