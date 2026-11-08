/**
 * Solana indexer for pump.fun coins.
 *
 * A coin appears here when someone registers the transaction that created it (the browser does this right after the
 * wallet confirms; anyone can also register any public pump.fun create). From then on its trades are read straight
 * from pump.fun's own on-chain `TradeEvent`s (emitted as self-CPI inner instructions) and written into the same
 * coins / trades / holdings tables the rest of the app reads.
 *
 * Verified against real mainnet transactions in tests/pump.test.ts. The public RPC rate-limits hard: for anything
 * beyond light use set SOL_RPC_URL to a dedicated endpoint.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { db, getKv, setKv } from '../db.js';
import { SOL } from '../config.js';
import { getOrCreateUser } from '../auth.js';
import { getPrices } from '../prices.js';
import { publish } from '../stream.js';
import { coinJson, getCoinRow } from '../queries.js';
import { ApiError } from '../util.js';
import { enrichMetadata } from './evm.js';
import {
  DISC,
  PUMP_PROGRAM,
  decodeCreateEvent,
  decodeTradeEvent,
  decodeBondingCurve,
  isDisc,
  isSolQuoted,
  parseEventIx,
  pumpPdas,
  UNSUPPORTED_QUOTE_MESSAGE,
  type CreateEvent,
  type TradeEvent,
} from '../../src/lib/pumpLayout.js';

export const solConn = new Connection(SOL.rpcUrl, { commitment: 'confirmed' });

const LAMPORTS = 1_000_000_000;
const TOKEN_UNITS = 1_000_000;
const INITIAL_REAL_TOKENS = 793_100_000_000_000; // 793.1M tokens, 6 decimals (pump.fun's curve allocation)
const TOTAL_SUPPLY = 1_000_000_000_000_000;

export const solCoinId = (mint: string) => `sol-${mint}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The public RPC answers 429 under load: back off and retry instead of failing the whole pass. */
async function withRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1 || !/429|rate|too many|timeout|fetch failed/i.test(String(e))) throw e;
      await sleep(1000 * 2 ** i);
    }
  }
}

/* ------------------------------------------------------- parse one transaction */

/**
 * Transactions are fetched as raw JSON-RPC instead of through web3.js: that handles every transaction version the
 * network produces (web3.js rejects newer ones), and we only need account keys and inner instructions anyway.
 */
interface RawTx {
  blockTime: number | null;
  meta: {
    err: unknown;
    loadedAddresses?: { writable: string[]; readonly: string[] };
    innerInstructions?: { instructions: { programIdIndex: number; data: string }[] }[];
  } | null;
  transaction: { message: { accountKeys: string[] } };
}

async function rpcGetTransaction(signature: string): Promise<RawTx | null> {
  return withRetry(async () => {
    const res = await fetch(SOL.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429) throw new Error('429 rate limited');
    const j = (await res.json()) as { result?: RawTx | null; error?: { message: string } };
    if (j.error) {
      if (/rate|limit|429/i.test(j.error.message)) throw new Error('429 ' + j.error.message);
      throw new Error(j.error.message);
    }
    return j.result ?? null;
  });
}

interface ParsedTx {
  signature: string;
  blockTime: number;
  creates: CreateEvent[];
  trades: TradeEvent[];
}

function parseTx(signature: string, tx: RawTx): ParsedTx | null {
  if (!tx.meta || tx.meta.err) return null; // failed transactions change nothing on-chain
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const out: ParsedTx = { signature, blockTime: tx.blockTime ?? Math.floor(Date.now() / 1000), creates: [], trades: [] };
  const pump = PUMP_PROGRAM.toBase58();
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== pump) continue;
      let data: Uint8Array;
      try {
        data = bs58.decode(ix.data);
      } catch {
        continue;
      }
      const ev = parseEventIx(data);
      if (!ev) continue;
      try {
        if (isDisc(ev.disc, DISC.events.create)) out.creates.push(decodeCreateEvent(ev.body));
        else if (isDisc(ev.disc, DISC.events.trade)) out.trades.push(decodeTradeEvent(ev.body));
      } catch {
        /* an event layout we don't understand: skip it rather than corrupt state */
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ ingestion */

const seen = (key: string) => !!db.prepare('SELECT 1 FROM chain_events WHERE key = ?').get(key);
const mark = (key: string) => db.prepare('INSERT OR IGNORE INTO chain_events(key) VALUES(?)').run(key);

function ingestCreate(e: CreateEvent): string | null {
  if (!isSolQuoted(e.quoteMint)) return null; // priced in another token: SOL maths would be wrong, so never list it
  const mint = e.mint.toBase58();
  const id = solCoinId(mint);
  if (db.prepare('SELECT 1 FROM coins WHERE id = ?').get(id)) return null;
  const creator = getOrCreateUser(e.creator.toBase58());
  const usd = getPrices().SOL;
  const vq = Number(e.virtualSolReserves);
  const vt = Number(e.virtualTokenReserves);
  const price = vq / LAMPORTS / (vt / TOKEN_UNITS);
  const mcUsd = price * (TOTAL_SUPPLY / TOKEN_UNITS) * usd;
  const createdMs = Number(e.timestamp) * 1000;
  db.prepare(
    `INSERT INTO coins(id, launch_id, chain, address, name, symbol, description, image, website, twitter, telegram,
       creator_id, fee_mode, status, model, vq, vt, real_quote, real_tokens, mcap_usd, ath_usd, start_mcap, created_at,
       metadata_uri, meta_state, chain_ref)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, null, 'sol', mint, e.name.slice(0, 32), e.symbol.slice(0, 10).toUpperCase(), '', null, null, null, null,
    creator.id, e.isHolderReward ? 'holders' : 'creator', 'live', 'curve', vq, vt, 0, Number(e.realTokenReserves), mcUsd, mcUsd,
    Math.round(vq / LAMPORTS), createdMs, e.uri || null, e.uri ? 'pending' : 'none', mint,
  );
  // opening price for the chart
  db.prepare(
    `INSERT INTO trades(coin_id, user_id, side, quote, tokens, fee, price, usd, mcap_usd, sig, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, creator.id, 'create', 0, 0, 0, price, 0, mcUsd, mint, createdMs);
  return id;
}

function ingestTrade(e: TradeEvent, signature: string, blockTime: number): string | null {
  const mint = e.mint.toBase58();
  const id = solCoinId(mint);
  if (!db.prepare('SELECT 1 FROM coins WHERE id = ?').get(id)) return null; // not a coin we track
  const key = `sol:${signature}:${mint}:${e.user.toBase58()}:${e.tokenAmount}:${e.timestamp}:${e.isBuy}`;
  if (seen(key)) return null;
  if (e.virtualSolReserves === 0n || e.virtualTokenReserves === 0n) return null; // not a SOL-quoted curve trade

  const trader = getOrCreateUser(e.user.toBase58());
  const usd = getPrices().SOL;
  const vq = Number(e.virtualSolReserves);
  const vt = Number(e.virtualTokenReserves);
  const price = vq / LAMPORTS / (vt / TOKEN_UNITS);
  const mcUsd = price * (TOTAL_SUPPLY / TOKEN_UNITS) * usd;
  const quote = Number(e.solAmount);
  const tokens = Number(e.tokenAmount);
  const tradeUsd = (quote / LAMPORTS) * usd;
  const ts = (Number(e.timestamp) || blockTime) * 1000;
  const rt = Number(e.realTokenReserves);

  db.prepare(
    `INSERT INTO trades(coin_id, user_id, side, quote, tokens, fee, price, usd, mcap_usd, sig, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, trader.id, e.isBuy ? 'buy' : 'sell', quote, tokens, Number(e.fee + e.creatorFee), price, tradeUsd, mcUsd, signature, ts);

  // holdings are derived from this coin's trades (wallet-to-wallet transfers are not visible from trade events)
  const cur = (db.prepare('SELECT amount FROM holdings WHERE coin_id=? AND user_id=?').get(id, trader.id) as { amount: number } | undefined)?.amount ?? 0;
  const next = Math.max(0, cur + (e.isBuy ? tokens : -tokens));
  db.prepare(
    `INSERT INTO holdings(coin_id, user_id, amount) VALUES(?,?,?)
     ON CONFLICT(coin_id, user_id) DO UPDATE SET amount = excluded.amount`,
  ).run(id, trader.id, next);

  const complete = rt === 0;
  db.prepare(
    `UPDATE coins SET vq=?, vt=?, real_quote=?, real_tokens=?, sold=?, volume_quote = volume_quote + ?, volume_usd = volume_usd + ?,
       trades = trades + 1, mcap_usd = ?, ath_usd = MAX(ath_usd, ?), last_trade_at = MAX(last_trade_at, ?),
       status = CASE WHEN ? THEN 'graduated' ELSE status END,
       graduated_at = CASE WHEN ? AND graduated_at IS NULL THEN ? ELSE graduated_at END,
       holders = (SELECT COUNT(*) FROM holdings WHERE coin_id = ? AND amount > 0)
     WHERE id = ?`,
  ).run(vq, vt, Number(e.realSolReserves), rt, Math.max(0, INITIAL_REAL_TOKENS - rt), quote, tradeUsd, mcUsd, mcUsd, ts, complete ? 1 : 0, complete ? 1 : 0, ts, id, id);
  mark(key);
  return id;
}

/** Apply everything a parsed transaction did to coins we track. Returns touched coin ids. */
function applyParsed(p: ParsedTx): { created: string[]; traded: { coinId: string; e: TradeEvent }[] } {
  const created: string[] = [];
  const traded: { coinId: string; e: TradeEvent }[] = [];
  db.transaction(() => {
    for (const c of p.creates) {
      const id = ingestCreate(c);
      if (id) created.push(id);
    }
    for (const t of p.trades) {
      const id = ingestTrade(t, p.signature, p.blockTime);
      if (id) traded.push({ coinId: id, e: t });
    }
  })();
  return { created, traded };
}

function announce(res: { created: string[]; traded: { coinId: string; e: TradeEvent }[] }) {
  for (const t of res.traded) {
    publish({
      type: 'trade',
      coinId: t.coinId,
      trade: { id: Number(t.e.timestamp), side: t.e.isBuy ? 'buy' : 'sell', quote: Number(t.e.solAmount), tokens: Number(t.e.tokenAmount), price: 0, user: t.e.user.toBase58(), createdAt: Number(t.e.timestamp) * 1000, sig: '' },
    });
  }
  if (res.created.length) {
    const coins = res.created.map((id) => getCoinRow(id)).filter(Boolean).map((r) => coinJson(r!));
    publish({ type: 'launch', coins });
  }
}

/* --------------------------------------------------------------- registration */

/**
 * Registers a pump.fun create transaction (plus any trades in it, e.g. the creator's first buy).
 * Everything is read from the chain, so the caller cannot inject anything: only what the program emitted counts.
 */
export async function registerCreateSignature(signature: string): Promise<string> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) throw new ApiError(400, 'Invalid transaction signature');
  const tx = await rpcGetTransaction(signature);
  if (!tx) throw new ApiError(404, 'Transaction not found yet. Wait a moment for it to confirm and try again.');
  const parsed = parseTx(signature, tx);
  if (!parsed) throw new ApiError(400, 'That transaction failed on-chain');
  if (!parsed.creates.length) throw new ApiError(400, 'That transaction did not create a pump.fun coin');
  if (parsed.creates.some((c) => !isSolQuoted(c.quoteMint))) throw new ApiError(422, UNSUPPORTED_QUOTE_MESSAGE);
  const res = applyParsed(parsed);
  announce(res);
  void enrichMetadata().catch(() => {});
  const mint = parsed.creates[0].mint.toBase58();
  return solCoinId(mint);
}

/* ----------------------------------------------------------------- polling */

const cursorKey = (mint: string) => `sol:cursor:${mint}`;

async function pollCoin(mint: string) {
  const bondingCurve = pumpPdas.bondingCurve(new PublicKey(mint));
  const until = getKv(cursorKey(mint));
  const sigs = await withRetry(() => solConn.getSignaturesForAddress(bondingCurve, { until, limit: 100 }, 'confirmed'));
  if (!sigs.length) return;
  // oldest first so the coin's reserves end up at the newest state
  for (const s of [...sigs].reverse()) {
    if (s.err) continue;
    try {
      const tx = await rpcGetTransaction(s.signature);
      if (tx) {
        const parsed = parseTx(s.signature, tx);
        if (parsed) announce(applyParsed(parsed));
      }
    } catch (e) {
      // skip a transaction we cannot read (the next trade event carries full reserves anyway) rather than stall the coin
      console.warn('[sol] skipping unreadable tx', s.signature.slice(0, 12), (e as Error).message.slice(0, 80));
    }
    await sleep(120); // be gentle with shared RPCs
  }
  setKv(cursorKey(mint), sigs[0].signature); // sigs[0] is the newest
}

let running: Promise<void> | null = null;
let again = false;

/** Poll every tracked coin once. Concurrent callers share one pass (and one trailing pass if needed). */
export function indexSolana(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        const rows = db.prepare(`SELECT chain_ref AS mint FROM coins WHERE chain = 'sol' AND chain_ref IS NOT NULL AND status = 'live' ORDER BY last_trade_at DESC LIMIT 200`).all() as { mint: string }[];
        for (const r of rows) {
          try {
            await pollCoin(r.mint);
          } catch (e) {
            console.warn('[sol] poll failed for', r.mint, (e as Error).message);
          }
        }
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

export function startSolanaIndexer() {
  console.log(`[sol] indexing pump.fun coins registered on this site via ${SOL.rpcUrl}`);
  const loop = async () => {
    try {
      await indexSolana();
    } catch (e) {
      console.warn('[sol] index error:', (e as Error).message);
    }
    setTimeout(loop, 8000);
  };
  setTimeout(loop, 2000);
}

/* ------------------------------------------------------------ import by mint */

/**
 * Adds an existing pump.fun coin by its mint address. The coin's creation transaction is found by walking its bonding
 * curve account's history back to the very first signature, then verified exactly like a registered create
 * (everything comes from the chain). Very busy coins (more than ~5,000 transactions) are refused rather than guessed.
 */
export async function importSolanaMint(mintStr: string): Promise<string> {
  let mint: PublicKey;
  try {
    mint = new PublicKey(mintStr);
  } catch {
    throw new ApiError(400, 'That is not a valid Solana address');
  }
  const id = solCoinId(mint.toBase58());
  if (db.prepare('SELECT 1 FROM coins WHERE id = ?').get(id)) return id;

  const bondingCurve = pumpPdas.bondingCurve(mint);
  const info = await withRetry(() => solConn.getAccountInfo(bondingCurve, 'confirmed'));
  if (!info || !info.owner.equals(PUMP_PROGRAM)) throw new ApiError(404, 'That address is not a pump.fun coin');
  let curve;
  try {
    curve = decodeBondingCurve(new Uint8Array(info.data));
  } catch {
    throw new ApiError(404, 'That address is not a pump.fun coin');
  }
  if (!isSolQuoted(curve.quoteMint)) throw new ApiError(422, UNSUPPORTED_QUOTE_MESSAGE);

  let before: string | undefined;
  let oldest: string | undefined;
  for (let page = 0; page < 5; page++) {
    const sigs = await withRetry(() => solConn.getSignaturesForAddress(bondingCurve, { before, limit: 1000 }, 'confirmed'));
    if (!sigs.length) break;
    oldest = sigs[sigs.length - 1].signature;
    if (sigs.length < 1000) {
      before = undefined;
      break;
    }
    before = oldest;
    if (page === 4) throw new ApiError(422, 'This coin has too much history to import automatically (over 5,000 transactions).');
  }
  if (!oldest) throw new ApiError(404, 'Could not find this coin\'s history on-chain yet. Try again in a moment.');

  const tx = await rpcGetTransaction(oldest);
  const parsed = tx ? parseTx(oldest, tx) : null;
  const created = parsed?.creates.find((c) => c.mint.equals(mint));
  if (!parsed || !created) throw new ApiError(422, 'Could not verify this coin\'s creation on-chain.');
  const res = applyParsed(parsed);
  announce(res);
  void enrichMetadata().catch(() => {});
  return id;
}
