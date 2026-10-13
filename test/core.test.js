import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, isAddress } from '../src/base58.js';
import { pda, ata, addr, isOnCurve, anchorDiscriminator, WSOL_MINT } from '../src/pubkey.js';
import { decodeAccount, matchAccount, flatten } from '../src/idl.js';
import { Registry } from '../src/registry.js';

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const PUMP_FEES = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';

test('base58 round-trips, including leading zero bytes', () => {
  for (const a of ['11111111111111111111111111111111', PUMP, WSOL_MINT]) {
    assert.equal(encode(decode(a)), a);
    assert.equal(decode(a).length, 32);
  }
  assert.ok(isAddress(PUMP));
  assert.ok(!isAddress('0OIl'));
  assert.ok(!isAddress('abc'));
});

test('PDA derivation matches mainnet accounts', () => {
  assert.equal(pda(PUMP, 'global'), '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
  assert.equal(pda(PUMP, '__event_authority'), 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
  assert.equal(pda(PUMP, 'mint-authority'), 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM');
  assert.equal(pda(PUMP_FEES, 'fee_config', addr(PUMP)), '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt');
  assert.equal(pda(PUMPSWAP, 'global_config'), 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
});

test('associated token account derivation', () => {
  assert.equal(ata('7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ', WSOL_MINT), '7GFUN3bWzJMKMRZ34JLsvcqdssDbXnp589SiE33KVwcC');
});

test('on-curve check separates keypairs from PDAs', () => {
  assert.ok(isOnCurve(decode(PUMP))); // deployed from a keypair
  assert.ok(!isOnCurve(decode('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf'))); // PDA
});

test('IDL decoder reads fields until short (pre-upgrade) data runs out', () => {
  const idl = {
    accounts: [{ name: 'Curve' }],
    types: [{ name: 'Curve', type: { kind: 'struct', fields: [
      { name: 'reserves', type: 'u64' },
      { name: 'complete', type: 'bool' },
      { name: 'creator', type: 'pubkey' },
      { name: 'added_later', type: 'u64' },
    ] } }],
  };
  const creator = decode(PUMP);
  const data = Buffer.concat([anchorDiscriminator('Curve'), Buffer.from([0x40, 0x42, 0x0f, 0, 0, 0, 0, 0]), Buffer.from([1]), creator]);
  const match = matchAccount(idl, data);
  assert.equal(match.name, 'Curve');
  const decoded = decodeAccount(idl, match, data);
  assert.deepEqual(decoded, { reserves: '1000000', complete: true, creator: { pubkey: PUMP } });
  assert.deepEqual(flatten(decoded), [
    { key: 'reserves', value: '1000000' },
    { key: 'complete', value: 'true' },
    { key: 'creator', address: PUMP },
  ]);
});

test('registry search, filters and multi-role addresses', () => {
  const r = new Registry();
  const programs = r.search({ category: 'launchpad', type: 'program' }).entries;
  assert.ok(programs.some((e) => e.address === PUMP));
  assert.ok(programs.every((e) => e.category === 'launchpad' && e.type === 'program'));
  assert.ok(r.search({ q: 'jupiter v6' }).entries.some((e) => e.address === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'));
  assert.equal(r.search({ q: PUMPSWAP }).entries[0].address, PUMPSWAP);
});
