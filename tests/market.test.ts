import { describe, expect, it } from 'vitest';
import {
  CHAINS, QUOTE_UNIT, TOKEN_UNIT, TOTAL_SUPPLY, feeBpsAt, initialState, marketCap,
  quoteBuy, quoteSell, spotPrice, walletLimitAt,
} from '../shared/market';

const sol = CHAINS.sol;
const hyp = CHAINS.hyp;

describe('bonding curve (sol)', () => {
  it('starts at ~28 SOL market cap', () => {
    expect(marketCap(initialState(sol))).toBeCloseTo(27.96, 1);
  });

  it('buy then sell never returns more than was paid in (fees + curve spread)', () => {
    const s0 = initialState(sol);
    const buy = quoteBuy(sol, s0, 5 * QUOTE_UNIT, 100);
    expect(buy.ok).toBe(true);
    if (!buy.ok) return;
    const sell = quoteSell(sol, buy.next, buy.tokensOut, 100);
    expect(sell.ok).toBe(true);
    if (!sell.ok) return;
    expect(sell.netOut).toBeLessThan(buy.grossIn);
    // round trip loses roughly the two 1% fees
    expect(sell.netOut / buy.grossIn).toBeGreaterThan(0.97);
    // state returns to (almost exactly) where it began
    expect(Math.abs(sell.next.vq - s0.vq)).toBeLessThan(5);
  });

  it('price rises on buys and falls on sells', () => {
    const s0 = initialState(sol);
    const buy = quoteBuy(sol, s0, 1 * QUOTE_UNIT, 100);
    if (!buy.ok) throw new Error('buy failed');
    expect(buy.priceAfter).toBeGreaterThan(buy.priceBefore);
    const sell = quoteSell(sol, buy.next, buy.tokensOut / 2, 100);
    if (!sell.ok) throw new Error('sell failed');
    expect(sell.priceAfter).toBeLessThan(sell.priceBefore);
  });

  it('graduates at ~85 SOL, refunds the excess and keeps price continuous', () => {
    const s0 = initialState(sol);
    const buy = quoteBuy(sol, s0, 200 * QUOTE_UNIT, 100);
    if (!buy.ok) throw new Error('buy failed');
    expect(buy.graduates).toBe(true);
    expect(buy.refund).toBeGreaterThan(0);
    expect(buy.grossIn).toBeLessThan(200 * QUOTE_UNIT);
    // all curve tokens were sold
    expect(buy.tokensOut).toBe(sol.curveTokens);
    expect(buy.next.model).toBe('amm');
    // ~85 SOL net raised
    expect(buy.next.vq / QUOTE_UNIT).toBeCloseTo(85, 0);
    // price continuity across the graduation boundary
    const priceBeforeGrad = (30 + 85) / ((1_073_000_000 - 793_100_000) );
    expect(spotPrice(buy.next) * 1e6 / 1e6).toBeCloseTo(priceBeforeGrad / 1e0, 8);
    // conservation: fee + net == charged
    expect(buy.fee + buy.netIn).toBe(buy.grossIn);
  });

  it('keeps trading after graduation', () => {
    const s0 = initialState(sol);
    const g = quoteBuy(sol, s0, 200 * QUOTE_UNIT, 100);
    if (!g.ok) throw new Error();
    const more = quoteBuy(sol, g.next, 1 * QUOTE_UNIT, 100);
    expect(more.ok).toBe(true);
    if (more.ok) expect(more.graduates).toBe(false);
  });

  it('rejects dust and zero', () => {
    expect(quoteBuy(sol, initialState(sol), 0, 100).ok).toBe(false);
    expect(quoteBuy(sol, initialState(sol), -5, 100).ok).toBe(false);
    expect(quoteSell(sol, initialState(sol), 0, 100).ok).toBe(false);
  });

  it('fee split adds up', () => {
    const q = quoteBuy(sol, initialState(sol), 3 * QUOTE_UNIT, 100);
    if (!q.ok) throw new Error();
    expect(q.creatorFee + q.protocolFee).toBe(q.fee);
    expect(q.creatorFee).toBe(Math.floor((3 * QUOTE_UNIT * 50) / 10_000));
  });
});

describe('locked pool (hyp)', () => {
  it('uses chosen start market cap', () => {
    // the default is one tier of 35.6 HYPE (about $2.75K); a chain may offer several, passed in as startMcapTiers
    expect(marketCap(initialState(hyp, 35.6))).toBeCloseTo(35.6, 3);
    expect(marketCap(initialState(hyp))).toBeCloseTo(35.6, 3);
    expect(marketCap(initialState(hyp, 123))).toBeCloseTo(35.6, 3); // unknown tier falls back to the default
    const multi = { ...hyp, startMcapTiers: [35.6, 71, 142] };
    expect(marketCap(initialState(multi, 142))).toBeCloseTo(142, 3);
    expect(marketCap(initialState(multi, 100))).toBeCloseTo(35.6, 3);
  });

  it('anti-snipe fee decays to the base fee', () => {
    expect(feeBpsAt(hyp, 0)).toBe(2100);
    expect(feeBpsAt(hyp, 60)).toBe(1100);
    expect(feeBpsAt(hyp, 120)).toBe(100);
    expect(feeBpsAt(hyp, 9999)).toBe(100);
    expect(feeBpsAt(sol, 0)).toBe(100);
  });

  it('applies the early wallet limit only inside the window', () => {
    expect(walletLimitAt(hyp, 10)).toBe((TOTAL_SUPPLY * 150) / 10_000);
    expect(walletLimitAt(hyp, 500)).toBeNull();
    expect(walletLimitAt(sol, 0)).toBeNull();
  });

  it('never lets sellers drain more than the pool holds', () => {
    const s0 = initialState(hyp, 800);
    const buy = quoteBuy(hyp, s0, 10 * QUOTE_UNIT, 100);
    if (!buy.ok) throw new Error();
    const sell = quoteSell(hyp, buy.next, buy.tokensOut, 100);
    if (!sell.ok) throw new Error();
    expect(sell.grossOut).toBeLessThanOrEqual(buy.next.realQuote);
  });
});

describe('integer safety', () => {
  it('stays within safe integer range', () => {
    expect(Number.isSafeInteger(TOTAL_SUPPLY)).toBe(true);
    expect(Number.isSafeInteger(1e6 * QUOTE_UNIT)).toBe(true);
    expect(TOKEN_UNIT).toBe(1_000_000);
  });
});
