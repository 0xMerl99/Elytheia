/**
 * Trade adapters: one interface, two chains. Every trade is signed by the user's own wallet.
 *   evm  - the Launchpad contract on the EVM chain, signed in the user's EVM wallet
 *   pump - pump.fun's program on Solana, signed in the user's Solana wallet (see ./pumpAdapter)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from './app';
import type { Coin, Quote } from './types';
import { buyTx, claimTx, friendlyEvmError, readCreatorFees, readMarketState, readTokenBalance, sellTx } from './evm';
import { CHAINS, feeBpsAt, initialState, quoteBuy as engineBuy, quoteSell as engineSell, type PoolState } from '../../shared/market';
import { usePumpAdapter } from './pumpAdapter';
import { syncChain } from './sync';

export interface ExecResult {
  message: string;
  graduated?: boolean;
}

export interface TradeAdapter {
  kind: 'evm' | 'pump';
  /** A wallet that can trade this coin is connected. */
  ready: boolean;
  /** Open the right connect dialog. */
  connect: () => void;
  balance: number;
  held: number;
  walletLimit: number | null;
  claimable: { holder: number; creator: number; claimed: number } | null;
  isCreator: boolean;
  /** Reload balances / rewards (call after a trade). */
  refresh: () => Promise<void>;
  quote: (side: 'buy' | 'sell', amount: number, percent?: number) => Promise<Quote>;
  execute: (side: 'buy' | 'sell', amount: number, percent: number | undefined, quote: Quote, slippageBps: number) => Promise<ExecResult>;
  claim: () => Promise<{ claimed: number; quote: string }>;
  /** Human-readable note shown above the trade button (e.g. "estimate"). */
  note?: string;
}

const fmt = (n: number, d = 4) => n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 2 : n >= 1 ? 3 : d });

/* ------------------------------------------------------------------- evm */

/**
 * Coins on the EVM chain live in a Uniswap v4 pool (constant product with a virtual reserve). Quotes are worked out here
 * from the pool's reserves and the fee schedule (1% + a launch surcharge that decays over two minutes); the contract
 * enforces the real limits (`minOut`), so a small rounding difference can only ever cause a clean slippage revert.
 */
function useEvmAdapter(coin: Coin, refreshKey: number, enabled: boolean): TradeAdapter {
  const { evmCfg, evmAddress, nativeBalances, refreshNativeBalances, ensureChainWallet, config } = useApp();
  const ref = useMemo(() => {
    const m = /^hyp-\d+-(\d+)$/.exec(coin.id);
    return m ? BigInt(m[1]) : null;
  }, [coin.id]);
  const [held, setHeld] = useState(0);
  const [claimable, setClaimable] = useState<{ holder: number; creator: number; claimed: number } | null>(null);
  const [tokenMeta] = useState({ decimals: 6 });
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!enabled || !evmCfg || ref === null) return;
    const my = ++seq.current;
    try {
      if (evmAddress) {
        const [bal, fees] = await Promise.all([readTokenBalance(evmCfg, coin.address as `0x${string}`, evmAddress), readCreatorFees(evmCfg, ref)]);
        if (my === seq.current) {
          setHeld(Number(bal) / 10 ** tokenMeta.decimals);
          const mine = fees.creator.toLowerCase() === evmAddress.toLowerCase();
          setClaimable(mine ? { holder: 0, creator: Number(fees.native) / 1e18, claimed: 0 } : null);
        }
      } else if (my === seq.current) {
        setHeld(0);
        setClaimable(null);
      }
    } catch {
      /* RPC hiccup: keep the previous values */
    }
  }, [enabled, evmCfg, ref, evmAddress, coin.address, tokenMeta.decimals]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const stateFor = async (): Promise<PoolState | null> => {
    if (!evmCfg || ref === null) return null;
    const m = await readMarketState(evmCfg, ref);
    // the shared engine works in 1e-9 quote units; the chain in wei
    return { model: 'pool', vq: Number(m.vq / 1_000_000_000n), vt: Number(m.vt), realQuote: 0, realTokens: Number(m.vt) };
  };

  /** the fee the hook will charge right now: 1% plus the launch surcharge, decaying linearly to 0 over 120 s */
  const feeBpsNow = () => feeBpsAt(CHAINS.hyp, Math.max(0, (Date.now() - coin.createdAt) / 1000));

  const isCreator = !!evmAddress && coin.creator.toLowerCase() === evmAddress.toLowerCase();

  return {
    kind: 'evm',
    ready: !!evmAddress,
    connect: () => {
      ensureChainWallet('hyp'); // opens the connect dialog when no EVM wallet is connected
    },
    balance: nativeBalances.hype ?? 0,
    held,
    walletLimit: null, // a Uniswap v4 pool has no per-wallet cap
    claimable,
    isCreator,
    refresh: async () => {
      await Promise.all([load(), refreshNativeBalances()]);
    },
    quote: async (side, amount, percent) => {
      if (!evmCfg || ref === null) return { ok: false, error: 'The EVM chain is not configured' };
      try {
        const st = await stateFor();
        if (!st) return { ok: false, error: 'Pool not found' };
        const feeBps = feeBpsNow();
        if (side === 'buy') {
          if (!amount) return { ok: false, error: 'Enter an amount' };
          const eng = engineBuy(CHAINS.hyp, st, Math.round(amount * 1e9), feeBps);
          if (!eng.ok) return { ok: false, error: eng.error };
          return {
            ok: true,
            side,
            pay: amount,
            out: eng.tokensOut / 1e6,
            fee: eng.fee / 1e9,
            feeBps,
            refund: 0,
            impactPct: eng.impactPct,
            graduates: false,
          };
        }
        const tokens = percent !== undefined ? Math.floor(((held * percent) / 100) * 1e6) : Math.round(amount * 1e6);
        if (tokens <= 0) return { ok: false, error: 'Enter an amount' };
        const eng = engineSell(CHAINS.hyp, st, tokens, feeBps);
        if (!eng.ok) return { ok: false, error: eng.error };
        return {
          ok: true,
          side,
          pay: tokens / 1e6,
          out: eng.netOut / 1e9,
          fee: eng.fee / 1e9,
          feeBps,
          refund: 0,
          impactPct: eng.impactPct,
          graduates: false,
        };
      } catch (e) {
        return { ok: false, error: friendlyEvmError(e) };
      }
    },
    execute: async (side, amount, percent, quote, slippageBps) => {
      if (!evmCfg || ref === null || !evmAddress) throw new Error('Connect an EVM wallet first');
      // the quote is an estimate (the surcharge keeps decaying while the wallet prompt is open), so allow for that
      const keep = 1 - slippageBps / 10_000;
      if (side === 'buy') {
        const wei = BigInt(Math.round(amount * 1e9)) * 1_000_000_000n;
        const minOut = BigInt(Math.floor((quote.out ?? 0) * 1e6 * keep));
        await buyTx(evmCfg, evmAddress, ref, wei, minOut);
        await syncChain();
        return { message: `Bought ${fmt(quote.out ?? 0)} $${coin.symbol} for ${fmt(amount)} HYPE` };
      }
      // sell: use the exact on-chain balance when selling a percentage, so "100%" really empties the wallet
      let tokens: bigint;
      if (percent !== undefined) {
        const bal = await readTokenBalance(evmCfg, coin.address as `0x${string}`, evmAddress);
        tokens = (bal * BigInt(Math.round(percent * 100))) / 10_000n;
      } else tokens = BigInt(Math.round(amount * 1e6));
      const minOut = BigInt(Math.floor((quote.out ?? 0) * 1e18 * keep));
      await sellTx(evmCfg, evmAddress, ref, tokens, minOut);
      await syncChain();
      return { message: `Sold ${fmt(Number(tokens) / 1e6)} $${coin.symbol} for ${fmt(quote.out ?? 0)} HYPE` };
    },
    claim: async () => {
      if (!evmCfg || ref === null || !evmAddress) throw new Error('Connect an EVM wallet first');
      await claimTx(evmCfg, evmAddress, ref); // collects the pool's latest fees first, then pays the creator's share
      await syncChain();
      const after = await readCreatorFees(evmCfg, ref).catch(() => null);
      void after;
      return { claimed: claimable?.creator ?? 0, quote: 'HYPE' };
    },
    note: config?.evm?.name ? `A Uniswap v4 pool on ${config.evm.name}. Transactions are signed in your wallet.` : undefined,
  };
}

/* ------------------------------------------------------------------ hook */

export function useTradeAdapter(coin: Coin, refreshKey: number): TradeAdapter {
  const evm = useEvmAdapter(coin, refreshKey, coin.chain === 'hyp');
  const pump = usePumpAdapter(coin, refreshKey, coin.chain === 'sol');
  return coin.chain === 'hyp' ? evm : pump;
}

export { initialState, syncChain };
