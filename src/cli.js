#!/usr/bin/env node
import { Registry } from './registry.js';
import { Rpc } from './rpc.js';
import { identify } from './identify.js';
import { sync } from './sync.js';
import { verify } from './verify.js';
import { serve } from './server.js';

const USAGE = `Solana address indexer

  search [query] [--category c] [--type t] [--protocol p]   find addresses in the registry
  whois <address> [--json] [--holdings]                    identify any address (registry + on-chain)
  label <address> <name> [--protocol p] [--category c] [--type t] [--notes n]
  unlabel <address>                                        remove your custom labels for an address
  sync                                                     refresh fee recipients / authorities from chain
  verify                                                   check every registry entry against chain state
  serve [--port 8787]                                      web UI + JSON API

Env: RPC_URL (default: public mainnet RPC), PORT, HOST`;

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      flags[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else pos.push(argv[i]);
  }
  return { pos, flags };
}

const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

function printWhois(r) {
  if (!r.valid) return console.log(r.error);
  console.log(bold(r.summary));
  if (r.detail && r.detail !== r.summary) console.log(r.detail);
  console.log(dim(r.address));
  for (const l of r.labels) console.log(`  label: ${l.protocol} · ${l.name} [${l.category}/${l.type}, ${l.source}]${l.notes ? ` · ${l.notes}` : ''}`);
  for (const h of r.hints || []) console.log(`  hint: ${h}`);
  for (const s of r.sections) {
    console.log(`\n${bold(s.title)}`);
    const width = Math.min(34, Math.max(...s.rows.map((x) => x.key.length)));
    for (const x of s.rows) {
      const val = x.address ? `${x.address}${x.label ? `  ${dim(`(${x.label})`)}` : ''}` : x.value;
      console.log(`  ${x.key.padEnd(width)}  ${val}`);
    }
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  const registry = new Registry();
  const rpc = new Rpc();

  switch (cmd) {
    case 'search': {
      const { total, entries } = registry.search({ q: pos.join(' '), category: flags.category, type: flags.type, protocol: flags.protocol });
      for (const e of entries) console.log(`${e.address.padEnd(44)}  ${e.protocol} · ${e.name} ${dim(`[${e.category}/${e.type}]`)}`);
      console.log(dim(`${total} match(es)`));
      break;
    }
    case 'whois': {
      if (!pos[0]) throw new Error('usage: whois <address>');
      const r = await identify(pos[0], { rpc, registry, holdings: Boolean(flags.holdings) });
      flags.json ? console.log(JSON.stringify(r, null, 2)) : printWhois(r);
      break;
    }
    case 'label': {
      const [address, ...name] = pos;
      const e = registry.addCustom({ address, name: name.join(' '), protocol: flags.protocol, category: flags.category, type: flags.type, notes: flags.notes });
      console.log(`Saved: ${e.protocol} · ${e.name} → ${e.address}`);
      break;
    }
    case 'unlabel':
      console.log(`Removed ${registry.removeCustom(pos[0])} label(s)`);
      break;
    case 'sync':
      await sync(rpc);
      break;
    case 'verify': {
      const failures = await verify(rpc, registry);
      process.exitCode = failures.length ? 1 : 0;
      break;
    }
    case 'serve':
      serve({ registry, rpc, port: Number(flags.port || process.env.PORT || 8787), host: flags.host || process.env.HOST || '127.0.0.1' });
      break;
    default:
      console.log(USAGE);
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
