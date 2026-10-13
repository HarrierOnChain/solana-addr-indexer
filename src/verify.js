// Checks every registry entry against chain state so a typo or a stale
// address shows up as a failure instead of a wrong label.
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from './pubkey.js';

const TOKEN_PROGRAMS = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM];

function check(entry, acc) {
  if (entry.onchain === false) return null; // builtins / burn address: no account by design
  switch (entry.type) {
    case 'program':
      if (!acc) return 'no account on chain';
      return acc.executable ? null : `not executable (owner ${acc.owner})`;
    case 'mint':
    case 'fee-vault':
      if (!acc) return 'no account on chain';
      return TOKEN_PROGRAMS.includes(acc.owner) ? null : `owner is ${acc.owner}, not a token program`;
    case 'authority':
    case 'pda':
      return null; // signer-only PDAs legitimately have no account
    default:
      return acc ? null : 'no account on chain';
  }
}

export async function verify(rpc, registry, log = console.log) {
  const addresses = [...registry.byAddress.keys()];
  const accounts = await rpc.getMultipleAccounts(addresses, 'base64', { offset: 0, length: 0 });
  const byAddress = new Map(addresses.map((a, i) => [a, accounts[i]]));
  const failures = [];
  for (const e of registry.entries) {
    const problem = check(e, byAddress.get(e.address));
    if (problem) failures.push({ ...e, problem });
  }
  for (const f of failures) log(`✗ [${f.source}] ${f.protocol} · ${f.name} (${f.type}) ${f.address}: ${f.problem}`);
  log(`${registry.entries.length - failures.length}/${registry.entries.length} entries match chain state`);
  return failures;
}
