/** Lightweight Solana JSON-RPC helpers (no web3.js, so they cost nothing in the main bundle). */

let rpcId = 0;

export async function solRpc<T = any>(rpcUrl: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(absoluteRpcUrl(rpcUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`Solana RPC ${method} failed (${res.status})`);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || `Solana RPC ${method} error`);
  return j.result as T;
}

/** SOL balance of an address, in whole SOL. */
export async function solBalance(rpcUrl: string, address: string): Promise<number> {
  const r = await solRpc<{ value: number }>(rpcUrl, 'getBalance', [address, { commitment: 'confirmed' }]);
  return r.value / 1e9;
}

/** web3.js's Connection needs an absolute URL; the config hands us a path on this site (the RPC proxy). */
export function absoluteRpcUrl(u: string): string {
  return u.startsWith('/') ? `${window.location.origin}${u}` : u;
}
