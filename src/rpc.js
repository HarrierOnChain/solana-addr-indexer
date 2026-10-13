import { Buffer } from 'node:buffer';
export const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

export class Rpc {
  constructor(url = globalThis.process?.env?.RPC_URL || DEFAULT_RPC) {
    this.url = url;
    this.id = 0;
  }

  async call(method, params = []) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 && attempt < 4) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    }
  }

  async getAccountInfo(address, encoding = 'jsonParsed') {
    return (await this.call('getAccountInfo', [address, { encoding }])).value;
  }

  async getMultipleAccounts(addresses, encoding = 'jsonParsed', dataSlice) {
    const out = [];
    for (let i = 0; i < addresses.length; i += 100) {
      const chunk = addresses.slice(i, i + 100);
      const res = await this.call('getMultipleAccounts', [chunk, { encoding, ...(dataSlice && { dataSlice }) }]);
      out.push(...res.value);
    }
    return out;
  }

  async getTokenAccountsByOwner(owner, programId) {
    const res = await this.call('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed' }]);
    return res.value;
  }

  async getTokenLargestAccounts(mint) {
    return (await this.call('getTokenLargestAccounts', [mint])).value;
  }

  async getSignaturesForAddress(address, limit = 1) {
    return this.call('getSignaturesForAddress', [address, { limit }]);
  }
}

/** Raw bytes of an account fetched with base64 encoding (or a jsonParsed fallback). */
export function accountBytes(account) {
  const data = account?.data;
  if (Array.isArray(data) && data[1] === 'base64') return Buffer.from(data[0], 'base64');
  return null;
}
