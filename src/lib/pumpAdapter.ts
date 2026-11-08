/**
 * Trade adapter for pump.fun coins on Solana: quotes locally from live on-chain state, dry-runs every transaction
 * against the real program, then has the user's own wallet sign and send it. web3.js is loaded lazily so people who
 * never touch a Solana coin never download it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Connection, VersionedTransaction } from '@solana/web3.js';
import { useApp } from './app';
import { getSolanaProvider } from './wallet';
import { absoluteRpcUrl } from './solana';
import { syncChain } from './sync';
import type { Coin, Quote } from './types';
import type { TradeAdapter } from './trading';
import type { CurveInfo, PumpContext } from './pump';

const loadPump = () => import('./pump');
const loadWeb3 = () => import('@solana/web3.js');

const connections = new Map<string, Connection>();
async function getConn(rpcUrl: string): Promise<Connection> {
  let c = connections.get(rpcUrl);
  if (!c) {
    const { Connection } = await loadWeb3();
    c = new Connection(absoluteRpcUrl(rpcUrl), 'confirmed');
    connections.set(rpcUrl, c);
  }
  return c;
}

let ctxCache: { ctx: PumpContext; at: number; rpc: string } | null = null;
async function getCtx(rpcUrl: string, maxAgeMs = 60_000): Promise<PumpContext> {
  if (ctxCache && ctxCache.rpc === rpcUrl && Date.now() - ctxCache.at < maxAgeMs) return ctxCache.ctx;
  const [pump, conn] = await Promise.all([loadPump(), getConn(rpcUrl)]);
  const ctx = await pump.loadPumpContext(conn);
  ctxCache = { ctx, at: Date.now(), rpc: rpcUrl };
  return ctx;
}

/** Wallet signs and sends. Prefers the wallet's own sign-and-send (it simulates and warns the user). */
export async function sendWithWallet(
  walletId: 'phantom' | 'solflare' | 'backpack',
  conn: Connection,
  tx: VersionedTransaction,
): Promise<string> {
  const provider = getSolanaProvider(walletId);
  if (!provider) throw new Error('Your Solana wallet is not available. Reconnect it and try again.');
  try {
    if (typeof provider.signAndSendTransaction === 'function') {
      const r = await provider.signAndSendTransaction(tx);
      const sig = typeof r === 'string' ? r : r?.signature;
      if (!sig) throw new Error('The wallet did not return a transaction signature');
      return sig;
    }
    const signed = await provider.signTransaction(tx);
    return await conn.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
  } catch (e: any) {
    if (e?.code === 4001 || /reject|declin|denied|cancel/i.test(String(e?.message))) throw new Error('Transaction was rejected in your wallet');
    throw e;
  }
}

/** Dry-run first: the real program tells us now (for free) if the transaction would fail. */
export async function preflight(conn: Connection, tx: VersionedTransaction) {
  const pump = await loadPump();
  const sim = await pump.simulate(conn, tx);
  if (!sim.ok) throw new Error(pump.friendlyPumpError(`${sim.error ?? ''} ${sim.logs.join(' ')}`));
}

const fmt = (n: number, d = 4) => n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 2 : n >= 1 ? 3 : d });

export function usePumpAdapter(coin: Coin, refreshKey: number, enabled: boolean): TradeAdapter {
  const { config, solAddress, solWalletId, nativeBalances, refreshNativeBalances, ensureChainWallet } = useApp();
  const rpcUrl = config?.solana?.rpcUrl ?? '';
  const [info, setInfo] = useState<CurveInfo | null>(null);
  const [heldRaw, setHeldRaw] = useState(0n);
  const [claimable, setClaimable] = useState(0);
  const infoAt = useRef(0);

  const isCreator = !!solAddress && coin.creator === solAddress;

  const load = useCallback(async () => {
    if (!enabled || !rpcUrl) return;
    try {
      const [pump, web3, conn] = await Promise.all([loadPump(), loadWeb3(), getConn(rpcUrl)]);
      const mint = new web3.PublicKey(coin.address);
      const ci = await pump.loadCurve(conn, mint);
      setInfo(ci);
      infoAt.current = Date.now();
      if (solAddress) {
        const owner = new web3.PublicKey(solAddress);
        setHeldRaw(await pump.tokenBalance(conn, owner, mint, ci.tokenProgram));
        setClaimable(owner.equals(ci.curve.creator) ? Number(await pump.creatorVaultClaimable(conn, owner)) / 1e9 : 0);
      } else {
        setHeldRaw(0n);
        setClaimable(0);
      }
    } catch {
      /* RPC hiccup: keep what we have */
    }
  }, [enabled, rpcUrl, coin.address, solAddress]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [enabled, load]);

  /** Fresh on-chain curve state (reuses a snapshot younger than 3s so typing doesn't hammer the RPC). */
  const freshInfo = async (): Promise<CurveInfo> => {
    if (info && Date.now() - infoAt.current < 3000) return info;
    const [pump, web3, conn] = await Promise.all([loadPump(), loadWeb3(), getConn(rpcUrl)]);
    const ci = await pump.loadCurve(conn, new web3.PublicKey(coin.address));
    setInfo(ci);
    infoAt.current = Date.now();
    return ci;
  };

  return {
    kind: 'pump',
    ready: !!solAddress && !!solWalletId,
    connect: () => {
      ensureChainWallet('sol'); // opens the connect dialog for a Solana wallet
    },
    balance: nativeBalances.sol ?? 0,
    held: Number(heldRaw) / 1e6,
    walletLimit: null,
    claimable: isCreator || claimable > 0 ? { holder: 0, creator: claimable, claimed: 0 } : null,
    isCreator,
    refresh: async () => {
      await Promise.all([load(), refreshNativeBalances()]);
    },

    quote: async (side, amount, percent): Promise<Quote> => {
      if (!rpcUrl) return { ok: false, error: 'Solana is not configured' };
      try {
        const pump = await loadPump();
        const [ci, ctx] = await Promise.all([freshInfo(), getCtx(rpcUrl)]);
        if (!pump.isSolQuoted(ci.curve.quoteMint)) return { ok: false, error: pump.UNSUPPORTED_QUOTE_MESSAGE };
        if (ci.curve.complete) return { ok: false, error: 'This coin has graduated off the bonding curve. Trade it on its AMM pool.' };
        const rates = pump.feeRatesFor(ci.curve, ctx.feeConfig);
        const feeBps = Number(rates.protocolBps + rates.creatorBps);
        if (side === 'buy') {
          const lamports = BigInt(Math.round(amount * 1e9));
          if (lamports <= 0n) return { ok: false, error: 'Enter an amount' };
          const q = pump.quoteBuyExactSol(ci.curve, rates, lamports);
          if (q.tokensOut <= 0n) return { ok: false, error: 'Amount too small' };
          return {
            ok: true, side, pay: amount, out: Number(q.tokensOut) / 1e6, fee: Number(q.protocolFee + q.creatorFee) / 1e9,
            feeBps, refund: 0, impactPct: q.impactPct, graduates: q.capped,
          };
        }
        const tokens = percent !== undefined ? (heldRaw * BigInt(Math.round(percent * 100))) / 10_000n : BigInt(Math.round(amount * 1e6));
        if (tokens <= 0n) return { ok: false, error: 'Enter an amount' };
        const q = pump.quoteSell(ci.curve, rates, tokens);
        if (q.netSol <= 0n) return { ok: false, error: 'Amount too small' };
        return {
          ok: true, side, pay: Number(tokens) / 1e6, out: Number(q.netSol) / 1e9, fee: Number(q.protocolFee + q.creatorFee) / 1e9,
          feeBps, refund: 0, impactPct: q.impactPct, graduates: false,
        };
      } catch (e: any) {
        return { ok: false, error: e?.message || 'Could not load this coin from Solana' };
      }
    },

    execute: async (side, amount, percent, _quote, slippageBps) => {
      if (!solAddress || !solWalletId) throw new Error('Connect a Solana wallet first');
      const [pump, web3, conn] = await Promise.all([loadPump(), loadWeb3(), getConn(rpcUrl)]);
      const user = new web3.PublicKey(solAddress);
      // always rebuild from FRESH state: pump.fun prices move every second
      const [ci, ctx] = await Promise.all([
        pump.loadCurve(conn, new web3.PublicKey(coin.address)),
        getCtx(rpcUrl, 15_000),
      ]);
      let signature: string;
      let message: string;
      try {
        if (side === 'buy') {
          const lamports = BigInt(Math.round(amount * 1e9));
          const { tx, quote } = await pump.prepareBuy(conn, ctx, ci, user, lamports, slippageBps);
          await preflight(conn, tx);
          signature = await sendWithWallet(solWalletId, conn, tx);
          message = `Bought ≈${fmt(Number(quote.tokensOut) / 1e6)} $${coin.symbol} for ${fmt(amount)} SOL`;
        } else {
          const bal = await pump.tokenBalance(conn, user, ci.mint, ci.tokenProgram);
          let tokens = percent !== undefined ? (bal * BigInt(Math.round(percent * 100))) / 10_000n : BigInt(Math.round(amount * 1e6));
          if (tokens > bal) tokens = bal;
          const { tx, quote } = await pump.prepareSell(conn, ctx, ci, user, tokens, slippageBps);
          await preflight(conn, tx);
          signature = await sendWithWallet(solWalletId, conn, tx);
          message = `Sold ${fmt(Number(tokens) / 1e6)} $${coin.symbol} for ≈${fmt(Number(quote.netSol) / 1e9)} SOL`;
        }
        await pump.confirm(conn, signature);
      } catch (e) {
        throw new Error(pump.friendlyPumpError(e));
      }
      await syncChain();
      return { message };
    },

    claim: async () => {
      if (!solAddress || !solWalletId) throw new Error('Connect a Solana wallet first');
      const [pump, web3, conn] = await Promise.all([loadPump(), loadWeb3(), getConn(rpcUrl)]);
      const user = new web3.PublicKey(solAddress);
      const before = Number(await pump.creatorVaultClaimable(conn, user)) / 1e9;
      if (before <= 0) throw new Error('Nothing to claim yet');
      try {
        const tx = await pump.prepareCollectCreatorFee(conn, user, user);
        await preflight(conn, tx);
        const signature = await sendWithWallet(solWalletId, conn, tx);
        await pump.confirm(conn, signature);
      } catch (e) {
        throw new Error(pump.friendlyPumpError(e));
      }
      return { claimed: before, quote: 'SOL' };
    },

    note: "This trades on pump.fun's real program on Solana mainnet. Quotes are estimates; your wallet signs the transaction.",
  };
}
