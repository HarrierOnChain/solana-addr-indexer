// Fixed-offset layouts for accounts that are not Anchor accounts (no
// discriminator, no IDL). Anchor programs without an on-chain IDL get a
// partial IDL in data/idl/<programId>.json instead.
import { encode } from './base58.js';

export const RAW_LAYOUTS = [
  {
    owner: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    size: 752,
    name: 'AmmInfo (Raydium AMM v4 pool)',
    fields: [
      ['status', 0, 'u64'],
      ['base_decimals', 32, 'u64'],
      ['quote_decimals', 40, 'u64'],
      ['pool_open_time', 224, 'u64'],
      ['base_vault', 336, 'pubkey'],
      ['quote_vault', 368, 'pubkey'],
      ['base_mint', 400, 'pubkey'],
      ['quote_mint', 432, 'pubkey'],
      ['lp_mint', 464, 'pubkey'],
      ['open_orders', 496, 'pubkey'],
      ['market_id', 528, 'pubkey'],
      ['market_program', 560, 'pubkey'],
      ['target_orders', 592, 'pubkey'],
      ['owner', 688, 'pubkey'],
    ],
  },
];

export function decodeRaw(layout, data) {
  return layout.fields.map(([key, offset, type]) =>
    type === 'pubkey'
      ? { key, address: encode(data.subarray(offset, offset + 32)) }
      : { key, value: data.readBigUInt64LE(offset).toString() },
  );
}
