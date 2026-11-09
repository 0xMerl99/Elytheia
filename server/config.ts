import path from 'node:path';
import fs from 'node:fs';
import bs58 from 'bs58';

const root = process.cwd();

// optional .env file; real environment variables win
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  /* no .env file: use defaults */
}

export const PORT = Number(process.env.PORT || 8787);
export const IS_PROD = process.env.NODE_ENV === 'production';
export const DATA_DIR = path.resolve(root, process.env.DATA_DIR || './data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const DB_FILE = path.join(DATA_DIR, 'elytheia.db');
export const DIST_DIR = path.join(root, 'dist');

/**
 * The EVM chain where the Launchpad contract lives: HyperEVM (999, testnet 998), Elysium (99901) or a local anvil (31337).
 * The site is fully usable without it: until HYP_LAUNCHPAD is set the EVM option is simply shown as "not
 * deployed yet" and Solana (pump.fun) works on its own.
 *
 * `rpcUrl` is what THIS SERVER uses to index. `browserRpcUrl` is sent to every visitor (and to their wallet's
 * "add network" prompt): keep a key-bearing (private) RPC URL out of it. It defaults to the public endpoint.
 */
const hypChainId = Number(process.env.HYP_CHAIN_ID || 999);
export const EVM = {
  chainId: hypChainId,
  rpcUrl: process.env.HYP_RPC_URL || 'https://rpc.hyperliquid.xyz/evm',
  browserRpcUrl: process.env.HYP_BROWSER_RPC_URL || 'https://rpc.hyperliquid.xyz/evm',
  launchpad: (process.env.HYP_LAUNCHPAD || '') as `0x${string}` | '',
  startBlock: Number(process.env.HYP_START_BLOCK || 0),
  name: process.env.HYP_CHAIN_NAME || (hypChainId === 999 ? 'HyperEVM' : hypChainId === 998 ? 'HyperEVM Testnet' : `EVM ${hypChainId}`),
  explorer: process.env.HYP_EXPLORER || (hypChainId === 999 ? 'https://hyperevmscan.io' : ''),
  pollMs: Number(process.env.HYP_POLL_MS || 3000),
};

/**
 * Solana mainnet-beta, where pump.fun lives (it has no devnet deployment).
 * The browser never sees this URL: Solana's public RPC rejects browser requests and paid RPCs carry secret keys, so
 * visitors reach it only through the allow-listed proxy at /api/solana-rpc (see server/rpcProxy.ts).
 */
export const SOL = {
  rpcUrl: process.env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com',
  cluster: process.env.SOL_CLUSTER || 'mainnet-beta',
};

/** Public origin of this site; coin metadata URLs are built from it so other sites (pump.fun) can fetch them. */
export const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

/**
 * The project's own public identity, shown on the landing screen.
 * TOKEN_CA is the Solana mint of the project's token (pump.fun). Until it is set the landing shows "Coming soon"
 * instead of a contract address, so a placeholder can never be mistaken for the real one.
 */
function cleanCa(raw: string | undefined): string {
  const v = (raw || '').trim();
  if (!v) return '';
  try {
    if (v.length >= 32 && v.length <= 44 && bs58.decode(v).length === 32) return v;
  } catch {
    /* falls through */
  }
  console.warn(`[config] TOKEN_CA "${v.slice(0, 12)}…" is not a valid Solana address: ignoring it`);
  return '';
}

function cleanXUrl(raw: string | undefined): string {
  const fallback = 'https://x.com/elyonpad';
  try {
    const u = new URL((raw || '').trim() || fallback);
    const host = u.hostname.toLowerCase();
    if (u.protocol === 'https:' && ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(host)) return u.toString().replace(/\/$/, '');
  } catch {
    /* falls through */
  }
  console.warn('[config] X_URL must be an https://x.com/... link: using the default');
  return fallback;
}

export const PROJECT = {
  tokenCa: cleanCa(process.env.TOKEN_CA),
  xUrl: cleanXUrl(process.env.X_URL),
};

export const SESSION_TTL_MS =7 * 24 * 60 * 60 * 1000;
export const MAX_IMAGE_BYTES = 1_500_000;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
