export type ChainId = 'sol' | 'hyp';
export type QuoteSymbol = 'SOL' | 'HYPE';

export interface ChainInfo {
  id: ChainId;
  name: string;
  venue: string;
  quote: QuoteSymbol;
  model: 'curve' | 'pool';
  blurb: string;
  launchFee: number;
  baseFeeBps: number;
  creatorFeeBps: number;
  graduationQuote: number;
  antiSnipe: { startBps: number; durationSec: number; maxWalletBps: number; limitSec: number } | null;
  startMcapTiers: number[] | null;
  startMcap: number;
}

export interface Prices {
  SOL: number;
  HYPE: number;
  updatedAt: number;
}

export interface EvmConfig {
  enabled: boolean;
  chainId: number;
  name: string;
  rpcUrl: string;
  launchpad: string | null;
  explorer: string | null;
}

export interface SolanaConfig {
  rpcUrl: string;
  cluster: string;
}

/** The project's own token (TOKEN_CA): identity from the chain, live numbers from DexScreener. See server/projectToken.ts. */
export interface ProjectToken {
  mint: string;
  name: string | null;
  symbol: string | null;
  description: string;
  image: string | null;
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

export interface AppConfig {
  chains: ChainInfo[];
  prices: Prices;
  evm: EvmConfig;
  solana: SolanaConfig;
  /** This site's public origin: coin metadata links are built from it and are permanent on-chain. */
  publicUrl: string;
  /** The project's own identity: its token's Solana mint (null until configured) and official X account. */
  project: { tokenCa: string | null; xUrl: string };
  limits: {
    maxCreatorBuyPct: number;
    maxImageBytes: number;
  };
}

export interface Coin {
  id: string;
  launchId: string | null;
  chain: ChainId;
  quote: QuoteSymbol;
  address: string;
  name: string;
  symbol: string;
  description: string;
  image: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  creator: string;
  feeMode: 'creator' | 'holders';
  status: 'live' | 'graduated';
  model: 'curve' | 'amm' | 'pool';
  priceQuote: number;
  priceUsd: number;
  mcapQuote: number;
  mcapUsd: number;
  athUsd: number;
  volumeUsd: number;
  vol24Usd: number;
  vol1hUsd: number;
  change24: number;
  trades: number;
  holders: number;
  progress: number;
  raisedQuote: number;
  liquidityQuote: number;
  soldPct: number;
  holderFeesTotal: number;
  createdAt: number;
  graduatedAt: number | null;
  lastTradeAt: number;
  startMcap: number;
}

export interface Trade {
  id: number;
  side: 'buy' | 'sell';
  quote: number;
  tokens: number;
  price: number;
  usd: number;
  sig: string;
  user: string;
  createdAt: number;
}

export interface GlobalTrade {
  id: number;
  side: 'buy' | 'sell';
  quote: number;
  usd: number;
  user: string;
  createdAt: number;
  quoteSymbol: QuoteSymbol;
  coin: { id: string; symbol: string; name: string; image: string | null; chain: ChainId };
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Holder {
  address: string;
  amount: number;
  pct: number;
  kind: 'pool' | 'creator' | 'holder';
}

export interface CommentItem {
  id: number;
  text: string;
  user: string;
  createdAt: number;
  holdingPct: number;
}

/** The signed-in wallet (the session identity used for comments and uploads; trading is signed by the wallets themselves). */
export interface Me {
  address: string;
}

export interface Quote {
  ok: boolean;
  error?: string;
  side?: 'buy' | 'sell';
  pay?: number;
  out?: number;
  fee?: number;
  feeBps?: number;
  refund?: number;
  impactPct?: number;
  graduates?: boolean;
  warning?: string;
}

export interface Stats {
  coins: number;
  graduated: number;
  volume24Usd: number;
  volumeAllUsd: number;
  traders24: number;
  trades: number;
}

export interface LaunchCostQuote {
  lines: { label: string; chain: ChainId; asset: QuoteSymbol; amount: number }[];
  chargeSol: number;
  chargeHype: number;
  needSol: number;
  needHype: number;
  canAfford?: boolean;
  antivamp: string | null;
}

export interface Profile {
  address: string;
  joinedAt: number;
  stats: { holdingsUsd: number; pnlUsd: number; claimableUsd: number; coinsCreated: number };
  created: Coin[];
  holdings: {
    coin: Coin;
    amount: number;
    valueQuote: number;
    valueUsd: number;
    boughtQuote: number;
    soldQuote: number;
    pnlQuote: number;
    pnlUsd: number;
    claimableQuote: number;
    claimedQuote: number;
  }[];
  trades: {
    id: number;
    side: 'buy' | 'sell';
    quote: number;
    quoteSymbol: QuoteSymbol;
    tokens: number;
    usd: number;
    createdAt: number;
    coin: { id: string; symbol: string; name: string; image: string | null; chain: ChainId };
  }[];
}
