import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isAddress } from './base58.js';

export const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const CURATED = path.join(DATA_DIR, 'registry.json');
const SYNCED = path.join(DATA_DIR, 'synced.json');
const CUSTOM = path.join(DATA_DIR, 'custom.json');

export const CATEGORIES = ['launchpad', 'dex', 'aggregator', 'mev', 'token', 'staking', 'lending', 'oracle', 'nft', 'bridge', 'governance', 'infra', 'core', 'other'];
export const TYPES = ['program', 'fee-recipient', 'fee-vault', 'authority', 'config', 'pda', 'tip-account', 'mint', 'wallet', 'sysvar'];

// Order of trust when one address has several labels: your own labels first,
// then what was read from chain, then the curated list.
const SOURCE_RANK = { custom: 0, chain: 1, derived: 1, repo: 2, curated: 3 };

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);

function normalize(e, group = {}) {
  return {
    address: e.address,
    name: e.name,
    protocol: e.protocol || group.name || 'Unknown',
    category: e.category || group.category || 'other',
    type: e.type || 'wallet',
    notes: e.notes || '',
    website: e.website || group.website || '',
    source: e.source || 'curated',
    ...(e.syncedAt && { syncedAt: e.syncedAt }),
    ...(e.onchain === false && { onchain: false }),
  };
}

export class Registry {
  constructor() {
    this.reload();
  }

  reload() {
    const curated = readJson(CURATED, { protocols: [] });
    const synced = readJson(SYNCED, { entries: [] });
    this.custom = readJson(CUSTOM, []);
    this.syncedAt = synced.syncedAt || null;

    const all = [
      ...curated.protocols.flatMap((g) => g.entries.map((e) => normalize(e, g))),
      ...synced.entries.map((e) => normalize(e)),
      ...this.custom.map((e) => normalize({ source: 'custom', ...e })),
    ];

    // One row per (address, protocol, name); keep the most trusted source.
    const seen = new Map();
    for (const e of all) {
      const key = `${e.address}|${e.protocol}|${e.name}`;
      const prev = seen.get(key);
      if (!prev || SOURCE_RANK[e.source] < SOURCE_RANK[prev.source]) seen.set(key, e);
    }
    this.entries = [...seen.values()];

    this.byAddress = new Map();
    for (const e of this.entries) {
      if (!this.byAddress.has(e.address)) this.byAddress.set(e.address, []);
      this.byAddress.get(e.address).push(e);
    }
    for (const list of this.byAddress.values()) list.sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source]);
  }

  lookup(address) {
    return this.byAddress.get(address) || [];
  }

  /** Short display label for an address, or null. */
  label(address) {
    const e = this.lookup(address)[0];
    return e ? `${e.name}` : null;
  }

  search({ q = '', category, type, protocol, limit = 500 } = {}) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = this.entries.filter((e) => {
      if (category && e.category !== category) return false;
      if (type && e.type !== type) return false;
      if (protocol && e.protocol !== protocol) return false;
      if (!terms.length) return true;
      const hay = `${e.name} ${e.protocol} ${e.category} ${e.type} ${e.notes} ${e.address}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    hits.sort(
      (a, b) =>
        CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) ||
        a.protocol.localeCompare(b.protocol) ||
        TYPES.indexOf(a.type) - TYPES.indexOf(b.type) ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    return { total: hits.length, entries: hits.slice(0, limit) };
  }

  facets() {
    const count = (key) => {
      const m = new Map();
      for (const e of this.entries) m.set(e[key], (m.get(e[key]) || 0) + 1);
      return [...m].map(([name, n]) => ({ name, count: n }));
    };
    const order = (list, ref) => list.sort((a, b) => ref.indexOf(a.name) - ref.indexOf(b.name));
    return {
      total: this.entries.length,
      syncedAt: this.syncedAt,
      categories: order(count('category'), CATEGORIES),
      types: order(count('type'), TYPES),
      protocols: count('protocol').sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  addCustom(input) {
    if (!isAddress(input.address)) throw new Error('address is not a valid Solana address');
    if (!input.name?.trim()) throw new Error('name is required');
    if (input.category && !CATEGORIES.includes(input.category)) throw new Error(`category must be one of: ${CATEGORIES.join(', ')}`);
    if (input.type && !TYPES.includes(input.type)) throw new Error(`type must be one of: ${TYPES.join(', ')}`);
    const entry = {
      address: input.address,
      name: input.name.trim(),
      protocol: input.protocol?.trim() || 'My labels',
      category: input.category || 'other',
      type: input.type || 'wallet',
      ...(input.notes?.trim() && { notes: input.notes.trim() }),
    };
    const list = readJson(CUSTOM, []).filter((e) => !(e.address === entry.address && e.name === entry.name));
    list.push(entry);
    writeFileSync(CUSTOM, JSON.stringify(list, null, 2) + '\n');
    this.reload();
    return normalize({ source: 'custom', ...entry });
  }

  removeCustom(address) {
    const list = readJson(CUSTOM, []);
    const kept = list.filter((e) => e.address !== address);
    writeFileSync(CUSTOM, JSON.stringify(kept, null, 2) + '\n');
    this.reload();
    return list.length - kept.length;
  }
}

export const SYNCED_FILE = SYNCED;
