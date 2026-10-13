// Anchor IDL support: fetch a program's IDL (on-chain, or a local copy in
// data/idl/<programId>.json), recognise account types by discriminator and
// decode account data with a small borsh reader.
import { inflateSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { encode } from './base58.js';
import { anchorDiscriminator, anchorIdlAddress } from './pubkey.js';
import { accountBytes } from './rpc.js';
import { DATA_DIR } from './registry.js';

const cache = new Map();
const TTL_MS = 60 * 60 * 1000;

export async function getIdl(rpc, programId) {
  const hit = cache.get(programId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.idl;
  let idl = null;
  try {
    const acc = await rpc.getAccountInfo(anchorIdlAddress(programId), 'base64');
    const data = accountBytes(acc);
    if (data && data.length > 44) {
      const len = data.readUInt32LE(40);
      idl = JSON.parse(inflateSync(data.subarray(44, 44 + len)).toString('utf8'));
    }
  } catch {
    idl = null;
  }
  const local = path.join(DATA_DIR, 'idl', `${programId}.json`);
  if (!idl && existsSync(local)) idl = JSON.parse(readFileSync(local, 'utf8'));
  cache.set(programId, { idl, at: Date.now() });
  return idl;
}

export const idlName = (idl) => idl?.metadata?.name || idl?.name || null;

const typeName = (defined) => (typeof defined === 'string' ? defined : defined?.name);

/** Account type definitions keyed by 8-byte discriminator (hex). */
function accountTypes(idl) {
  const out = new Map();
  for (const acc of idl?.accounts || []) {
    const disc = acc.discriminator ? Buffer.from(acc.discriminator) : anchorDiscriminator(acc.name);
    const def = acc.type ? acc : (idl.types || []).find((t) => t.name === acc.name);
    out.set(disc.toString('hex'), { name: acc.name, def });
  }
  return out;
}

export function matchAccount(idl, data) {
  if (!idl || !data || data.length < 8) return null;
  return accountTypes(idl).get(data.subarray(0, 8).toString('hex')) || null;
}

/** Discriminator match against a plain list of account names (no IDL needed). */
export function matchAccountName(names, data) {
  if (!data || data.length < 8) return null;
  const head = data.subarray(0, 8);
  return names.find((n) => anchorDiscriminator(n).equals(head)) || null;
}

const INTS = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16 };

class Reader {
  constructor(buf, offset, types) {
    Object.assign(this, { buf, o: offset, types, depth: 0 });
  }
  need(n) {
    if (this.o + n > this.buf.length) throw new Error('out of bounds');
  }
  int(t) {
    const n = INTS[t];
    this.need(n);
    let v = 0n;
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(this.buf[this.o + i]);
    if (t[0] === 'i' && v >= 1n << BigInt(n * 8 - 1)) v -= 1n << BigInt(n * 8);
    this.o += n;
    return n <= 4 ? Number(v) : v.toString();
  }
  read(t) {
    if (++this.depth > 32) throw new Error('type nesting too deep');
    try {
      return this.readInner(t);
    } finally {
      this.depth--;
    }
  }
  readInner(t) {
    if (typeof t === 'string') {
      if (t in INTS) return this.int(t);
      if (t === 'bool') return this.need(1), this.buf[this.o++] !== 0;
      if (t === 'pubkey' || t === 'publicKey') {
        this.need(32);
        const v = encode(this.buf.subarray(this.o, this.o + 32));
        this.o += 32;
        return { pubkey: v };
      }
      if (t === 'f32') return this.need(4), (this.o += 4), this.buf.readFloatLE(this.o - 4);
      if (t === 'f64') return this.need(8), (this.o += 8), this.buf.readDoubleLE(this.o - 8);
      if (t === 'string' || t === 'bytes') {
        const len = this.int('u32');
        this.need(len);
        const raw = this.buf.subarray(this.o, this.o + len);
        this.o += len;
        return t === 'string' ? raw.toString('utf8') : `0x${raw.toString('hex')}`;
      }
      throw new Error(`unsupported type ${t}`);
    }
    if (t.array) return Array.from({ length: t.array[1] }, () => this.read(t.array[0]));
    if (t.vec) {
      const len = this.int('u32');
      if (len > this.buf.length - this.o) throw new Error('bad vec length');
      return Array.from({ length: len }, () => this.read(t.vec));
    }
    if (t.option || t.coption) {
      const some = t.option ? this.int('u8') : this.int('u32');
      return some ? this.read(t.option || t.coption) : null;
    }
    if (t.defined) {
      const def = (this.types || []).find((d) => d.name === typeName(t.defined));
      if (!def) throw new Error(`unknown type ${typeName(t.defined)}`);
      return this.readDef(def);
    }
    throw new Error(`unsupported type ${JSON.stringify(t)}`);
  }
  readDef(def) {
    const ty = def.type;
    if (ty.kind === 'struct') return this.readFields(ty.fields || []);
    if (ty.kind === 'enum') {
      const i = this.int('u8');
      const v = ty.variants[i];
      if (!v) throw new Error('bad enum variant');
      return v.fields ? { [v.name]: this.readFields(v.fields) } : v.name;
    }
    if (ty.kind === 'type') return this.read(ty.alias);
    throw new Error(`unsupported kind ${ty.kind}`);
  }
  readFields(fields) {
    if (fields.length && typeof fields[0] !== 'object') return fields.map((f) => this.read(f));
    if (fields.length && !('name' in fields[0])) return fields.map((f) => this.read(f));
    const out = {};
    for (const f of fields) out[f.name] = this.read(f.type);
    return out;
  }
}

/**
 * Decode an Anchor account (data includes the 8-byte discriminator).
 * Accounts created before a program upgrade are often shorter than the
 * current struct, so top-level fields are read until the data runs out.
 */
export function decodeAccount(idl, match, data) {
  if (!match?.def) return null;
  const r = new Reader(data, 8, idl.types);
  const ty = match.def.type;
  if (ty?.kind !== 'struct' || !ty.fields?.length || typeof ty.fields[0] !== 'object' || !('name' in ty.fields[0])) {
    return r.readDef(match.def);
  }
  const out = {};
  for (const f of ty.fields) {
    const start = r.o;
    try {
      out[f.name] = r.read(f.type);
    } catch (e) {
      if (e.message !== 'out of bounds' || start === 8) throw e;
      break;
    }
  }
  return out;
}

/**
 * Flatten decoded data into display rows: [{ key, value }] or [{ key, address }].
 * Skips padding, collapses long arrays, and keeps the output to a readable size.
 */
export function flatten(value, prefix = '', rows = [], max = 80) {
  if (rows.length >= max) return rows;
  if (/padding|reserved|^_|\._/i.test(prefix)) return rows;
  if (value && typeof value === 'object' && 'pubkey' in value) {
    if (value.pubkey !== '11111111111111111111111111111111') rows.push({ key: prefix, address: value.pubkey });
    return rows;
  }
  if (Array.isArray(value)) {
    const nonDefault = value.filter((v) => !(v && v.pubkey === '11111111111111111111111111111111'));
    if (value.every((v) => v === null || typeof v !== 'object')) {
      rows.push({ key: prefix, value: value.length > 8 ? `[${value.length} items]` : `[${value.join(', ')}]` });
    } else if (nonDefault.length <= 16) {
      value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, rows, max));
    } else {
      rows.push({ key: prefix, value: `[${value.length} items]` });
    }
    return rows;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, rows, max);
    return rows;
  }
  rows.push({ key: prefix, value: value === null ? 'none' : String(value) });
  return rows;
}
