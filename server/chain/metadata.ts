/**
 * Coin metadata (description, image, links) lives off-chain at a URI the creator supplies. Fetching arbitrary URLs
 * from a server is an SSRF risk, so metadata is only ever read from an explicit allow-list: this site's own origin and
 * well-known IPFS gateways (extend with METADATA_HOSTS). Everything else is ignored and the coin shows without it.
 */
import { isHttpUrl } from '../util.js';

const DEFAULT_HOSTS = ['ipfs.io', 'dweb.link', 'cloudflare-ipfs.com', 'gateway.pinata.cloud', 'nftstorage.link', 'w3s.link'];
const extra = (process.env.METADATA_HOSTS || '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

export const MAX_METADATA_BYTES = 100_000;

export function allowedHosts(publicUrl: string): Set<string> {
  const hosts = new Set([...DEFAULT_HOSTS, ...extra]);
  try {
    hosts.add(new URL(publicUrl).host.toLowerCase());
  } catch {
    /* ignore */
  }
  return hosts;
}

/** Maps ipfs:// to a gateway URL, then checks the host allow-list. Returns null when not allowed. */
export function resolveAllowedUrl(uri: string, publicUrl: string): string | null {
  let u = uri.trim();
  if (u.startsWith('ipfs://')) u = `https://ipfs.io/ipfs/${u.slice('ipfs://'.length).replace(/^ipfs\//, '')}`;
  if (!isHttpUrl(u)) return null;
  const url = new URL(u);
  const own = new URL(publicUrl);
  const host = url.host.toLowerCase();
  const isOwn = host === own.host.toLowerCase();
  // plain http is only acceptable for our own origin (local development)
  if (url.protocol === 'http:' && !isOwn) return null;
  const ok = isOwn || allowedHosts(publicUrl).has(host) || [...allowedHosts(publicUrl)].some((h) => host.endsWith('.' + h));
  return ok ? url.toString() : null;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function linkOrNull(v: unknown): string | null {
  const s = str(v, 200);
  return s && isHttpUrl(s) ? s : null;
}

export interface CoinMetadata {
  description: string;
  image: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
}

export async function fetchMetadata(uri: string, publicUrl: string): Promise<CoinMetadata | null> {
  const url = resolveAllowedUrl(uri, publicUrl);
  if (!url) return null;
  try {
    const res = await fetch(url, {
      redirect: 'error', // a redirect could point somewhere off the allow-list
      signal: AbortSignal.timeout(6000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_METADATA_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_METADATA_BYTES) return null;
    const j = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;

    // images: only from allowed hosts (or this site), stored as a same-origin path when it is ours
    let image: string | null = null;
    const rawImg = str(j.image, 300);
    if (rawImg) {
      const allowed = resolveAllowedUrl(rawImg, publicUrl);
      if (allowed) {
        const own = new URL(publicUrl);
        const iu = new URL(allowed);
        image = iu.host.toLowerCase() === own.host.toLowerCase() ? iu.pathname : allowed;
      }
    }
    return {
      description: str(j.description, 500),
      image,
      website: linkOrNull(j.website),
      twitter: linkOrNull(j.twitter),
      telegram: linkOrNull(j.telegram),
    };
  } catch {
    return null;
  }
}
