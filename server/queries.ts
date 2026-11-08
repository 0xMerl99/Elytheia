import { db, type CoinRow } from './db.js';
import {
  CHAINS,
  QUOTE_UNIT,
  TOKEN_UNIT,
  TOTAL_SUPPLY,
  WHOLE_SUPPLY,
  curveProgress,
  marketCap,
  spotPrice,
  type PoolState,
} from '../shared/market.js';
import { getPrices } from './prices.js';

const stateOf = (c: CoinRow): PoolState => ({
  model: c.model,
  vq: c.vq,
  vt: c.vt,
  realQuote: c.real_quote,
  realTokens: c.real_tokens,
});

/** Plain coin row by id (no joins). */
export const getCoin = (id: string) => db.prepare('SELECT * FROM coins WHERE id = ?').get(id) as CoinRow | undefined;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface CoinListRow extends CoinRow {
  creator_address: string;
  vol24: number;
  vol1h: number;
  price24: number | null;
}

/** Shape sent to the browser. Amounts are whole units (not base units) so the UI never has to scale. */
export function coinJson(c: CoinListRow) {
  const chain = CHAINS[c.chain];
  const s = stateOf(c);
  const usd = getPrices()[chain.quote];
  const price = spotPrice(s);
  const mcapQuote = marketCap(s);
  const startPrice = chain.model === 'curve' ? chain.vq / QUOTE_UNIT / (chain.vt / TOKEN_UNIT) : c.start_mcap / WHOLE_SUPPLY;
  const ref = c.price24 ?? startPrice;
  return {
    id: c.id,
    launchId: c.launch_id,
    chain: c.chain,
    quote: chain.quote,
    address: c.address,
    name: c.name,
    symbol: c.symbol,
    description: c.description,
    image: c.image,
    website: c.website,
    twitter: c.twitter,
    telegram: c.telegram,
    creator: c.creator_address,
    feeMode: c.fee_mode,
    status: c.status,
    model: c.model,
    priceQuote: price,
    priceUsd: price * usd,
    mcapQuote,
    mcapUsd: mcapQuote * usd,
    athUsd: Math.max(c.ath_usd, mcapQuote * usd),
    volumeUsd: c.volume_usd,
    vol24Usd: c.vol24,
    vol1hUsd: c.vol1h,
    change24: ref > 0 ? (price / ref - 1) * 100 : 0,
    trades: c.trades,
    holders: c.holders,
    progress: curveProgress(chain, s, c.status),
    raisedQuote: c.real_quote / QUOTE_UNIT,
    liquidityQuote: c.vq / QUOTE_UNIT,
    soldPct: (c.sold / TOTAL_SUPPLY) * 100,
    holderFeesTotal: c.holder_fees_total / QUOTE_UNIT,
    createdAt: c.created_at,
    graduatedAt: c.graduated_at,
    lastTradeAt: c.last_trade_at,
    startMcap: c.start_mcap,
  };
}

const COIN_SELECT = `
  SELECT c.*, u.address AS creator_address,
    (SELECT COALESCE(SUM(t.usd),0) FROM trades t WHERE t.coin_id = c.id AND t.created_at > @d1) AS vol24,
    (SELECT COALESCE(SUM(t.usd),0) FROM trades t WHERE t.coin_id = c.id AND t.created_at > @h1) AS vol1h,
    (SELECT t.price FROM trades t WHERE t.coin_id = c.id AND t.created_at <= @d1 ORDER BY t.created_at DESC, t.id DESC LIMIT 1) AS price24
  FROM coins c JOIN users u ON u.id = c.creator_id`;

function timeParams() {
  const now = Date.now();
  return { d1: now - DAY, h1: now - HOUR };
}

export function getCoinRow(id: string): CoinListRow | undefined {
  return db.prepare(`${COIN_SELECT} WHERE c.id = @id`).get({ id, ...timeParams() }) as CoinListRow | undefined;
}

export type SortKey = 'new' | 'mcap' | 'volume' | 'hot' | 'live' | 'graduated';

const ORDER: Record<SortKey, string> = {
  new: 'c.created_at DESC',
  mcap: 'c.mcap_usd DESC',
  volume: 'vol24 DESC, c.mcap_usd DESC',
  hot: 'vol1h DESC, c.last_trade_at DESC',
  live: 'c.last_trade_at DESC',
  graduated: 'c.graduated_at DESC',
};

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);

export function listCoins(opts: {
  sort: SortKey;
  q?: string;
  chain?: string;
  limit: number;
  offset: number;
  creatorId?: number;
}) {
  const where: string[] = [];
  const params: Record<string, unknown> = { ...timeParams(), limit: opts.limit, offset: opts.offset };
  if (opts.q) {
    where.push(`(c.name LIKE @q ESCAPE '\\' OR c.symbol LIKE @q ESCAPE '\\' OR c.address LIKE @q ESCAPE '\\')`);
    params.q = `%${likeEscape(opts.q)}%`;
  }
  if (opts.chain === 'sol' || opts.chain === 'hyp') {
    where.push('c.chain = @chain');
    params.chain = opts.chain;
  }
  if (opts.creatorId) {
    where.push('c.creator_id = @creator');
    params.creator = opts.creatorId;
  }
  if (opts.sort === 'graduated') where.push(`c.status = 'graduated'`);
  if (opts.sort === 'live') where.push('c.last_trade_at > 0');
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`${COIN_SELECT} ${w} ORDER BY ${ORDER[opts.sort] ?? ORDER.new} LIMIT @limit OFFSET @offset`)
    .all(params) as CoinListRow[];
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM coins c ${w}`).get(stripTime(params)) as { n: number }
  ).n;
  return { coins: rows.map(coinJson), total };
}

function stripTime(p: Record<string, unknown>) {
  const { limit: _l, offset: _o, d1: _d, h1: _h, ...rest } = p;
  return rest;
}

/* ---------------------------------------------------------------- candles */

export function candles(coinId: string, intervalSec: number, unit: 'usd' | 'quote') {
  const rows = db
    .prepare(
      `SELECT price, mcap_usd, usd, created_at FROM trades WHERE coin_id = ? ORDER BY created_at ASC, id ASC LIMIT 40000`,
    )
    .all(coinId) as { price: number; mcap_usd: number; usd: number; created_at: number }[];
  const out: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  let prev: number | null = null;
  for (const r of rows) {
    const t = Math.floor(r.created_at / 1000 / intervalSec) * intervalSec;
    const v = unit === 'usd' ? r.mcap_usd : r.price * WHOLE_SUPPLY;
    const last = out[out.length - 1];
    if (!last || last.time !== t) {
      const open = prev ?? v;
      out.push({ time: t, open, high: Math.max(open, v), low: Math.min(open, v), close: v, volume: r.usd });
    } else {
      last.high = Math.max(last.high, v);
      last.low = Math.min(last.low, v);
      last.close = v;
      last.volume += r.usd;
    }
    prev = v;
  }
  return out.slice(-1500);
}

/* ----------------------------------------------------------- trades etc. */

export function recentTrades(coinId: string, limit = 50) {
  const rows = db
    .prepare(
      `SELECT t.id, t.side, t.quote, t.tokens, t.fee, t.price, t.usd, t.sig, t.created_at, u.address
       FROM trades t JOIN users u ON u.id = t.user_id
       WHERE t.coin_id = ? AND t.side != 'create' ORDER BY t.id DESC LIMIT ?`,
    )
    .all(coinId, limit) as Array<{
    id: number;
    side: string;
    quote: number;
    tokens: number;
    fee: number;
    price: number;
    usd: number;
    sig: string;
    created_at: number;
    address: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    side: r.side,
    quote: r.quote / QUOTE_UNIT,
    tokens: r.tokens / TOKEN_UNIT,
    price: r.price,
    usd: r.usd,
    sig: r.sig,
    user: r.address,
    createdAt: r.created_at,
  }));
}

export function globalTrades(limit = 20) {
  const rows = db
    .prepare(
      `SELECT t.id, t.side, t.quote, t.usd, t.created_at, u.address, c.id AS coin_id, c.symbol, c.name, c.image, c.chain
       FROM trades t JOIN users u ON u.id = t.user_id JOIN coins c ON c.id = t.coin_id
       WHERE t.side != 'create' ORDER BY t.id DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, any>>;
  return rows.map((r) => ({
    id: r.id,
    side: r.side,
    quote: r.quote / QUOTE_UNIT,
    usd: r.usd,
    user: r.address,
    createdAt: r.created_at,
    coin: { id: r.coin_id, symbol: r.symbol, name: r.name, image: r.image, chain: r.chain },
    quoteSymbol: CHAINS[r.chain as 'sol' | 'hyp'].quote,
  }));
}

export function holders(coin: CoinRow) {
  const rows = db
    .prepare(
      `SELECT u.address, h.amount FROM holdings h JOIN users u ON u.id = h.user_id
       WHERE h.coin_id = ? AND h.amount > 0 ORDER BY h.amount DESC LIMIT 50`,
    )
    .all(coin.id) as { address: string; amount: number }[];
  const creator = db.prepare('SELECT address FROM users WHERE id = ?').get(coin.creator_id) as { address: string };
  const reserve = coin.model === 'curve' ? coin.real_tokens : TOTAL_SUPPLY - coin.sold;
  const list = [
    {
      address: coin.model === 'curve' ? 'Bonding curve' : 'Liquidity pool',
      amount: reserve / TOKEN_UNIT,
      pct: (reserve / TOTAL_SUPPLY) * 100,
      kind: 'pool' as const,
    },
    ...rows.map((r) => ({
      address: r.address,
      amount: r.amount / TOKEN_UNIT,
      pct: (r.amount / TOTAL_SUPPLY) * 100,
      kind: (r.address === creator.address ? 'creator' : 'holder') as 'creator' | 'holder',
    })),
  ];
  return list;
}

export function comments(coinId: string, limit = 100) {
  const rows = db
    .prepare(
      `SELECT m.id, m.text, m.created_at, u.address,
         COALESCE((SELECT h.amount FROM holdings h WHERE h.coin_id = m.coin_id AND h.user_id = m.user_id), 0) AS amount
       FROM comments m JOIN users u ON u.id = m.user_id WHERE m.coin_id = ? ORDER BY m.id DESC LIMIT ?`,
    )
    .all(coinId, limit) as { id: number; text: string; created_at: number; address: string; amount: number }[];
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    user: r.address,
    createdAt: r.created_at,
    holdingPct: (r.amount / TOTAL_SUPPLY) * 100,
  }));
}

/* ------------------------------------------------------------- user pages */

export function profile(address: string) {
  const user = db.prepare('SELECT * FROM users WHERE address = ?').get(address) as
    | { id: number; address: string; created_at: number }
    | undefined;
  if (!user) return null;
  const prices = getPrices();

  const created = listCoins({ sort: 'new', limit: 100, offset: 0, creatorId: user.id }).coins;

  const held = db
    .prepare(
      `SELECT h.coin_id, h.amount, h.claimed,
         (SELECT COALESCE(SUM(CASE WHEN t.side='buy' THEN t.quote END),0) FROM trades t WHERE t.coin_id=h.coin_id AND t.user_id=h.user_id) AS bought,
         (SELECT COALESCE(SUM(CASE WHEN t.side='sell' THEN t.quote - t.fee END),0) FROM trades t WHERE t.coin_id=h.coin_id AND t.user_id=h.user_id) AS sold_q
       FROM holdings h WHERE h.user_id = ? AND (h.amount > 0 OR h.claimed > 0)`,
    )
    .all(user.id) as { coin_id: string; amount: number; claimed: number; bought: number; sold_q: number }[];

  let totalUsd = 0;
  let totalPnlUsd = 0;
  const holdings = [];
  const claimableUsd = 0;
  for (const h of held) {
    const row = getCoinRow(h.coin_id);
    if (!row) continue;
    const coin = coinJson(row);
    const usd = prices[coin.quote];
    const value = (h.amount / TOKEN_UNIT) * coin.priceQuote;
    const pnlQuote = value + h.sold_q / QUOTE_UNIT - h.bought / QUOTE_UNIT;
    totalUsd += value * usd;
    totalPnlUsd += pnlQuote * usd;
    holdings.push({
      coin,
      amount: h.amount / TOKEN_UNIT,
      valueQuote: value,
      valueUsd: value * usd,
      boughtQuote: h.bought / QUOTE_UNIT,
      soldQuote: h.sold_q / QUOTE_UNIT,
      pnlQuote,
      pnlUsd: pnlQuote * usd,
      // rewards are held by the contract / pump.fun, not by this database: the API layer fills this in from the chain
      claimableQuote: 0,
      claimedQuote: h.claimed / QUOTE_UNIT,
    });
  }
  holdings.sort((a, b) => b.valueUsd - a.valueUsd);

  const trades = db
    .prepare(
      `SELECT t.id, t.side, t.quote, t.tokens, t.usd, t.created_at, c.id AS coin_id, c.symbol, c.name, c.image, c.chain
       FROM trades t JOIN coins c ON c.id = t.coin_id WHERE t.user_id = ? AND t.side != 'create'
       ORDER BY t.id DESC LIMIT 60`,
    )
    .all(user.id) as Array<Record<string, any>>;

  return {
    address: user.address,
    joinedAt: user.created_at,
    stats: {
      holdingsUsd: totalUsd,
      pnlUsd: totalPnlUsd,
      claimableUsd,
      coinsCreated: created.length,
    },
    created,
    holdings,
    trades: trades.map((t) => ({
      id: t.id,
      side: t.side,
      quote: t.quote / QUOTE_UNIT,
      quoteSymbol: CHAINS[t.chain as 'sol' | 'hyp'].quote,
      tokens: t.tokens / TOKEN_UNIT,
      usd: t.usd,
      createdAt: t.created_at,
      coin: { id: t.coin_id, symbol: t.symbol, name: t.name, image: t.image, chain: t.chain },
    })),
  };
}

export function globalStats() {
  const now = Date.now();
  const r = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM coins) AS coins,
        (SELECT COUNT(*) FROM coins WHERE status='graduated') AS graduated,
        (SELECT COALESCE(SUM(usd),0) FROM trades WHERE created_at > ?) AS vol24,
        (SELECT COALESCE(SUM(usd),0) FROM trades) AS volAll,
        (SELECT COUNT(DISTINCT user_id) FROM trades WHERE created_at > ?) AS traders24,
        (SELECT COUNT(*) FROM trades WHERE side != 'create') AS trades`,
    )
    .get(now - DAY, now - DAY) as Record<string, number>;
  return {
    coins: r.coins,
    graduated: r.graduated,
    volume24Usd: r.vol24,
    volumeAllUsd: r.volAll,
    traders24: r.traders24,
    trades: r.trades,
  };
}
