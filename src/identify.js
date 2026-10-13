// Reverse lookup: given any address, work out what it is.
// Registry labels come first; everything else is read from chain.
import { decode, encode, isAddress } from './base58.js';
import {
  isOnCurve, pda, ata, addr,
  SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, METADATA_PROGRAM, WSOL_MINT,
} from './pubkey.js';
import { accountBytes } from './rpc.js';
import { getIdl, idlName, matchAccount, decodeAccount, flatten } from './idl.js';
import { RAW_LAYOUTS, decodeRaw } from './layouts.js';

const TOKEN_PROGRAMS = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM];
const SYSVAR_OWNER = 'Sysvar1111111111111111111111111111111111111';
const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const LAUNCHLAB_PROGRAM ='LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';

const sol = (lamports) => `${(Number(lamports) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 9 })} SOL`;
const row = (key, value) => ({ key, value: String(value) });
const arow = (key, address) => (address ? { key, address } : row(key, 'none'));

export async function identify(input, { rpc, registry, holdings = false }) {
  const address = String(input || '').trim();
  if (!isAddress(address)) {
    let len = 0;
    try { len = decode(address).length; } catch { /* not base58 */ }
    return {
      address,
      valid: false,
      error: len === 64 ? 'That looks like a transaction signature, not an address.' : 'Not a valid Solana address (expected 32 bytes of base58).',
    };
  }

  const ctx = { rpc, registry, address, sections: [], hints: [], options: { holdings }, offerHoldings: false };
  const result = {
    address,
    valid: true,
    onCurve: isOnCurve(decode(address)),
    labels: registry.lookup(address),
  };
  if (!rpc) return { ...result, kind: 'offline', summary: summaryFromLabels(result.labels) || 'Not in the registry', sections: [] };

  const [info, sigs] = await Promise.all([
    rpc.getAccountInfo(address, 'jsonParsed'),
    rpc.getSignaturesForAddress(address, 1).catch(() => null),
  ]);

  let found;
  if (!info) found = notFound(ctx, result.onCurve);
  else {
    ctx.sections.push(basics(info, result.onCurve));
    found = await classify(ctx, info, result.onCurve);
  }

  const last = sigs?.[0];
  if (last) {
    ctx.sections.push({
      title: 'Activity',
      rows: [
        row('Last transaction', last.signature),
        row('Last seen', last.blockTime ? new Date(last.blockTime * 1000).toISOString() : 'unknown'),
        ...(last.err ? [row('Last tx status', 'failed')] : []),
      ],
    });
  } else if (sigs) {
    ctx.sections.push({ title: 'Activity', rows: [row('Transactions', 'none found')] });
  }

  labelRows(ctx.sections, registry);
  return {
    ...result,
    kind: found.kind,
    summary: summaryFromLabels(result.labels) || found.summary,
    detail: found.summary,
    hints: ctx.hints,
    sections: ctx.sections,
    offerHoldings: ctx.offerHoldings,
  };
}

function summaryFromLabels(labels) {
  if (!labels.length) return null;
  const [top] = labels;
  return top.name.toLowerCase().includes(top.protocol.toLowerCase()) ? top.name : `${top.protocol} · ${top.name}`;
}

function labelRows(sections, registry) {
  for (const s of sections) for (const r of s.rows) if (r.address) r.label = r.label || registry.label(r.address);
}

function basics(info, onCurve) {
  return {
    title: 'Account',
    rows: [
      row('Balance', sol(info.lamports)),
      arow('Owner program', info.owner),
      row('Data size', `${info.space ?? 0} bytes`),
      row('Executable', info.executable ? 'yes' : 'no'),
      row('Address kind', onCurve ? 'On curve: a keypair address (someone holds the private key)' : 'Off curve: a PDA (controlled by a program, no private key)'),
    ],
  };
}

function notFound(ctx, onCurve) {
  ctx.sections.push({ title: 'Account', rows: [row('Status', 'No account exists at this address right now')] });
  return {
    kind: 'not-found',
    summary: onCurve
      ? 'Empty keypair address: an unused or fully drained wallet (0 SOL, no data)'
      : 'PDA with no account: usually a signer-only authority, or an account that was closed',
  };
}

async function classify(ctx, info, onCurve) {
  const { owner } = info;
  const parsed = info.data?.parsed;

  if (info.executable) return program(ctx, info);
  if (TOKEN_PROGRAMS.includes(owner) && parsed?.type === 'mint') return mint(ctx, info);
  if (TOKEN_PROGRAMS.includes(owner) && parsed?.type === 'account') return tokenAccount(ctx, info);
  if (owner === SYSTEM_PROGRAM) return systemAccount(ctx, info, onCurve);
  if (owner === SYSVAR_OWNER) return { kind: 'sysvar', summary: `Sysvar (${parsed?.type || 'runtime state'})` };
  if (owner === UPGRADEABLE_LOADER && parsed?.type === 'programData') {
    ctx.sections.push({
      title: 'Program data',
      rows: [arow('Upgrade authority', parsed.info.authority), row('Last deployed slot', parsed.info.slot)],
    });
    return { kind: 'program-data', summary: 'Program data account (stores the executable code of an upgradeable program)' };
  }
  if (parsed?.type) {
    ctx.sections.push({ title: `Parsed ${parsed.type}`, rows: flattenParsed(parsed.info) });
    const what = { vote: 'Validator vote account', delegated: 'Stake account', initialized: 'Account', lookupTable: 'Address lookup table' }[parsed.type];
    return { kind: parsed.type, summary: `${what || parsed.type} owned by ${ctx.registry.label(owner) || owner}` };
  }
  return programOwned(ctx, info);
}

function flattenParsed(obj) {
  return flatten(
    JSON.parse(JSON.stringify(obj), (k, v) => (typeof v === 'string' && isAddress(v) && v.length >= 32 ? { pubkey: v } : v)),
  ).slice(0, 40);
}

// ---------------------------------------------------------------- programs

async function program(ctx, info) {
  const { rpc, address, registry } = ctx;
  const rows = [arow('Loader', info.owner)];
  let securityTxt = null;
  const programData = info.data?.parsed?.info?.programData;
  if (programData) {
    const pd = await rpc.getAccountInfo(programData, 'jsonParsed').catch(() => null);
    const pinfo = pd?.data?.parsed?.info;
    rows.push(arow('Program data', programData));
    if (pinfo) {
      rows.push(pinfo.authority ? arow('Upgrade authority', pinfo.authority) : row('Upgrade authority', 'none (immutable)'));
      rows.push(row('Last deployed slot', pinfo.slot));
      if (Array.isArray(pinfo.data)) securityTxt = parseSecurityTxt(Buffer.from(pinfo.data[0], 'base64'));
    }
  }
  const idl = await getIdl(rpc, address);
  if (idl) rows.push(row('Anchor IDL', `${idlName(idl)} (${(idl.accounts || []).length} account types, ${(idl.instructions || []).length} instructions)`));
  ctx.sections.push({ title: 'Program', rows });
  if (securityTxt) {
    ctx.sections.push({ title: 'security.txt (self-declared by the program)', rows: Object.entries(securityTxt).map(([k, v]) => row(k, v)) });
  }
  const name = registry.label(address) || securityTxt?.name || (idl && `${idlName(idl)} (from IDL)`);
  return { kind: 'program', summary: name ? `Program: ${name}` : 'Unknown program (no IDL, no security.txt, not in registry)' };
}

function parseSecurityTxt(elf) {
  const begin = elf.indexOf('=======BEGIN SECURITY.TXT V1=======\0');
  if (begin < 0) return null;
  const end = elf.indexOf('=======END SECURITY.TXT V1=======\0', begin);
  if (end < 0) return null;
  const parts = elf.subarray(begin + 36, end).toString('utf8').split('\0');
  const out = {};
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) out[parts[i]] = parts[i + 1].slice(0, 300);
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------- tokens

async function tokenMetadata(rpc, mintAddress, mintParsed) {
  const ext = mintParsed?.extensions?.find((e) => e.extension === 'tokenMetadata');
  if (ext?.state) return { name: ext.state.name, symbol: ext.state.symbol, uri: ext.state.uri, updateAuthority: ext.state.updateAuthority, standard: 'Token-2022 metadata' };
  const metaAddr = pda(METADATA_PROGRAM, 'metadata', addr(METADATA_PROGRAM), addr(mintAddress));
  const acc = await rpc.getAccountInfo(metaAddr, 'base64').catch(() => null);
  const d = accountBytes(acc);
  if (!d || d.length < 70) return null;
  try {
    let o = 65;
    const str = () => {
      const len = d.readUInt32LE(o);
      const s = d.subarray(o + 4, o + 4 + len).toString('utf8').replace(/\0+$/, '').trim();
      o += 4 + len;
      return s;
    };
    return { name: str(), symbol: str(), uri: str(), updateAuthority: encode(d.subarray(1, 33)), standard: 'Metaplex', account: metaAddr };
  } catch {
    return null;
  }
}

async function mint(ctx, info) {
  const { rpc, address, registry } = ctx;
  const p = info.data.parsed.info;
  const meta = await tokenMetadata(rpc, address, p);
  const supply = Number(p.supply) / 10 ** p.decimals;
  const rows = [
    ...(meta ? [row('Name', meta.name), row('Symbol', meta.symbol)] : []),
    arow('Token program', info.owner),
    row('Decimals', p.decimals),
    row('Supply', supply.toLocaleString('en-US')),
    p.mintAuthority ? arow('Mint authority', p.mintAuthority) : row('Mint authority', 'none (revoked, supply is fixed)'),
    p.freezeAuthority ? arow('Freeze authority', p.freezeAuthority) : row('Freeze authority', 'none'),
    ...(meta ? [arow('Metadata update authority', meta.updateAuthority), row('Metadata URI', meta.uri || 'none')] : []),
  ];
  for (const e of p.extensions || []) if (e.extension !== 'tokenMetadata') rows.push(row('Extension', e.extension));
  ctx.sections.push({ title: 'Token mint', rows });

  const origin = await launchOrigin(ctx, address);
  const holders = await topHolders(ctx, address, p.supply, p.decimals);

  const name = meta ? `${meta.name} (${meta.symbol})` : 'unnamed token';
  const venues = [...new Set([...origin, ...holders.venues])];
  if (venues.length) ctx.hints.push(`Liquidity / launch venues: ${venues.join(', ')}`);
  if (address.endsWith('pump')) ctx.hints.push('Address ends in "pump": the vanity suffix used by Pump.fun mints.');
  const venueText = venues.length ? `, found on ${venues.join(', ')}` : '';
  return { kind: 'mint', summary: `Token mint: ${name}${venueText}` };
}

async function launchOrigin(ctx, mintAddress) {
  const { rpc } = ctx;
  // Canonical PumpSwap pool of a migrated Pump.fun coin: index 0, created by the coin's pool-authority PDA.
  const pumpPoolAuthority = pda(PUMP_PROGRAM, 'pool-authority', addr(mintAddress));
  const candidates = [
    { venue: 'Pump.fun bonding curve', address: pda(PUMP_PROGRAM, 'bonding-curve', addr(mintAddress)), owner: PUMP_PROGRAM },
    {
      venue: 'PumpSwap pool',
      address: pda(PUMPSWAP_PROGRAM, 'pool', Buffer.alloc(2), addr(pumpPoolAuthority), addr(mintAddress), addr(WSOL_MINT)),
      owner: PUMPSWAP_PROGRAM,
    },
    { venue: 'Raydium LaunchLab', address: pda(LAUNCHLAB_PROGRAM, 'pool', addr(mintAddress), addr(WSOL_MINT)), owner: LAUNCHLAB_PROGRAM },
  ];
  const accs = await rpc.getMultipleAccounts(candidates.map((c) => c.address), 'base64').catch(() => []);
  const found = [];
  const rows = [];
  for (const [i, c] of candidates.entries()) {
    const acc = accs[i];
    if (!acc || acc.owner !== c.owner) continue;
    let status = '';
    if (c.owner === PUMP_PROGRAM) {
      const idl = await getIdl(rpc, PUMP_PROGRAM);
      const data = accountBytes(acc);
      const m = matchAccount(idl, data);
      const curve = m && safeDecode(idl, m, data);
      if (curve) status = curve.complete ? ' (curve complete, migrated)' : ` (bonding, ${sol(curve.real_sol_reserves)} raised)`;
    }
    found.push(c.venue);
    rows.push({ key: `${c.venue}${status}`, address: c.address });
  }
  if (rows.length) ctx.sections.push({ title: 'Launched on', rows });
  return found;
}

/** Who holds the supply: resolves each large holder to a pool / curve / wallet. */
async function topHolders(ctx, mintAddress, rawSupply, decimals) {
  const { rpc, registry } = ctx;
  let largest;
  try {
    largest = (await rpc.getTokenLargestAccounts(mintAddress)).slice(0, 10);
  } catch (e) {
    const why = /429/.test(e.message) ? 'rate-limited by the RPC; set RPC_URL to a private endpoint' : e.message;
    ctx.sections.push({ title: 'Top holders', rows: [row('Unavailable', why)] });
    return { venues: [] };
  }
  const tokenAccs = await rpc.getMultipleAccounts(largest.map((l) => l.address), 'jsonParsed');
  const owners = tokenAccs.map((a) => a?.data?.parsed?.info?.owner || null);
  const ownerAccs = await rpc.getMultipleAccounts(owners.filter(Boolean), 'base64', { offset: 0, length: 8 });
  const ownerInfo = new Map(owners.filter(Boolean).map((o, i) => [o, ownerAccs[i]]));

  const venues = new Set();
  const rows = [];
  for (const [i, l] of largest.entries()) {
    const owner = owners[i];
    const pct = rawSupply && rawSupply !== '0' ? (Number(l.amount) / Number(rawSupply)) * 100 : 0;
    const what = owner ? await describeOwner(ctx, owner, ownerInfo.get(owner)) : { text: 'unknown owner' };
    if (what.venue) venues.add(what.venue);
    rows.push({
      key: `#${i + 1} · ${pct.toFixed(2)}% · ${what.text}`,
      address: owner || l.address,
      label: registry.label(owner) || undefined,
    });
  }
  ctx.sections.push({ title: 'Top holders (by owner of the token account)', rows });
  return { venues: [...venues] };
}

/** Describe an account that owns tokens: labelled address, pool PDA of a known program, or plain wallet. */
async function describeOwner(ctx, owner, acc) {
  const { registry, rpc } = ctx;
  const direct = registry.lookup(owner)[0];
  if (direct) return { text: direct.name, venue: ['launchpad', 'dex', 'aggregator'].includes(direct.category) ? direct.protocol : null };
  if (!acc) return { text: isOnCurve(decode(owner)) ? 'wallet (empty)' : 'PDA (no account)' };
  if (acc.owner === SYSTEM_PROGRAM) return { text: isOnCurve(decode(owner)) ? 'wallet' : 'system-owned PDA' };
  const prog = registry.lookup(acc.owner)[0];
  const idl = await getIdl(rpc, acc.owner);
  const type = matchAccount(idl, accountBytes(acc))?.name;
  const progName = prog?.protocol || idlName(idl) || acc.owner.slice(0, 8) + '…';
  return { text: `${progName}${type ? ` ${type}` : ''} account`, venue: prog && ['launchpad', 'dex'].includes(prog.category) ? prog.protocol : null };
}

/** Display name for a mint: registry label, else on-chain metadata, else the address. */
async function tokenName(ctx, mintAddress) {
  const known = ctx.registry.label(mintAddress);
  if (known) return known;
  const mintAcc = await ctx.rpc.getAccountInfo(mintAddress, 'jsonParsed').catch(() => null);
  const meta = mintAcc ? await tokenMetadata(ctx.rpc, mintAddress, mintAcc.data?.parsed?.info) : null;
  return meta?.name ? `${meta.name} (${meta.symbol})` : mintAddress;
}

async function tokenAccount(ctx, info) {
  const { rpc, address, registry } = ctx;
  const p = info.data.parsed.info;
  const isAta = ata(p.owner, p.mint, info.owner) === address;
  const mintName = await tokenName(ctx, p.mint);
  const symbol = mintName.match(/\(([^)]+)\)$/)?.[1] || '';
  const ownerAcc = await rpc.getAccountInfo(p.owner, 'base64').catch(() => null);
  const ownerDesc = await describeOwner(ctx, p.owner, ownerAcc);

  ctx.sections.push({
    title: 'Token account',
    rows: [
      { key: 'Mint', address: p.mint, label: mintName === p.mint ? undefined : mintName },
      arow('Owner', p.owner),
      row('Owner is', ownerDesc.text),
      row('Balance', `${p.tokenAmount.uiAmountString} ${symbol}`.trim()),
      row('Associated token account', isAta ? 'yes (canonical ATA of the owner)' : 'no (custom token account / vault)'),
      row('State', p.state),
      ...(p.delegate ? [arow('Delegate', p.delegate)] : []),
      ...(p.closeAuthority ? [arow('Close authority', p.closeAuthority)] : []),
    ],
  });
  const ownerLabel = registry.label(p.owner) || ownerDesc.text;
  return { kind: 'token-account', summary: `${mintName} token account${isAta ? ' (ATA)' : ''} owned by ${ownerLabel}` };
}

// ---------------------------------------------------------------- system & program-owned

async function systemAccount(ctx, info, onCurve) {
  const parsed = info.data?.parsed;
  if (parsed?.type === 'initialized' && parsed.info?.blockhash) {
    ctx.sections.push({ title: 'Durable nonce', rows: [arow('Authority', parsed.info.authority), row('Nonce', parsed.info.blockhash)] });
    return { kind: 'nonce', summary: 'Durable nonce account' };
  }
  // Busy wallets (fee recipients, market makers) own hundreds of thousands of
  // token accounts, so listing them is opt-in.
  if (ctx.options.holdings) await tokenHoldings(ctx);
  else ctx.offerHoldings = true;
  return {
    kind: 'wallet',
    summary: onCurve
      ? `Wallet (keypair account) holding ${sol(info.lamports)}`
      : `System-owned PDA holding ${sol(info.lamports)}: a program-controlled SOL vault (fee vault, escrow, treasury…)`,
  };
}

async function tokenHoldings(ctx, title = 'Token holdings') {
  const { rpc, address, registry } = ctx;
  const lists = await Promise.all(TOKEN_PROGRAMS.map((p) => rpc.getTokenAccountsByOwner(address, p).catch(() => [])));
  const accounts = lists.flat();
  if (!accounts.length) return [];
  const withBalance = accounts.filter((a) => Number(a.account.data.parsed.info.tokenAmount.amount) > 0);
  const rows = withBalance.slice(0, 15).map((a) => {
    const i = a.account.data.parsed.info;
    return { key: `${i.tokenAmount.uiAmountString} of`, address: i.mint, label: registry.label(i.mint) || undefined };
  });
  const extra = accounts.length - rows.length;
  if (extra > 0) rows.push(row('…', `${extra} more token account(s) (empty or not shown)`));
  ctx.sections.push({ title: `${title} (${accounts.length} token accounts)`, rows });
  return accounts;
}

function safeDecode(idl, match, data) {
  try {
    return decodeAccount(idl, match, data);
  } catch {
    return null;
  }
}

async function programOwned(ctx, info) {
  const { rpc, registry } = ctx;
  const data = accountBytes(info);
  const ownerName = registry.label(info.owner);
  const idl = await getIdl(rpc, info.owner);
  const programName = ownerName || idlName(idl) || `program ${info.owner}`;

  let typeName = null;
  let rows = null;
  const match = matchAccount(idl, data);
  if (match) {
    typeName = match.name;
    const decoded = safeDecode(idl, match, data);
    rows = decoded ? flatten(decoded) : null;
  } else {
    const raw = RAW_LAYOUTS.find((l) => l.owner === info.owner && (!l.size || l.size === data?.length));
    if (raw) {
      typeName = raw.name;
      rows = decodeRaw(raw, data);
    }
  }
  if (typeName) ctx.sections.push({ title: `${typeName} (decoded${idl ? ` with the ${idlName(idl)} IDL` : ''})`, rows: rows || [row('Decode', 'layout did not match; type recognised by discriminator only')] });
  else if (data?.length >= 8) ctx.sections.push({ title: 'Data', rows: [row('Discriminator', data.subarray(0, 8).toString('hex')), row('Note', idl ? 'No account type in the IDL matches this discriminator' : 'Owner program has no published IDL')] });

  const holdings = await tokenHoldings(ctx, 'Token accounts owned by this account');
  let about = '';
  if (holdings.length === 1) about = ` for ${await tokenName(ctx, holdings[0].account.data.parsed.info.mint)}`;
  return { kind: 'program-account', summary: `${typeName ? `${typeName} account` : 'Account'} of ${programName}${about}` };
}
