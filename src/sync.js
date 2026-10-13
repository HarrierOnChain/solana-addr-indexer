// Pulls addresses that live in on-chain config accounts (fee recipients,
// admins, authorities) and derives well-known PDAs, writing data/synced.json.
// Add a new source by appending to SOURCES.
import { writeFileSync } from 'node:fs';
import { pda, ata, addr, WSOL_MINT } from './pubkey.js';
import { accountBytes } from './rpc.js';
import { getIdl, matchAccount, decodeAccount } from './idl.js';
import { SYNCED_FILE } from './registry.js';

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const PUMP_FEES = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const DEFAULT_KEY = '11111111111111111111111111111111';

const pk = (v) => (v && v.pubkey && v.pubkey !== DEFAULT_KEY ? v.pubkey : null);
const pks = (arr) => (Array.isArray(arr) ? arr.map(pk).filter(Boolean) : []);

// "Reserved" recipients receive fees for mayhem-mode coins.
const reserved = (protocol, cfg) => [
  { address: pk(cfg.reserved_fee_recipient), name: `${protocol} reserved fee recipient (primary)`, type: 'fee-recipient', notes: 'Mayhem-mode fee recipient.' },
  ...pks(cfg.reserved_fee_recipients).map((a, i) => ({ address: a, name: `${protocol} reserved fee recipient ${i + 1}`, type: 'fee-recipient', notes: 'Mayhem-mode fee recipient.' })),
];

const SOURCES = [
  {
    protocol: 'Pump.fun',
    category: 'launchpad',
    program: PUMP,
    account: pda(PUMP, 'global'),
    accountName: 'Global',
    map: (g) => [
      { address: pk(g.authority), name: 'Pump.fun admin authority', type: 'authority' },
      { address: pk(g.fee_recipient), name: 'Pump.fun fee recipient (primary)', type: 'fee-recipient' },
      ...pks(g.fee_recipients).map((a, i) => ({ address: a, name: `Pump.fun fee recipient ${i + 1}`, type: 'fee-recipient' })),
      ...pks(g.buyback_fee_recipients).map((a, i) => ({ address: a, name: `Pump buyback fee recipient ${i + 1}`, type: 'fee-recipient', notes: 'Shared by Pump.fun and PumpSwap; buys must include one of these.' })),
      ...reserved('Pump.fun', g),
      { address: pk(g.withdraw_authority), name: 'Pump.fun withdraw authority', type: 'authority' },
      { address: pk(g.set_creator_authority), name: 'Pump.fun set-creator authority', type: 'authority' },
      { address: pk(g.admin_set_creator_authority), name: 'Pump.fun admin set-creator authority', type: 'authority' },
      { address: pk(g.whitelist_pda), name: 'Pump.fun whitelist PDA', type: 'pda' },
      { address: pk(g.holder_reward_claim_authority), name: 'Pump.fun holder-reward claim authority', type: 'authority' },
    ],
  },
  {
    protocol: 'PumpSwap',
    category: 'dex',
    program: PUMPSWAP,
    account: pda(PUMPSWAP, 'global_config'),
    accountName: 'GlobalConfig',
    map: (c) => [
      { address: pk(c.admin), name: 'PumpSwap admin', type: 'authority' },
      ...pks(c.protocol_fee_recipients).flatMap((a, i) => [
        { address: a, name: `PumpSwap protocol fee recipient ${i + 1}`, type: 'fee-recipient' },
        { address: ata(a, WSOL_MINT), name: `PumpSwap protocol fee recipient ${i + 1} (WSOL account)`, type: 'fee-vault', source: 'derived' },
      ]),
      ...pks(c.buyback_fee_recipients).map((a, i) => ({ address: a, name: `Pump buyback fee recipient ${i + 1}`, type: 'fee-recipient', protocol: 'Pump.fun', category: 'launchpad', notes: 'Shared by Pump.fun and PumpSwap; buys must include one of these.' })),
      ...reserved('PumpSwap', c),
      { address: pk(c.admin_set_coin_creator_authority), name: 'PumpSwap admin set-coin-creator authority', type: 'authority' },
      { address: pk(c.whitelist_pda), name: 'PumpSwap whitelist PDA', type: 'pda' },
    ],
  },
];

const DERIVED = [
  { protocol: 'Pump.fun', category: 'launchpad', address: pda(PUMP, 'global'), name: 'Pump.fun global state', type: 'config' },
  { protocol: 'Pump.fun', category: 'launchpad', address: pda(PUMP, '__event_authority'), name: 'Pump.fun event authority', type: 'pda' },
  { protocol: 'Pump.fun', category: 'launchpad', address: pda(PUMP, 'mint-authority'), name: 'Pump.fun mint authority', type: 'authority', notes: 'Mint authority and metadata update authority of every Pump.fun token.' },
  { protocol: 'Pump.fun', category: 'launchpad', address: pda(PUMP, 'global_volume_accumulator'), name: 'Pump.fun global volume accumulator', type: 'pda' },
  { protocol: 'Pump.fun', category: 'launchpad', address: pda(PUMP_FEES, 'fee_config', addr(PUMP)), name: 'Pump.fun fee config (fees program)', type: 'config' },
  { protocol: 'PumpSwap', category: 'dex', address: pda(PUMPSWAP, 'global_config'), name: 'PumpSwap global config', type: 'config' },
  { protocol: 'PumpSwap', category: 'dex', address: pda(PUMPSWAP, '__event_authority'), name: 'PumpSwap event authority', type: 'pda' },
  { protocol: 'PumpSwap', category: 'dex', address: pda(PUMPSWAP, 'global_volume_accumulator'), name: 'PumpSwap global volume accumulator', type: 'pda' },
  { protocol: 'PumpSwap', category: 'dex', address: pda(PUMP_FEES, 'fee_config', addr(PUMPSWAP)), name: 'PumpSwap fee config (fees program)', type: 'config' },
];

const JITO_BLOCK_ENGINE = 'https://mainnet.block-engine.jito.wtf/api/v1/getTipAccounts';

async function jitoTipAccounts(now) {
  const res = await fetch(JITO_BLOCK_ENGINE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
    signal: AbortSignal.timeout(20_000),
  });
  const { result } = await res.json();
  if (!Array.isArray(result) || !result.length) throw new Error('empty response');
  return [...result].sort().map((address, i) => ({
    protocol: 'Jito', category: 'mev', type: 'tip-account', source: 'chain', syncedAt: now,
    address, name: `Jito tip account ${i + 1}`, notes: 'From the Jito block engine getTipAccounts API.',
  }));
}

export async function sync(rpc, log = console.log) {
  const now = new Date().toISOString();
  const entries = DERIVED.map((e) => ({ ...e, source: 'derived' }));

  try {
    const tips = await jitoTipAccounts(now);
    entries.push(...tips);
    log(`✓ Jito: ${tips.length} tip accounts from the block engine`);
  } catch (e) {
    log(`! Jito tip accounts: ${e.message}; skipped`);
  }

  for (const src of SOURCES) {
    const [idl, acc] = await Promise.all([getIdl(rpc, src.program), rpc.getAccountInfo(src.account, 'base64')]).catch((e) => {
      log(`! ${src.protocol}: ${e.message}; skipped`);
      return [];
    });
    const data = accountBytes(acc);
    const match = matchAccount(idl, data);
    if (!match || match.name !== src.accountName) {
      log(`! ${src.protocol}: ${src.account} is not a ${src.accountName} per the IDL; skipped`);
      continue;
    }
    const decoded = decodeAccount(idl, match, data);
    const found = src.map(decoded).filter((e) => e.address);
    for (const e of found) entries.push({ protocol: src.protocol, category: src.category, source: 'chain', syncedAt: now, ...e });
    log(`✓ ${src.protocol}: ${found.length} addresses from ${src.accountName} (${src.account})`);
  }

  // The same address can be listed by two sources (e.g. buyback recipients); keep one row per name.
  const unique = [...new Map(entries.map((e) => [`${e.address}|${e.name}`, e])).values()];
  writeFileSync(SYNCED_FILE, JSON.stringify({ syncedAt: now, entries: unique }, null, 2) + '\n');
  log(`Wrote ${unique.length} entries to data/synced.json`);
  return unique;
}
