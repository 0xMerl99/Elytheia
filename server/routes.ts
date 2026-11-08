import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getAddress } from 'viem';
import { db } from './db.js';
import { DATA_DIR, EVM, MAX_IMAGE_BYTES, PROJECT, PUBLIC_URL, SOL, UPLOAD_DIR } from './config.js';
import { CHAIN_LIST, MAX_CREATOR_BUY_BPS, QUOTE_UNIT } from '../shared/market.js';
import { ApiError, normalizeSocialLink, rateLimit, shortId } from './util.js';
import {
  createNonce,
  isValidEvmAddress,
  isValidSolAddress,
  logout,
  normalizeAddress,
  optionalAuth,
  requireAuth,
  verifyLogin,
} from './auth.js';
import { getPrices } from './prices.js';
import {
  candles,
  coinJson,
  comments,
  getCoin,
  getCoinRow,
  globalStats,
  globalTrades,
  holders,
  listCoins,
  profile,
  recentTrades,
  type SortKey,
} from './queries.js';
import { evmClient, evmEnabled, getEvmParams, getEvmTiers, indexEvm } from './chain/evm.js';
import { importSolanaMint, indexSolana, registerCreateSignature } from './chain/solana.js';
import { launchpadAbi } from '../shared/launchpadAbi.js';
import { sseHandler } from './stream.js';
import { checkRpcBody } from './rpcProxy.js';
import { getProjectToken } from './projectToken.js';

export const api = Router();

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new ApiError(400, r.error.issues[0]?.message ?? 'Invalid input');
  return r.data;
}

const authLimiter = rateLimit('auth', 30, 60_000);
const writeLimiter = rateLimit('write', 40, 60_000);
const syncLimiter = rateLimit('sync', 30, 60_000);
const importLimiter = rateLimit('import', 10, 60_000);
const rpcLimiter = rateLimit('rpc', 900, 60_000);

/* --------------------------------------------------------------- general */

api.get('/health', (_req, res) => res.json({ ok: true, time: Date.now() }));

/** The pool's start-market-cap tiers: what the deployed contract reports, else the built-in default. */
const tiersOf = (c: { id: string; startMcapTiers?: number[] }): number[] | null => (c.id === 'hyp' ? getEvmTiers() : null) ?? c.startMcapTiers ?? null;

api.get('/config', (_req, res) => {
  res.json({
    chains: CHAIN_LIST.map((c) => ({
      id: c.id,
      name: c.id === 'hyp' ? EVM.name : c.name, // the EVM chain is whatever this site is configured for
      venue: c.venue,
      quote: c.quote,
      model: c.model,
      blurb: c.blurb,
      launchFee: c.launchFee / QUOTE_UNIT,
      baseFeeBps: c.baseFeeBps,
      creatorFeeBps: c.creatorFeeBps,
      graduationQuote: c.graduationQuote / QUOTE_UNIT,
      antiSnipe: c.antiSnipe,
      startMcapTiers: tiersOf(c),
      startMcap: c.model === 'curve' ? c.vq / QUOTE_UNIT : (tiersOf(c)?.[1] ?? tiersOf(c)?.[0] ?? c.vq / QUOTE_UNIT),
    })),
    prices: getPrices(),
    // Only BROWSER-safe RPC URLs are ever sent to visitors (see server/config.ts)
    evm: {
      enabled: evmEnabled(),
      chainId: EVM.chainId,
      name: EVM.name,
      rpcUrl: EVM.browserRpcUrl,
      launchpad: EVM.launchpad || null,
      poolManager: getEvmParams()?.poolManager ?? null,
      hook: getEvmParams()?.hook ?? null,
      explorer: EVM.explorer || null,
    },
    // relative on purpose: the browser reaches Solana only through this server's allow-listed proxy
    solana: { rpcUrl: '/api/solana-rpc', cluster: SOL.cluster },
    publicUrl: PUBLIC_URL,
    project: { tokenCa: PROJECT.tokenCa || null, xUrl: PROJECT.xUrl },
    limits: {
      maxCreatorBuyPct: MAX_CREATOR_BUY_BPS / 100,
      maxImageBytes: MAX_IMAGE_BYTES,
    },
  });
});

api.get('/stats', (_req, res) => res.json(globalStats()));

/** The project's own token (TOKEN_CA) for the official card: identity from the chain, live numbers from DexScreener. */
api.get('/project-token', async (_req, res) => {
  res.set('cache-control', 'public, max-age=15');
  res.json({ token: await getProjectToken() });
});
api.get('/stream', sseHandler);

/* ------------------------------------------------------------ solana rpc proxy */

/** Allow-listed forwarder to the server's private Solana RPC (see server/rpcProxy.ts for why). */
api.post('/solana-rpc', rpcLimiter, async (req, res) => {
  const check = checkRpcBody(req.body);
  if (!check.ok) throw new ApiError(400, check.error);
  let upstream: Response;
  try {
    upstream = await fetch(SOL.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new ApiError(502, 'The Solana RPC did not respond. Try again in a moment.');
  }
  const text = await upstream.text();
  if (text.length > 2_000_000) throw new ApiError(502, 'Unexpectedly large RPC response');
  res.status(upstream.status).type('application/json').send(text);
});

/* ------------------------------------------------------------------ auth */

api.post('/auth/nonce', authLimiter, (req, res) => {
  const { address: raw } = parse(z.object({ address: z.string() }), req.body);
  if (!isValidSolAddress(raw) && !isValidEvmAddress(raw)) throw new ApiError(400, 'Invalid wallet address');
  res.json(createNonce(normalizeAddress(raw)));
});

api.post('/auth/verify', authLimiter, async (req, res) => {
  const { address, nonce, signature } = parse(
    z.object({ address: z.string(), nonce: z.string(), signature: z.string() }),
    req.body,
  );
  const { token, user } = await verifyLogin(address, nonce, signature);
  res.json({ token, user: { address: user.address } });
});

api.post('/auth/logout', optionalAuth, (req, res) => {
  logout(req);
  res.json({ ok: true });
});

api.get('/me', requireAuth, (req, res) => {
  res.json({ user: { address: req.user!.address } });
});

/* ----------------------------------------------------------------- coins */

const SORTS = new Set(['new', 'mcap', 'volume', 'hot', 'live', 'graduated']);

api.get('/coins', (req, res) => {
  const sort = SORTS.has(String(req.query.sort)) ? (String(req.query.sort) as SortKey) : 'new';
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 64) : '';
  const chain = typeof req.query.chain === 'string' ? req.query.chain : '';
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 24));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  res.json(listCoins({ sort, q: q || undefined, chain, limit, offset }));
});

api.get('/coins/:id', (req, res) => {
  const row = getCoinRow(String(req.params.id));
  if (!row) throw new ApiError(404, 'Coin not found');
  res.json({ coin: coinJson(row), siblings: [] });
});

api.get('/coins/:id/candles', (req, res) => {
  if (!getCoin(String(req.params.id))) throw new ApiError(404, 'Coin not found');
  const allowed = [15, 60, 300, 900, 3600, 14400, 86400];
  const interval = allowed.includes(Number(req.query.interval)) ? Number(req.query.interval) : 60;
  const unit = req.query.unit === 'quote' ? 'quote' : 'usd';
  res.json({ interval, unit, candles: candles(String(req.params.id), interval, unit) });
});

api.get('/coins/:id/trades', (req, res) => {
  if (!getCoin(String(req.params.id))) throw new ApiError(404, 'Coin not found');
  res.json({ trades: recentTrades(String(req.params.id), Math.min(100, Number(req.query.limit) || 50)) });
});

api.get('/coins/:id/holders', (req, res) => {
  const coin = getCoin(String(req.params.id));
  if (!coin) throw new ApiError(404, 'Coin not found');
  res.json({ holders: holders(coin) });
});

api.get('/coins/:id/comments', (req, res) => {
  if (!getCoin(String(req.params.id))) throw new ApiError(404, 'Coin not found');
  res.json({ comments: comments(String(req.params.id)) });
});

api.post('/coins/:id/comments', requireAuth, writeLimiter, (req, res) => {
  if (!getCoin(String(req.params.id))) throw new ApiError(404, 'Coin not found');
  const { text } = parse(z.object({ text: z.string().trim().min(1, 'Write something').max(300, 'Max 300 characters') }), req.body);
  db.prepare('INSERT INTO comments(coin_id, user_id, text, created_at) VALUES(?,?,?,?)').run(
    String(req.params.id),
    req.user!.id,
    text,
    Date.now(),
  );
  res.json({ comments: comments(String(req.params.id)) });
});

/* ---------------------------------------------------------------- global */

api.get('/trades/recent', (req, res) => {
  res.json({ trades: globalTrades(Math.min(40, Number(req.query.limit) || 20)) });
});

api.get('/search', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 64) : '';
  if (q.length < 1) return res.json({ coins: [], users: [] });
  const { coins } = listCoins({ sort: 'mcap', q, limit: 6, offset: 0 });
  let users: { address: string }[] = [];
  if (q.length >= 4) {
    const esc = q.replace(/[\\%_]/g, (m) => '\\' + m);
    users = db.prepare(`SELECT address FROM users WHERE address LIKE ? ESCAPE '\\' LIMIT 3`).all(`${esc}%`) as { address: string }[];
  }
  res.json({ coins, users });
});

api.get('/users/:address', async (req, res) => {
  const raw = String(req.params.address);
  if (!isValidSolAddress(raw) && !isValidEvmAddress(raw)) throw new ApiError(400, 'Invalid wallet address');
  const p = profile(normalizeAddress(raw));
  if (!p) throw new ApiError(404, 'No activity for this wallet yet');
  if (isValidEvmAddress(raw) && evmEnabled()) await addOnChainRewards(p, getAddress(raw));
  res.json(p);
});

/** A creator's fee balance is held by the launchpad, so read what this wallet can claim straight from it. */
async function addOnChainRewards(p: NonNullable<ReturnType<typeof profile>>, address: `0x${string}`) {
  let claimableUsd = 0;
  const usdPrice = getPrices().HYPE;
  await Promise.all(
    p.holdings.map(async (h) => {
      const ref = (db.prepare('SELECT chain_ref FROM coins WHERE id = ?').get(h.coin.id) as { chain_ref: string | null } | undefined)?.chain_ref;
      if (!ref || h.coin.chain !== 'hyp') return;
      try {
        const info = (await evmClient.readContract({
          address: EVM.launchpad as `0x${string}`,
          abi: launchpadAbi,
          functionName: 'coinInfo',
          args: [BigInt(ref)],
        })) as { creator: string; creatorNative: bigint };
        if (info.creator.toLowerCase() === address.toLowerCase()) h.claimableQuote = Number(info.creatorNative) / 1e18;
      } catch {
        /* keep 0: the coin page still shows the live number */
      }
    }),
  );
  for (const h of p.holdings) claimableUsd += h.claimableQuote * usdPrice;
  p.stats.claimableUsd = claimableUsd;
}

/* --------------------------------------------------------------- uploads */

const MIME: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  'image/png': { ext: 'png', magic: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/jpeg': { ext: 'jpg', magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { ext: 'gif', magic: (b) => b.length > 6 && b.toString('ascii', 0, 4) === 'GIF8' },
  'image/webp': { ext: 'webp', magic: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
};

api.post('/upload', requireAuth, writeLimiter, (req, res) => {
  const { data } = parse(z.object({ data: z.string().max(MAX_IMAGE_BYTES * 1.4) }), req.body);
  const m = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!m || !MIME[m[1]]) throw new ApiError(400, 'Use a PNG, JPG, GIF or WebP image');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_IMAGE_BYTES) throw new ApiError(400, `Image is too large (max ${(MAX_IMAGE_BYTES / 1_000_000).toFixed(1)} MB)`);
  if (!MIME[m[1]].magic(buf)) throw new ApiError(400, 'That file is not a valid image');
  const name = `${shortId(16)}.${MIME[m[1]].ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  res.json({ url: `/uploads/${name}` });
});

/* ------------------------------------------------------------ chain sync */

/** Ask the indexers to catch up right now (the UI calls this after a transaction confirms). */
api.post('/chain/sync', syncLimiter, async (_req, res) => {
  await Promise.all([indexEvm().catch(() => {}), indexSolana().catch(() => {})]);
  res.json({ ok: true });
});

/** Register the transaction that created a pump.fun coin so it shows up here (everything is read from the chain). */
api.post('/chain/solana/register', syncLimiter, async (req, res) => {
  const { signature } = parse(z.object({ signature: z.string().min(60).max(100) }), req.body);
  res.json({ id: await registerCreateSignature(signature) });
});

/** Add any existing pump.fun coin by its mint address (its creation is found and verified on-chain). */
api.post('/chain/solana/import', importLimiter, async (req, res) => {
  const { mint } = parse(z.object({ mint: z.string().min(32).max(44) }), req.body);
  if (!isValidSolAddress(mint)) throw new ApiError(400, 'That is not a valid Solana address');
  res.json({ id: await importSolanaMint(mint) });
});

const assertImageExists = (url: string | null | undefined) => {
  if (!url) return;
  if (!fs.existsSync(path.join(UPLOAD_DIR, path.basename(url)))) throw new ApiError(400, 'Uploaded image not found, please upload it again');
};

const metadataSchema = z.object({
  name: z.string().trim().min(1).max(32),
  symbol: z.string().trim().min(2).max(10).regex(/^[A-Za-z0-9]+$/),
  description: z.string().trim().max(500).default(''),
  image: z
    .string()
    .regex(/^\/uploads\/[a-z0-9]+\.(png|jpg|webp|gif)$/)
    .nullable()
    .optional(),
  website: z.string().trim().max(200).default(''),
  twitter: z.string().trim().max(120).default(''),
  telegram: z.string().trim().max(120).default(''),
});

/**
 * Publishes the coin's off-chain metadata (pump.fun-compatible JSON) from this site and returns its public URL,
 * which is what gets written on-chain. Other sites (including pump.fun) fetch it, so PUBLIC_URL must be a real
 * https origin for a mainnet launch.
 */
api.post('/chain/metadata', requireAuth, writeLimiter, (req, res) => {
  const m = parse(metadataSchema, req.body);
  assertImageExists(m.image);
  const id = shortId(16);
  const doc = {
    name: m.name,
    symbol: m.symbol.toUpperCase(),
    description: m.description,
    image: m.image ? `${PUBLIC_URL}${m.image}` : '',
    showName: true,
    createdOn: PUBLIC_URL,
    website: m.website ? (/^https?:\/\//i.test(m.website) ? m.website : `https://${m.website}`) : '',
    twitter: normalizeSocialLink(m.twitter, 'https://x.com/', 'X / Twitter') ?? '',
    telegram: normalizeSocialLink(m.telegram, 'https://t.me/', 'Telegram') ?? '',
  };
  const dir = path.join(DATA_DIR, 'metadata');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(doc));
  res.json({ uri: `${PUBLIC_URL}/metadata/${id}.json` });
});
