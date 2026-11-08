/**
 * Market engine shared by the server (authoritative) and the client (previews).
 *
 * All amounts are integers:
 *   - quote assets (SOL / HYPE) use 9 decimals  -> "base units"
 *   - launched tokens use 6 decimals            -> "micro tokens"
 * Products of two reserves exceed 2^53, so every multiply-then-divide goes through BigInt.
 */

export const TOKEN_DECIMALS = 6;
export const QUOTE_DECIMALS = 9;
export const TOKEN_UNIT = 10 ** TOKEN_DECIMALS;
export const QUOTE_UNIT = 10 ** QUOTE_DECIMALS;
export const WHOLE_SUPPLY = 1_000_000_000;
export const TOTAL_SUPPLY = WHOLE_SUPPLY * TOKEN_UNIT; // micro tokens

export type ChainId = 'sol' | 'hyp';
export type QuoteSymbol = 'SOL' | 'HYPE';
export type PoolModel = 'curve' | 'amm' | 'pool';
export type FeeMode = 'creator' | 'holders';

export interface AntiSnipe {
  /** Extra fee (bps) charged at second 0, decaying linearly to zero. */
  startBps: number;
  /** Seconds until the extra fee has fully decayed. */
  durationSec: number;
  /** Max share of supply a non-creator wallet may hold while the window is open (bps). */
  maxWalletBps: number;
  /** Seconds the wallet limit applies. */
  limitSec: number;
}

export interface ChainConfig {
  id: ChainId;
  name: string;
  venue: string;
  quote: QuoteSymbol;
  model: 'curve' | 'pool';
  blurb: string;
  /** Initial virtual quote reserve (base units). For pools this is the chosen start market cap. */
  vq: number;
  /** Initial virtual token reserve (micro tokens). */
  vt: number;
  /** Tokens that can be sold along the curve before graduation (micro tokens). */
  curveTokens: number;
  /** Real quote raised that triggers graduation (base units). 0 = never graduates. */
  graduationQuote: number;
  /** One-off launch fee (base units of the quote asset). 0 = launching is free. */
  launchFee: number;
  baseFeeBps: number;
  /** Part of baseFeeBps routed to the creator (or to holders when reward mode = holders). */
  creatorFeeBps: number;
  antiSnipe: AntiSnipe | null;
  /** Selectable start market caps (quote units, whole) for pool launches. */
  startMcapTiers?: number[];
}

export const CHAINS: Record<ChainId, ChainConfig> = {
  sol: {
    id: 'sol',
    name: 'Solana',
    venue: 'Bonding curve',
    quote: 'SOL',
    model: 'curve',
    blurb: 'Pump-style bonding curve. Graduates to a locked AMM pool at 85 SOL raised.',
    vq: 30 * QUOTE_UNIT,
    vt: 1_073_000_000 * TOKEN_UNIT,
    curveTokens: 793_100_000 * TOKEN_UNIT,
    graduationQuote: 85 * QUOTE_UNIT,
    launchFee: 0,
    baseFeeBps: 100,
    creatorFeeBps: 50,
    antiSnipe: null,
  },
  hyp: {
    id: 'hyp',
    name: 'HyperEVM',
    venue: 'Locked-liquidity pool',
    quote: 'HYPE',
    model: 'pool',
    blurb: 'All 1B tokens seeded into one full-range pool. Liquidity is locked from block zero.',
    vq: Math.round(35.6 * QUOTE_UNIT), // default start: 35.6 HYPE, about $2.75K at HYPE $77
    vt: TOTAL_SUPPLY,
    curveTokens: TOTAL_SUPPLY,
    graduationQuote: 0,
    launchFee: 0,
    baseFeeBps: 100,
    creatorFeeBps: 50,
    antiSnipe: { startBps: 2000, durationSec: 120, maxWalletBps: 150, limitSec: 120 },
    // the start market cap is chosen at deploy time (see scripts/deploy-evm.mjs --tiers); the server reads the real list from the contract
    startMcapTiers: [35.6],
  },
};

export const CHAIN_LIST: ChainConfig[] = [CHAINS.sol, CHAINS.hyp];

/** Creator may not take more than this share of supply with their launch buy. */
export const MAX_CREATOR_BUY_BPS = 2000;

export interface PoolState {
  model: PoolModel;
  vq: number;
  vt: number;
  /** Real quote held by the curve/pool (base units). */
  realQuote: number;
  /** Tokens still available on the curve (curve model only). */
  realTokens: number;
}

export function initialState(chain: ChainConfig, startMcapWhole?: number): PoolState {
  let vq = chain.vq;
  if (chain.model === 'pool' && startMcapWhole && chain.startMcapTiers?.includes(startMcapWhole)) {
    vq = startMcapWhole * QUOTE_UNIT;
  }
  return { model: chain.model, vq, vt: chain.vt, realQuote: 0, realTokens: chain.curveTokens };
}

/* ------------------------------------------------------------------ helpers */

const big = (n: number) => BigInt(Math.trunc(n));
export const mulDiv = (a: number, b: number, c: number): number => {
  if (c === 0) return 0;
  return Number((big(a) * big(b)) / big(c));
};
export const mulDivCeil = (a: number, b: number, c: number): number => {
  if (c === 0) return 0;
  const num = big(a) * big(b);
  const den = big(c);
  return Number((num + den - 1n) / den);
};

/* -------------------------------------------------------------------- price */

/** Quote units per whole token. */
export function spotPrice(s: PoolState): number {
  if (s.vt <= 0) return 0;
  return s.vq / QUOTE_UNIT / (s.vt / TOKEN_UNIT);
}

/** Fully-diluted market cap in whole quote units. */
export function marketCap(s: PoolState): number {
  return spotPrice(s) * WHOLE_SUPPLY;
}

/** Share (0-100) of the curve that has been filled. */
export function curveProgress(chain: ChainConfig, s: PoolState, status: string): number {
  if (chain.model !== 'curve') return 0;
  if (status === 'graduated') return 100;
  const sold = chain.curveTokens - s.realTokens;
  return Math.max(0, Math.min(100, (sold / chain.curveTokens) * 100));
}

/* --------------------------------------------------------------------- fees */

/** Total fee in bps at a given coin age (seconds since launch). */
export function feeBpsAt(chain: ChainConfig, ageSec: number): number {
  let bps = chain.baseFeeBps;
  const a = chain.antiSnipe;
  if (a && ageSec < a.durationSec) {
    bps += Math.floor(a.startBps * Math.max(0, 1 - Math.max(0, ageSec) / a.durationSec));
  }
  return bps;
}

/** Max tokens a non-creator wallet may hold at this age (micro tokens), or null for no limit. */
export function walletLimitAt(chain: ChainConfig, ageSec: number): number | null {
  const a = chain.antiSnipe;
  if (!a || ageSec >= a.limitSec) return null;
  return mulDiv(TOTAL_SUPPLY, a.maxWalletBps, 10_000);
}

function splitFee(fee: number, amount: number, creatorBps: number, totalBps: number) {
  const creatorFee = Math.min(fee, mulDiv(amount, Math.min(creatorBps, totalBps), 10_000));
  return { creatorFee, protocolFee: fee - creatorFee };
}

/* ---------------------------------------------------------------- buy quote */

export interface BuyQuote {
  ok: true;
  /** Quote actually charged (<= requested). */
  grossIn: number;
  refund: number;
  fee: number;
  creatorFee: number;
  protocolFee: number;
  netIn: number;
  tokensOut: number;
  priceBefore: number;
  priceAfter: number;
  /** Price impact in percent (positive). */
  impactPct: number;
  graduates: boolean;
  next: PoolState;
}
export interface QuoteError {
  ok: false;
  error: string;
}

export function graduate(chain: ChainConfig, s: PoolState): PoolState {
  return {
    model: 'amm',
    vq: s.realQuote,
    vt: TOTAL_SUPPLY - chain.curveTokens,
    realQuote: s.realQuote,
    realTokens: 0,
  };
}

export function quoteBuy(
  chain: ChainConfig,
  s: PoolState,
  grossRequested: number,
  feeBps: number,
): BuyQuote | QuoteError {
  const req = Math.floor(grossRequested);
  if (!Number.isFinite(req) || req <= 0) return { ok: false, error: 'Enter an amount' };
  let fee = mulDiv(req, feeBps, 10_000);
  let net = req - fee;
  let tokensOut = mulDiv(s.vt, net, s.vq + net);
  let charged = req;
  let graduates = false;

  if (s.model === 'curve' && tokensOut >= s.realTokens) {
    tokensOut = s.realTokens;
    net = mulDivCeil(s.vq, tokensOut, s.vt - tokensOut);
    charged = Math.min(req, mulDivCeil(net, 10_000, 10_000 - feeBps));
    fee = charged - net;
    graduates = true;
  }
  if (tokensOut <= 0) return { ok: false, error: 'Amount too small' };

  const { creatorFee, protocolFee } = splitFee(fee, charged, chain.creatorFeeBps, feeBps);
  let next: PoolState = {
    ...s,
    vq: s.vq + net,
    vt: s.vt - tokensOut,
    realQuote: s.realQuote + net,
    realTokens: s.model === 'curve' ? s.realTokens - tokensOut : s.realTokens,
  };
  if (graduates) next = graduate(chain, next);

  const priceBefore = spotPrice(s);
  const priceAfter = spotPrice(next);
  return {
    ok: true,
    grossIn: charged,
    refund: req - charged,
    fee,
    creatorFee,
    protocolFee,
    netIn: net,
    tokensOut,
    priceBefore,
    priceAfter,
    impactPct: priceBefore > 0 ? Math.max(0, (priceAfter / priceBefore - 1) * 100) : 0,
    graduates,
    next,
  };
}

/* --------------------------------------------------------------- sell quote */

export interface SellQuote {
  ok: true;
  tokensIn: number;
  grossOut: number;
  fee: number;
  creatorFee: number;
  protocolFee: number;
  netOut: number;
  priceBefore: number;
  priceAfter: number;
  impactPct: number;
  next: PoolState;
}

export function quoteSell(
  chain: ChainConfig,
  s: PoolState,
  tokensRequested: number,
  feeBps: number,
): SellQuote | QuoteError {
  const tokensIn = Math.floor(tokensRequested);
  if (!Number.isFinite(tokensIn) || tokensIn <= 0) return { ok: false, error: 'Enter an amount' };
  const grossOut = mulDiv(s.vq, tokensIn, s.vt + tokensIn);
  if (grossOut <= 0) return { ok: false, error: 'Amount too small' };
  if (s.model !== 'amm' && grossOut > s.realQuote) return { ok: false, error: 'Not enough liquidity' };
  const fee = mulDiv(grossOut, feeBps, 10_000);
  const { creatorFee, protocolFee } = splitFee(fee, grossOut, chain.creatorFeeBps, feeBps);
  const next: PoolState = {
    ...s,
    vq: s.vq - grossOut,
    vt: s.vt + tokensIn,
    realQuote: s.model === 'amm' ? s.realQuote : s.realQuote - grossOut,
    realTokens: s.model === 'curve' ? s.realTokens + tokensIn : s.realTokens,
  };
  const priceBefore = spotPrice(s);
  const priceAfter = spotPrice(next);
  return {
    ok: true,
    tokensIn,
    grossOut,
    fee,
    creatorFee,
    protocolFee,
    netOut: grossOut - fee,
    priceBefore,
    priceAfter,
    impactPct: priceBefore > 0 ? Math.max(0, (1 - priceAfter / priceBefore) * 100) : 0,
    next,
  };
}

/* ------------------------------------------------------------- conversions */

export const toBase = (whole: number) => Math.round(whole * QUOTE_UNIT);
export const toWholeQuote = (base: number) => base / QUOTE_UNIT;
export const toMicro = (whole: number) => Math.round(whole * TOKEN_UNIT);
export const toWholeTokens = (micro: number) => micro / TOKEN_UNIT;

export interface Prices {
  SOL: number;
  HYPE: number;
  updatedAt: number;
}
