/**
 * The project's own token (TOKEN_CA), shown as an "official" card. It is a pump.fun coin priced in a token other than SOL,
 * so the site cannot trade it itself: the card shows live numbers and sends people to pump.fun to trade.
 *
 * Nothing about the token is hardcoded. Identity (name, symbol, image, links) is read from the token's own on-chain metadata
 * and the JSON it points to; market numbers come from DexScreener. Both are cached, and a failed refresh keeps the last good
 * values, so a flaky third-party service can never break the page.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_IMAGE_BYTES, PROJECT, PUBLIC_URL, SOL, UPLOAD_DIR } from './config.js';
import { fetchMetadata } from './chain/metadata.js';

export interface ProjectToken {
  mint: string;
  name: string | null;
  symbol: string | null;
  description: string;
  image: string | null;
  /** other IPFS gateways to try if the first one is slow or down */
  imageFallbacks: string[];
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  pumpUrl: string;
  quoteSymbol: string | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  volume24Usd: number | null;
  change24: number | null;
  updatedAt: number;
}

const IDENTITY_TTL = 60 * 60_000; // an hour: name / image / links barely change
const IDENTITY_RETRY = 60_000; // ...but retry quickly until we have them
const MARKET_TTL = 30_000;
const GATEWAYS = ['https://gateway.pinata.cloud/ipfs/', 'https://ipfs.io/ipfs/', 'https://cloudflare-ipfs.com/ipfs/', 'https://dweb.link/ipfs/'];

interface Identity {
  name: string | null;
  symbol: string | null;
  description: string;
  image: string | null;
  imageFallbacks: string[];
  website: string | null;
  twitter: string | null;
  telegram: string | null;
}
interface Market {
  quoteSymbol: string | null;
  priceUsd: number | null;
  mcapUsd: number | null;
  volume24Usd: number | null;
  change24: number | null;
}

const empty: Identity = { name: null, symbol: null, description: '', image: null, imageFallbacks: [], website: null, twitter: null, telegram: null };
let identity: { value: Identity; at: number; ok: boolean } | null = null;
let market: { value: Market; at: number } | null = null;
let inflight: Promise<ProjectToken> | null = null;

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** `https://ipfs.io/ipfs/<cid>[/path]` or `ipfs://<cid>[/path]` -> the content path, else null */
function ipfsPath(uri: string): string | null {
  const m = /^(?:ipfs:\/\/(?:ipfs\/)?|https?:\/\/[^/]+\/ipfs\/)([A-Za-z0-9]+(?:\/[^?#]*)?)/.exec(uri.trim());
  return m ? m[1] : null;
}

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(SOL.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const j = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

/** What an image really is, judged by its first bytes (never by the name or content-type it claims). SVG is refused. */
function imageKind(b: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 6 && b.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/**
 * Public IPFS gateways are slow and often down, so the card's image is fetched once, checked, and served from this site's own
 * /uploads folder. Returns the same-origin path, or null if no gateway delivered a real image.
 */
async function cacheImage(urls: string[]): Promise<string | null> {
  for (const url of urls) {
    try {
      const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) continue;
      const kind = imageKind(buf);
      if (!kind) continue;
      const name = `official-${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}.${kind}`;
      const file = path.join(UPLOAD_DIR, name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
      return `/uploads/${name}`;
    } catch {
      /* try the next gateway */
    }
  }
  return null;
}

async function loadIdentity(): Promise<Identity> {
  // 1) the token's own metadata (Token-2022 stores name / symbol / uri inside the mint account)
  const acc = await rpc('getAccountInfo', [PROJECT.tokenCa, { encoding: 'jsonParsed' }]);
  const info = acc?.value?.data?.parsed?.info;
  const ext = (info?.extensions ?? []).find((e: any) => e?.extension === 'tokenMetadata')?.state;
  const out: Identity = { ...empty, name: ext?.name ? String(ext.name) : null, symbol: ext?.symbol ? String(ext.symbol) : null };

  // 2) the JSON that metadata points to (description, image, links), trying several IPFS gateways
  const uri = ext?.uri ? String(ext.uri) : '';
  if (uri) {
    const path = ipfsPath(uri);
    const candidates = path ? GATEWAYS.map((g) => g + path) : [uri];
    for (const c of candidates) {
      const meta = await fetchMetadata(c, PUBLIC_URL);
      if (!meta) continue;
      out.description = meta.description;
      out.website = meta.website;
      out.twitter = meta.twitter;
      out.telegram = meta.telegram;
      out.image = meta.image;
      const imgPath = meta.image ? ipfsPath(meta.image) : null;
      const gatewayUrls = imgPath ? GATEWAYS.map((g) => g + imgPath) : meta.image ? [meta.image] : [];
      const local = await cacheImage(gatewayUrls);
      // our own copy first; the public gateways only as a last resort if the copy could not be made
      out.image = local ?? meta.image;
      out.imageFallbacks = gatewayUrls.filter((u) => u !== out.image);
      break;
    }
  }
  return out;
}

async function loadMarket(): Promise<Market> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${PROJECT.tokenCa}`, {
    signal: AbortSignal.timeout(6000),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  const j = (await res.json()) as { pairs?: any[] | null };
  const pairs = (j.pairs ?? []).filter((p) => p && String(p.baseToken?.address) === PROJECT.tokenCa);
  // the busiest pair is the real market
  pairs.sort((a, b) => (num(b.volume?.h24) ?? 0) - (num(a.volume?.h24) ?? 0));
  const p = pairs[0];
  if (!p) return { quoteSymbol: null, priceUsd: null, mcapUsd: null, volume24Usd: null, change24: null };
  return {
    quoteSymbol: p.quoteToken?.symbol ? String(p.quoteToken.symbol) : null,
    priceUsd: num(p.priceUsd),
    mcapUsd: num(p.marketCap) ?? num(p.fdv),
    volume24Usd: num(p.volume?.h24),
    change24: num(p.priceChange?.h24),
  };
}

async function build(): Promise<ProjectToken> {
  const now = Date.now();
  if (!identity || now - identity.at > (identity.ok ? IDENTITY_TTL : IDENTITY_RETRY)) {
    try {
      const value = await loadIdentity();
      identity = { value, at: now, ok: !!value.name };
    } catch (e) {
      console.warn('[project-token] identity refresh failed:', (e as Error).message);
      identity = { value: identity?.value ?? empty, at: now, ok: false }; // keep what we had
    }
  }
  if (!market || now - market.at > MARKET_TTL) {
    try {
      market = { value: await loadMarket(), at: now };
    } catch (e) {
      console.warn('[project-token] market refresh failed:', (e as Error).message);
      if (market) market = { value: market.value, at: now - MARKET_TTL + 5_000 }; // keep the last numbers, retry soon
      else market = { value: { quoteSymbol: null, priceUsd: null, mcapUsd: null, volume24Usd: null, change24: null }, at: now - MARKET_TTL + 5_000 };
    }
  }
  return { mint: PROJECT.tokenCa, ...identity.value, pumpUrl: `https://pump.fun/coin/${PROJECT.tokenCa}`, ...market.value, updatedAt: Math.max(identity.at, market.at) };
}

/** null when the project has no token configured. Concurrent callers share one refresh. */
export async function getProjectToken(): Promise<ProjectToken | null> {
  if (!PROJECT.tokenCa) return null;
  if (!inflight) inflight = build().finally(() => (inflight = null));
  return inflight;
}
