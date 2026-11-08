/**
 * Allow-listed Solana JSON-RPC proxy.
 *
 * Why it exists: Solana's public RPC refuses browser requests (HTTP 403 for any request with an Origin header), and a
 * paid RPC's API key must never be sent to visitors. So the browser talks only to this server, which forwards a short
 * list of read/submit methods to the real endpoint it holds privately (SOL_RPC_URL).
 *
 * It is deliberately not an open relay: only the methods the app needs are allowed, batches are capped, and nothing
 * here can reach anything but the configured RPC.
 */

/** Everything the browser's pump.fun flow needs, and nothing more. */
export const ALLOWED_SOLANA_METHODS = new Set([
  'getAccountInfo',
  'getBalance',
  'getBlockHeight',
  'getFeeForMessage',
  'getLatestBlockhash',
  'getMinimumBalanceForRentExemption',
  'getMultipleAccounts',
  'getSignatureStatuses',
  'getTokenAccountBalance',
  'sendTransaction',
  'simulateTransaction',
]);

const MAX_BATCH = 10;

export type RpcCheck = { ok: true } | { ok: false; error: string };

/** Validates a JSON-RPC request body (single or batch) against the allow-list. Pure, so it is unit-tested. */
export function checkRpcBody(body: unknown): RpcCheck {
  const items = Array.isArray(body) ? body : [body];
  if (items.length === 0 || items.length > MAX_BATCH) return { ok: false, error: `Send between 1 and ${MAX_BATCH} requests` };
  for (const it of items) {
    if (!it || typeof it !== 'object') return { ok: false, error: 'Malformed JSON-RPC request' };
    const r = it as { jsonrpc?: unknown; method?: unknown; params?: unknown };
    if (r.jsonrpc !== '2.0') return { ok: false, error: 'Malformed JSON-RPC request' };
    if (typeof r.method !== 'string' || !ALLOWED_SOLANA_METHODS.has(r.method)) {
      return { ok: false, error: `Method not allowed: ${String(r.method).slice(0, 40)}` };
    }
    if (r.params !== undefined && !Array.isArray(r.params)) return { ok: false, error: 'params must be an array' };
  }
  return { ok: true };
}
