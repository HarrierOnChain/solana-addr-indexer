// Address math with no dependencies: ed25519 on-curve test, PDA derivation,
// associated token accounts, createWithSeed and Anchor discriminators.
import { createHash } from 'node:crypto';
import { encode, decode } from './base58.js';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const P = 2n ** 255n - 19n;
const mod = (a) => ((a % P) + P) % P;
function pow(b, e) {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
const D = mod(-121665n * pow(121666n, P - 2n));

// Mirrors curve25519-dalek's CompressedEdwardsY::decompress, which is what the
// runtime uses to reject PDAs that land on the curve.
export function isOnCurve(bytes) {
  const b = Buffer.from(bytes);
  b[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  y = mod(y);
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const v3 = (v * v % P) * v % P;
  const v7 = (v3 * v3 % P) * v % P;
  const x = (u * v3 % P) * pow(u * v7, (P - 5n) / 8n) % P;
  const vx2 = (v * x % P) * x % P;
  return vx2 === u || vx2 === mod(-u);
}

const toBytes = (seed) =>
  Buffer.isBuffer(seed) || seed instanceof Uint8Array ? Buffer.from(seed) : Buffer.from(seed, 'utf8');

/** Seed helper: a base58 address as its 32 raw bytes. */
export const addr = (address) => decode(address);

export function findProgramAddress(seeds, programId) {
  const program = decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(toBytes(s));
    h.update(Buffer.from([bump]));
    h.update(program);
    h.update('ProgramDerivedAddress');
    const out = h.digest();
    if (!isOnCurve(out)) return [encode(out), bump];
  }
  throw new Error('no viable bump seed');
}

export const pda = (programId, ...seeds) => findProgramAddress(seeds, programId)[0];

export const ata = (owner, mint, tokenProgram = TOKEN_PROGRAM) =>
  pda(ATA_PROGRAM, addr(owner), addr(tokenProgram), addr(mint));

export function createWithSeed(base, seed, programId) {
  const h = createHash('sha256');
  h.update(decode(base));
  h.update(seed);
  h.update(decode(programId));
  return encode(h.digest());
}

export const anchorDiscriminator = (accountName) =>
  createHash('sha256').update(`account:${accountName}`).digest().subarray(0, 8);

/** Address of the on-chain Anchor IDL account for a program. */
export const anchorIdlAddress = (programId) =>
  createWithSeed(findProgramAddress([], programId)[0], 'anchor:idl', programId);
