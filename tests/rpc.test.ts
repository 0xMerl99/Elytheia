import { describe, expect, it } from 'vitest';
import { ALLOWED_SOLANA_METHODS, checkRpcBody } from '../server/rpcProxy';

const req = (method: string, params: unknown[] = []) => ({ jsonrpc: '2.0', id: 1, method, params });

describe('solana rpc proxy allow-list', () => {
  it('allows every method the pump.fun flow needs', () => {
    for (const m of ['getAccountInfo', 'getBalance', 'getLatestBlockhash', 'getSignatureStatuses', 'getTokenAccountBalance', 'simulateTransaction', 'sendTransaction', 'getMinimumBalanceForRentExemption']) {
      expect(checkRpcBody(req(m)).ok, m).toBe(true);
    }
  });

  it('refuses anything else, including methods that could be abused or are expensive', () => {
    for (const m of ['getProgramAccounts', 'getTokenLargestAccounts', 'requestAirdrop', 'getBlock', 'getSignaturesForAddress', 'getHealth', 'getVoteAccounts', 'sendBundle', '']) {
      const r = checkRpcBody(req(m));
      expect(r.ok, m).toBe(false);
    }
  });

  it('is not an open relay: rejects malformed bodies', () => {
    for (const bad of [null, undefined, 'x', 42, [], {}, { jsonrpc: '1.0', method: 'getBalance' }, { jsonrpc: '2.0' }, { jsonrpc: '2.0', method: 'getBalance', params: 'nope' }]) {
      expect(checkRpcBody(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('caps batch size and rejects a batch with one bad member', () => {
    expect(checkRpcBody(Array.from({ length: 10 }, () => req('getBalance'))).ok).toBe(true);
    expect(checkRpcBody(Array.from({ length: 11 }, () => req('getBalance'))).ok).toBe(false);
    expect(checkRpcBody([req('getBalance'), req('getProgramAccounts')]).ok).toBe(false);
  });

  it('keeps the list small and read/submit only', () => {
    expect(ALLOWED_SOLANA_METHODS.size).toBeLessThanOrEqual(12);
    for (const m of ALLOWED_SOLANA_METHODS) expect(/^(get|simulate|send)/.test(m)).toBe(true);
  });
});
