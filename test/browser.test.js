// The static site swaps node:crypto / node:zlib for the shims in web/shims.
// These tests pin the shims to Node's real implementations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createHash as shimHash } from '../web/shims/node-crypto.js';
import { inflate as shimInflate } from '../web/shims/node-zlib.js';
import { RegistryCore } from '../src/registry-core.js';

test('sha256 shim matches node:crypto across block boundaries', () => {
  for (const len of [0, 1, 31, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const data = randomBytes(len);
    assert.equal(shimHash('sha256').update(data).digest().toString('hex'), createHash('sha256').update(data).digest('hex'), `length ${len}`);
  }
  const parts = shimHash('sha256').update('ProgramDerived').update(Buffer.from('Address')).digest();
  assert.deepEqual(parts, createHash('sha256').update('ProgramDerivedAddress').digest());
});

test('inflate shim decodes zlib data (on-chain Anchor IDL format)', async () => {
  const json = JSON.stringify({ name: 'demo', accounts: Array.from({ length: 50 }, (_, i) => ({ name: `Acc${i}` })) });
  const out = await new Promise((resolve, reject) => shimInflate(deflateSync(json), (e, b) => (e ? reject(e) : resolve(b))));
  assert.equal(out.toString('utf8'), json);
});

test('RegistryCore works from in-memory data with browser-style label storage', () => {
  let saved = [];
  const reg = new RegistryCore({
    curated: () => ({ protocols: [{ name: 'Demo', category: 'dex', entries: [{ address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', name: 'Demo program', type: 'program' }] }] }),
    synced: () => null,
    readCustom: () => saved,
    writeCustom: (list) => { saved = list; },
  });
  assert.equal(reg.label('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), 'Demo program');
  reg.addCustom({ address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', name: 'My name', type: 'program' });
  assert.equal(saved.length, 1);
  assert.equal(reg.label('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), 'My name'); // custom outranks curated
  assert.equal(reg.removeCustom('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), 1);
  assert.throws(() => reg.addCustom({ address: 'nope', name: 'x' }), /valid Solana address/);
});
