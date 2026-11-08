import fs from 'node:fs';
import path from 'node:path';
import type { Prices } from '../shared/market.js';
import { DATA_DIR } from './config.js';

/**
 * USD prices come from CoinGecko only. There are no made-up fallback numbers: the last prices that were actually
 * fetched are kept on disk, so a restart while the feed is down still shows real (if slightly old) values, and
 * `updatedAt` says how old they are. A price of 0 means "never fetched yet".
 *
 * HYPE is Hyperliquid's HYPE price. That is only right for an EVM chain whose HYPE is redeemable 1:1 for it (a bridged
 * HYPE). For anything else pin the quote token's USD price yourself with EVM_QUOTE_USD (see .env.example).
 */
const FILE = path.join(DATA_DIR, 'prices.json');
const pinned = Number(process.env.EVM_QUOTE_USD);
const HYPE_PINNED = Number.isFinite(pinned) && pinned > 0 ? pinned : 0;

const positive = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function load(): Prices {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<Prices>;
    return { SOL: positive(j.SOL), HYPE: HYPE_PINNED || positive(j.HYPE), updatedAt: Number(j.updatedAt) || 0 };
  } catch {
    return { SOL: 0, HYPE: HYPE_PINNED, updatedAt: 0 };
  }
}

let prices: Prices = load();

export const getPrices = (): Prices => prices;

/** Returns true when a fresh price was fetched. */
export async function refreshPrices(): Promise<boolean> {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana,hyperliquid&vs_currencies=usd', {
      signal: AbortSignal.timeout(6000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return false;
    const j = (await res.json()) as { solana?: { usd?: number }; hyperliquid?: { usd?: number } };
    const sol = positive(j.solana?.usd) || prices.SOL;
    const hype = HYPE_PINNED || positive(j.hyperliquid?.usd) || prices.HYPE;
    if (!sol && !hype) return false;
    prices = { SOL: sol, HYPE: hype, updatedAt: Date.now() };
    try {
      fs.writeFileSync(FILE, JSON.stringify(prices));
    } catch {
      /* read-only data dir: the in-memory prices still work */
    }
    return true;
  } catch {
    return false; // offline / rate limited: keep what we have
  }
}

/** Resolves after the FIRST attempt, so callers can wait for a real price before they record USD figures. */
export async function startPriceLoop(): Promise<void> {
  let ok = await refreshPrices();
  if (!ok && !prices.SOL) console.warn('[prices] could not reach the price feed yet: USD values stay empty until it can (retrying)');
  const tick = async () => {
    ok = await refreshPrices();
    // until the first success, retry quickly; afterwards every few minutes
    schedule(ok || prices.updatedAt ? 3 * 60 * 1000 : 30 * 1000);
  };
  const schedule = (ms: number) => setTimeout(() => void tick(), ms).unref();
  schedule(ok || prices.updatedAt ? 3 * 60 * 1000 : 30 * 1000);
}
