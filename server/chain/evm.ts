/**
 * EVM indexer for the Uniswap v4 launchpad. It turns two event streams into the read-model tables the UI uses
 * (coins / trades / holdings). The chain is the source of truth; this database only mirrors it.
 *
 *   1. the launchpad's own events (CoinCreated, Traded, FeesCollected, Claimed)
 *   2. Uniswap's PoolManager `Swap` events for OUR pools only, so a trade made through ANY Uniswap router shows up
 *      in the feed exactly like one made on this site
 *
 * Guarantees:
 *  - exactly-once: every log is recorded in `chain_events` in the same SQLite transaction that applies it, and the
 *    block cursor advances in that transaction too, so a crash can never double-apply or skip a log;
 *  - ordered: logs are applied in (block, logIndex) order, one batch at a time, behind a mutex;
 *  - authoritative balances: holder balances and the creator's fee balance are re-read from the chain after each batch.
 */
import { createPublicClient, decodeEventLog, defineChain, getAddress, http, type Log } from 'viem';
import { db, getKv, setKv } from '../db.js';
import { EVM, PUBLIC_URL } from '../config.js';
import { launchpadAbi } from '../../shared/launchpadAbi.js';
import { poolManagerSwapEvent, tokenAbi } from '../../shared/v4Abi.js';
import { QUOTE_UNIT, TOKEN_UNIT, WHOLE_SUPPLY, marketCap, spotPrice, type PoolState } from '../../shared/market.js';
import { getOrCreateUser } from '../auth.js';
import { getPrices } from '../prices.js';
import { publish } from '../stream.js';
import { coinJson, getCoinRow } from '../queries.js';
import { fetchMetadata } from './metadata.js';

const chain = defineChain({
  id: EVM.chainId,
  name: EVM.name,
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: { default: { http: [EVM.rpcUrl] } },
});

export const evmClient = createPublicClient({ chain, transport: http(EVM.rpcUrl, { timeout: 15_000, retryCount: 2 }) });

const TOTAL_TOKENS = WHOLE_SUPPLY * TOKEN_UNIT;
const Q96 = 2n ** 96n;
const q = (wei: bigint) => Number(wei / 1_000_000_000n); // wei -> 1e-9 units used by the read model
export const coinKey = (id: bigint | number | string) => `hyp-${EVM.chainId}-${id}`;
const cursorKey = () => `evm:${EVM.chainId}:${EVM.launchpad.toLowerCase()}:cursor`;
const poolKvKey = (poolId: string) => `evm:${EVM.chainId}:${EVM.launchpad.toLowerCase()}:pool:${poolId.toLowerCase()}`;

export const evmEnabled = () => !!EVM.launchpad;
const pad = () => EVM.launchpad as `0x${string}`;

/* ------------------------------------------------------- facts read from the deployed contracts */

export interface EvmParams {
  poolManager: `0x${string}`;
  hook: `0x${string}`;
  startSqrtPrice: bigint;
  seedLiquidity: bigint;
  tiers: number[];
}
let params: EvmParams | null = null;
/** What the deployed launchpad says about itself (pool manager, hook, start price, tiers), or null until it has been read. */
export const getEvmParams = (): EvmParams | null => params;
export const getEvmTiers = (): number[] | null => params?.tiers ?? null;

async function loadParams(): Promise<EvmParams> {
  if (params) return params;
  const read = (functionName: string) => evmClient.readContract({ address: pad(), abi: launchpadAbi, functionName } as any);
  const [poolManager, hook, startSqrtPrice, seedLiquidity, tiers] = await Promise.all([
    read('poolManager'),
    read('hook'),
    read('startSqrtPrice'),
    read('seedLiquidity'),
    read('startMcapTiers'),
  ]);
  params = {
    poolManager: poolManager as `0x${string}`,
    hook: hook as `0x${string}`,
    startSqrtPrice: BigInt(startSqrtPrice as bigint),
    seedLiquidity: BigInt(seedLiquidity as bigint),
    tiers: (tiers as readonly bigint[]).map((t) => Number(t) / 1e18),
  };
  console.log(`[evm] launchpad ${EVM.launchpad}: pool manager ${params.poolManager}, hook ${params.hook}, start market cap ${params.tiers.join(' / ')} HYPE`);
  return params;
}

/** pool id -> coin id, mirrored in memory (and persisted in kv as coins are created) */
const pools = new Map<string, string>();
function loadPools() {
  pools.clear();
  const prefix = poolKvKey('');
  const rows = db.prepare(`SELECT k, v FROM kv WHERE k LIKE ?`).all(`${prefix}%`) as { k: string; v: string }[];
  for (const r of rows) pools.set(r.k.slice(prefix.length), r.v);
}

/* ---------------------------------------------------------------- batch apply */

type Decoded = { eventName: string; args: Record<string, any> };

function decodeLaunchpad(log: Log): Decoded | null {
  try {
    return decodeEventLog({ abi: launchpadAbi, data: log.data, topics: log.topics as [`0x${string}`] }) as unknown as Decoded;
  } catch {
    return null; // not one we use (e.g. OwnershipTransferred)
  }
}

function decodeSwap(log: Log): Decoded | null {
  try {
    return decodeEventLog({ abi: [poolManagerSwapEvent], data: log.data, topics: log.topics as [`0x${string}`] }) as unknown as Decoded;
  } catch {
    return null;
  }
}

/** Constant-product equivalent of a pool at a price: vq (wei) and vt (token units) with vq * vt = L^2. */
function reservesAt(sqrtP: bigint, L: bigint, startSqrt: bigint) {
  const vq = (L * Q96) / sqrtP;
  const vt = (L * sqrtP) / Q96;
  const vq0 = (L * Q96) / startSqrt;
  return { vq, vt, realQuote: vq > vq0 ? vq - vq0 : 0n };
}

function stateOf(vq: bigint, vt: bigint, realQuote: bigint): PoolState {
  return { model: 'pool', vq: q(vq), vt: Number(vt), realQuote: q(realQuote), realTokens: Number(vt) };
}

interface Applied {
  touched: Set<string>;
  balances: Map<string, { coin: string; user: `0x${string}` }>;
  trades: { coinId: string; trade: Record<string, unknown> }[];
  created: string[];
}

interface Ctx {
  startSqrt: bigint;
  seedL: bigint;
  blockTime: Map<bigint, number>; // block number -> ms
  txFrom: Map<string, `0x${string}`>; // swap tx hash -> the wallet that sent it
  traded: Map<string, { trader: `0x${string}`; isBuy: boolean; used: boolean }[]>; // launchpad attribution by tx
}

function applyLaunchpadLog(log: Log, ev: Decoded, out: Applied): boolean {
  const a = ev.args;
  const usdPrice = getPrices().HYPE;
  switch (ev.eventName) {
    case 'CoinCreated': {
      const id = coinKey(a.id);
      const creator = getOrCreateUser(getAddress(a.creator));
      const createdMs = Number(a.createdAt) * 1000;
      const st = stateOf(a.startMcap, BigInt(TOTAL_TOKENS), 0n);
      const mc = marketCap(st) * usdPrice;
      db.prepare(
        `INSERT OR IGNORE INTO coins(id, launch_id, chain, address, name, symbol, description, image, website, twitter, telegram,
           creator_id, fee_mode, status, model, vq, vt, real_quote, real_tokens, mcap_usd, ath_usd, start_mcap, created_at,
           metadata_uri, meta_state, chain_ref)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, null, 'hyp', getAddress(a.token), a.name, String(a.symbol).toUpperCase(), '', null, null, null, null,
        creator.id, 'creator', 'live', 'pool', st.vq, st.vt, 0, st.vt, mc, mc,
        Number(a.startMcap) / 1e18, createdMs, a.metadataURI || null, a.metadataURI ? 'pending' : 'none', String(a.id),
      );
      const poolId = String(a.poolId).toLowerCase();
      pools.set(poolId, id);
      setKv(poolKvKey(poolId), id);
      // opening price for the chart
      db.prepare(
        `INSERT INTO trades(coin_id, user_id, side, quote, tokens, fee, price, usd, mcap_usd, sig, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, creator.id, 'create', 0, 0, 0, spotPrice(st), 0, mc, `${log.transactionHash}`, createdMs);
      out.created.push(id);
      out.touched.add(id);
      return true;
    }
    case 'FeesCollected':
    case 'Claimed': {
      const id = coinKey(a.id);
      if (!db.prepare('SELECT 1 FROM coins WHERE id = ?').get(id)) return false;
      out.touched.add(id); // creator_fees is re-read from the contract
      return true;
    }
    default:
      return false; // Traded is only attribution (handled with the swap); ownership / withdrawals don't touch the read model
  }
}

function applySwap(log: Log, ev: Decoded, out: Applied, ctx: Ctx): boolean {
  const a = ev.args;
  const id = pools.get(String(a.id).toLowerCase());
  if (!id) return false;
  const usdPrice = getPrices().HYPE;

  const amount0 = BigInt(a.amount0);
  const amount1 = BigInt(a.amount1);
  const isBuy = amount0 < 0n; // the swapper paid native and received the token
  const quoteWei = isBuy ? -amount0 : amount0;
  const tokens = isBuy ? amount1 : -amount1;

  // who traded: the launchpad reports it for trades that went through it; otherwise the wallet that sent the transaction
  const txHash = String(log.transactionHash);
  let trader: `0x${string}` | undefined;
  if (String(a.sender).toLowerCase() === EVM.launchpad.toLowerCase()) {
    const t = ctx.traded.get(txHash)?.find((x) => !x.used && x.isBuy === isBuy);
    if (t) {
      t.used = true;
      trader = t.trader;
    }
  }
  trader = trader ?? ctx.txFrom.get(txHash) ?? (getAddress(String(a.sender)) as `0x${string}`);
  const user = getOrCreateUser(getAddress(trader));

  const { vq, vt, realQuote } = reservesAt(BigInt(a.sqrtPriceX96), ctx.seedL, ctx.startSqrt);
  const st = stateOf(vq, vt, realQuote);
  const mcUsd = marketCap(st) * usdPrice;
  const quoteUnits = q(quoteWei);
  const usd = (quoteUnits / QUOTE_UNIT) * usdPrice;
  const feePips = BigInt(a.fee);
  // fee in quote units: on a buy it comes off what was paid; on a sell it came off the tokens, so value it at the payout
  const feeWei = isBuy ? (quoteWei * feePips) / 1_000_000n : (quoteWei * feePips) / (1_000_000n - feePips);
  const ts = ctx.blockTime.get(BigInt(log.blockNumber!)) ?? Date.now();

  db.prepare(
    `INSERT INTO trades(coin_id, user_id, side, quote, tokens, fee, price, usd, mcap_usd, sig, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, user.id, isBuy ? 'buy' : 'sell', quoteUnits, Number(tokens), q(feeWei), spotPrice(st), usd, mcUsd, txHash, ts);
  db.prepare(
    `UPDATE coins SET vq=?, vt=?, real_quote=?, real_tokens=?, sold=?, volume_quote = volume_quote + ?, volume_usd = volume_usd + ?,
       trades = trades + 1, mcap_usd = ?, ath_usd = MAX(ath_usd, ?), last_trade_at = MAX(last_trade_at, ?) WHERE id = ?`,
  ).run(st.vq, st.vt, st.realQuote, st.realTokens, TOTAL_TOKENS - Number(vt), quoteUnits, usd, mcUsd, mcUsd, ts, id);

  out.touched.add(id);
  out.balances.set(`${id}:${user.address}`, { coin: id, user: getAddress(user.address) as `0x${string}` });
  out.trades.push({
    coinId: id,
    trade: { id: Number(log.logIndex), side: isBuy ? 'buy' : 'sell', quote: quoteUnits, tokens: Number(tokens), price: spotPrice(st), user: user.address, createdAt: ts, sig: txHash },
  });
  return true;
}

/** Pull authoritative numbers that events don't carry (creator fee balance, holder balances) and recount holders. */
async function refreshCoins(out: Applied) {
  for (const id of out.touched) {
    const ref = db.prepare('SELECT chain_ref FROM coins WHERE id = ?').get(id) as { chain_ref: string } | undefined;
    if (!ref?.chain_ref) continue;
    try {
      const info = (await evmClient.readContract({ address: pad(), abi: launchpadAbi, functionName: 'coinInfo', args: [BigInt(ref.chain_ref)] })) as { creatorNative: bigint };
      db.prepare('UPDATE coins SET creator_fees=? WHERE id=?').run(q(info.creatorNative), id);
    } catch (e) {
      console.warn('[evm] coinInfo read failed for', id, (e as Error).message);
    }
  }
  for (const { coin, user } of out.balances.values()) {
    const row = db.prepare('SELECT address FROM coins WHERE id = ?').get(coin) as { address: string } | undefined;
    if (!row) continue;
    try {
      const bal = (await evmClient.readContract({ address: row.address as `0x${string}`, abi: tokenAbi, functionName: 'balanceOf', args: [user] })) as bigint;
      const u = getOrCreateUser(user);
      db.prepare(
        `INSERT INTO holdings(coin_id, user_id, amount) VALUES(?,?,?)
         ON CONFLICT(coin_id, user_id) DO UPDATE SET amount = excluded.amount`,
      ).run(coin, u.id, Number(bal));
    } catch (e) {
      console.warn('[evm] balance read failed for', coin, user, (e as Error).message);
    }
  }
  for (const id of out.touched) {
    db.prepare(`UPDATE coins SET holders = (SELECT COUNT(*) FROM holdings WHERE coin_id = ? AND amount > 0) WHERE id = ?`).run(id, id);
  }
}

/* ------------------------------------------------------------------- main loop */

let running: Promise<void> | null = null;
let needsAnother = false;

/** Index everything up to the chain head. Concurrent callers share one run (and a trailing re-run if needed). */
export function indexEvm(): Promise<void> {
  if (!evmEnabled()) return Promise.resolve();
  if (running) {
    needsAnother = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        needsAnother = false;
        await indexOnce();
      } while (needsAnother);
    } finally {
      running = null;
    }
  })();
  return running;
}

const order = (x: Log, y: Log) => (x.blockNumber === y.blockNumber ? Number(x.logIndex) - Number(y.logIndex) : Number(x.blockNumber! - y.blockNumber!));

async function indexOnce() {
  const p = await loadParams();
  // cacheTime 0: viem caches the head for ~4s by default, which would make an on-demand sync miss the block that
  // was mined a moment ago (the UI calls /chain/sync right after a transaction confirms)
  const head = await evmClient.getBlockNumber({ cacheTime: 0 });
  const stored = getKv(cursorKey());
  let from = stored !== undefined ? BigInt(stored) + 1n : BigInt(EVM.startBlock);
  const CHUNK = 900n; // public RPCs cap eth_getLogs ranges

  while (from <= head) {
    const to = from + CHUNK - 1n < head ? from + CHUNK - 1n : head;

    // 1) the launchpad's own events; they tell us about any pool created in this very range
    const padLogs = (await evmClient.getLogs({ address: pad(), fromBlock: from, toBlock: to })).sort(order);
    const newPools = new Set<string>();
    for (const l of padLogs) {
      const ev = decodeLaunchpad(l);
      if (ev?.eventName === 'CoinCreated') newPools.add(String(ev.args.poolId).toLowerCase());
    }

    // 2) Uniswap swaps in OUR pools only (a topic filter on the pool id keeps this cheap on a busy PoolManager)
    const poolIds = [...new Set([...pools.keys(), ...newPools])];
    const swapLogs = poolIds.length
      ? (await evmClient.getLogs({ address: p.poolManager, event: poolManagerSwapEvent, args: { id: poolIds as `0x${string}`[] }, fromBlock: from, toBlock: to })).sort(order)
      : [];

    // 3) the things a swap log doesn't say: when, and who (prefetched, so the DB transaction below stays synchronous)
    const ctx: Ctx = { startSqrt: p.startSqrtPrice, seedL: p.seedLiquidity, blockTime: new Map(), txFrom: new Map(), traded: new Map() };
    for (const l of padLogs) {
      const ev = decodeLaunchpad(l);
      if (ev?.eventName !== 'Traded') continue;
      const list = ctx.traded.get(String(l.transactionHash)) ?? [];
      list.push({ trader: getAddress(ev.args.trader) as `0x${string}`, isBuy: !!ev.args.isBuy, used: false });
      ctx.traded.set(String(l.transactionHash), list);
    }
    for (const bn of new Set(swapLogs.map((l) => l.blockNumber!))) {
      const b = await evmClient.getBlock({ blockNumber: bn });
      ctx.blockTime.set(bn, Number(b.timestamp) * 1000);
    }
    for (const l of swapLogs) {
      const hash = String(l.transactionHash);
      if (ctx.txFrom.has(hash)) continue;
      const decoded = decodeSwap(l);
      if (decoded && String(decoded.args.sender).toLowerCase() === EVM.launchpad.toLowerCase() && ctx.traded.has(hash)) continue; // attribution comes from the launchpad
      ctx.txFrom.set(hash, (await evmClient.getTransaction({ hash: l.transactionHash! })).from);
    }

    // 4) apply everything in chain order, atomically, together with the cursor
    const applied: Applied = { touched: new Set(), balances: new Map(), trades: [], created: [] };
    const merged = [
      ...padLogs.map((log) => ({ log, kind: 'pad' as const })),
      ...swapLogs.map((log) => ({ log, kind: 'swap' as const })),
    ].sort((x, y) => order(x.log, y.log));

    db.transaction(() => {
      for (const { log, kind } of merged) {
        const key = `${EVM.chainId}:${log.transactionHash}:${log.logIndex}`;
        if (db.prepare('SELECT 1 FROM chain_events WHERE key = ?').get(key)) continue;
        const ev = kind === 'pad' ? decodeLaunchpad(log) : decodeSwap(log);
        if (!ev) continue;
        const done = kind === 'pad' ? applyLaunchpadLog(log, ev, applied) : applySwap(log, ev, applied, ctx);
        if (done) db.prepare('INSERT INTO chain_events(key) VALUES(?)').run(key);
      }
      setKv(cursorKey(), to.toString());
    })();

    await refreshCoins(applied);
    for (const t of applied.trades) publish({ type: 'trade', coinId: t.coinId, trade: t.trade });
    if (applied.created.length) {
      const coins = applied.created.map((id) => getCoinRow(id)).filter(Boolean).map((r) => coinJson(r!));
      publish({ type: 'launch', coins });
      void enrichMetadata().catch(() => {}); // don't make a brand-new coin wait for the periodic timer
    }
    from = to + 1n;
  }
}

/* ------------------------------------------------------------------- metadata */

export async function enrichMetadata(limit = 10) {
  const rows = db
    .prepare(`SELECT id, metadata_uri, meta_tries FROM coins WHERE meta_state = 'pending' AND metadata_uri IS NOT NULL LIMIT ?`)
    .all(limit) as { id: string; metadata_uri: string; meta_tries: number }[];
  for (const r of rows) {
    const meta = await fetchMetadata(r.metadata_uri, PUBLIC_URL);
    if (meta) {
      db.prepare(
        `UPDATE coins SET description=?, image=?, website=?, twitter=?, telegram=?, meta_state='done' WHERE id=?`,
      ).run(meta.description, meta.image, meta.website, meta.twitter, meta.telegram, r.id);
      publish({ type: 'meta', coinId: r.id }); // open pages refresh the coin without waiting for their poll
    } else {
      const tries = r.meta_tries + 1;
      db.prepare(`UPDATE coins SET meta_tries=?, meta_state=? WHERE id=?`).run(tries, tries >= 5 ? 'failed' : 'pending', r.id);
    }
  }
}

export function startEvmIndexer() {
  if (!evmEnabled()) {
    console.warn('[evm] HYP_LAUNCHPAD is not set: EVM indexing is off');
    return;
  }
  console.log(`[evm] indexing ${EVM.launchpad} on chain ${EVM.chainId} via ${EVM.rpcUrl}`);
  loadPools();
  void loadParams().catch((e) => console.warn('[evm] could not read the launchpad yet:', (e as Error).message));
  const loop = async () => {
    try {
      await indexEvm();
    } catch (e) {
      console.warn('[evm] index error:', (e as Error).message);
    }
    setTimeout(loop, EVM.pollMs);
  };
  void loop();
  setInterval(() => void enrichMetadata().catch(() => {}), 8000).unref();
}
