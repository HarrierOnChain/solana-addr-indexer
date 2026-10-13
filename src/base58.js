import { Buffer } from 'node:buffer';
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function decode(str) {
  let n = 0n;
  for (const c of str) {
    const v = INDEX.get(c);
    if (v === undefined) throw new Error(`invalid base58 character "${c}"`);
    n = n * 58n + v;
  }
  const body = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (str[zeros] === '1') zeros++;
  return Buffer.from([...new Array(zeros).fill(0), ...body]);
}

export function isAddress(str) {
  if (typeof str !== 'string' || str.length < 32 || str.length > 44) return false;
  try {
    return decode(str).length === 32;
  } catch {
    return false;
  }
}
