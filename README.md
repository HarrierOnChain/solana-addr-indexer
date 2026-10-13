# Solana Address Indexer

A searchable directory of known Solana addresses (launchpads, DEXes, aggregators,
fee recipients, authorities, program IDs, tip accounts, major mints) plus a reverse
lookup that tells you what *any* address is by reading chain state.

No dependencies. Node 20+.

```bash
npm start                    # web UI + API on http://127.0.0.1:8787
RPC_URL=https://... npm start  # use your own RPC (recommended; the public one rate-limits)
```

## GitHub Pages

`.github/workflows/pages.yml` runs the tests, re-syncs on-chain addresses, verifies
every entry against mainnet and deploys a static build to GitHub Pages. It runs on
every push to `main` and every 6 hours, so rotated fee recipients show up without a commit.
Pull requests run the same checks without deploying.

- One-time setup: **Settings → Pages → Source: GitHub Actions**.
- Optional: add an `RPC_URL` repository secret so CI doesn't depend on the public RPC.

The static site runs the same lookup code in the visitor's browser
(`npm run build:pages` builds it into `_site/`). An import map swaps the few
Node built-ins for `web/shims/` and the `buffer` package. Differences from the local server:

- Lookups go from the browser to `solana-rpc.publicnode.com` by default
  (`api.mainnet-beta.solana.com` rejects browser requests). Visitors can set their own RPC in the footer.
  The default doesn't serve top holders or full transaction history.
- Custom labels are stored in the visitor's browser (localStorage), not in `data/custom.json`.

## What it does

**Directory**: filter by category (launchpad, dex, aggregator, mev…), type
(program, fee-recipient, fee-vault, authority, config, tip-account, mint…) and
protocol, or free-text search. Each entry shows where it came from:

| source    | meaning |
|-----------|---------|
| `chain`   | Read from an on-chain config account (e.g. Pump.fun `Global.fee_recipients`) or the Jito block engine by `npm run sync` |
| `derived` | Computed PDA / ATA (e.g. Pump.fun event authority, WSOL accounts of fee recipients) |
| `repo`    | Already used by the bots in this workspace |
| `curated` | Hand-maintained in `data/registry.json` |
| `custom`  | Your own labels (`data/custom.json`) |

Every entry is checked against mainnet by `npm run verify`.

**Look up**: paste any address and it is classified:

- **Program**: upgrade authority, last deploy slot, Anchor IDL name, and the program's self-declared `security.txt`
- **Token mint**: name/symbol (Metaplex or Token-2022 metadata), supply, authorities, which launchpad it came from (Pump.fun bonding curve, canonical PumpSwap pool, Raydium LaunchLab), and who holds the supply (each top holder resolved to a curve / pool / wallet)
- **Token account**: mint, owner (labelled), balance, whether it's the owner's canonical ATA
- **Program-owned account**: account type matched by Anchor discriminator and **decoded with the program's own IDL** (fetched on-chain), e.g. Pump.fun `BondingCurve`, PumpSwap `Pool`, Meteora `LbPair`, Whirlpool, LaunchLab `PoolState`; Raydium AMM v4 / CPMM / CLMM via local layouts
- **Wallet / PDA**: keypair vs PDA, SOL balance, token holdings (on demand)
- **Nonexistent**: whether it's an unused keypair or a signer-only PDA
- Last activity for everything

Every address that appears in a result is labelled from the registry and clickable.

## CLI

```bash
node src/cli.js search pump fee              # registry search
node src/cli.js search --category launchpad --type program
node src/cli.js whois <address> [--holdings] [--json]
node src/cli.js label <address> "Axiom fee wallet" --protocol Axiom --category aggregator --type fee-recipient
node src/cli.js unlabel <address>
npm run sync                                 # refresh on-chain sourced entries
npm run verify                               # check every entry against mainnet (exit 1 on mismatch)
npm test                                     # offline unit tests
```

## HTTP API

| endpoint | |
|---|---|
| `GET /api/search?q=&category=&type=&protocol=` | registry search |
| `GET /api/facets` | categories / types / protocols with counts |
| `GET /api/whois/:address[?holdings][&fresh]` | reverse lookup (cached 30 s) |
| `GET /api/export` | the whole registry as JSON, for other bots to consume |
| `POST /api/labels` `{address, name, protocol?, category?, type?, notes?}` | add a custom label |
| `DELETE /api/labels/:address` | remove your labels for an address |

The server binds to `127.0.0.1` by default because the label endpoints write to disk.
Set `HOST` only behind something that authenticates.

## Adding addresses

- **Static addresses** (program IDs, mints): add to `data/registry.json` under the right protocol, then `npm run verify`.
- **Addresses that live in a config account** (fee recipients, admins): add a source to `SOURCES` in `src/sync.js`. It decodes the account with the program's IDL, so you only map field names to labels.
- **Deterministic PDAs**: add to `DERIVED` in `src/sync.js`.
- **Programs without an on-chain IDL**: drop a (partial) Anchor IDL at `data/idl/<programId>.json`; only leading fields are needed.

## Known limits

- The public RPC rate-limits `getTokenLargestAccounts`, so "top holders" often needs `RPC_URL`.
- Launch-origin detection is exact for Pump.fun, PumpSwap and LaunchLab. Other venues show up through the top-holders analysis rather than a direct PDA check.
- Third-party bot/terminal fee wallets (Axiom, Photon, BullX…) aren't shipped because they can't be verified from chain alone. Label them yourself as you confirm them.
