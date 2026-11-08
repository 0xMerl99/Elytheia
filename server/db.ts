import Database from 'better-sqlite3';
import { DB_FILE } from './config.js';

export const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

db.exec(`
-- one row per wallet address seen on-chain or signed in (EVM checksummed, or Solana base58)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS coins (
  id TEXT PRIMARY KEY,
  launch_id TEXT,
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image TEXT,
  website TEXT,
  twitter TEXT,
  telegram TEXT,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  fee_mode TEXT NOT NULL DEFAULT 'creator',
  status TEXT NOT NULL DEFAULT 'live',
  model TEXT NOT NULL,
  vq INTEGER NOT NULL,
  vt INTEGER NOT NULL,
  real_quote INTEGER NOT NULL DEFAULT 0,
  real_tokens INTEGER NOT NULL,
  sold INTEGER NOT NULL DEFAULT 0,
  reward_index REAL NOT NULL DEFAULT 0,
  creator_fees INTEGER NOT NULL DEFAULT 0,
  holder_fees_total INTEGER NOT NULL DEFAULT 0,
  protocol_fees INTEGER NOT NULL DEFAULT 0,
  volume_quote INTEGER NOT NULL DEFAULT 0,
  volume_usd REAL NOT NULL DEFAULT 0,
  trades INTEGER NOT NULL DEFAULT 0,
  holders INTEGER NOT NULL DEFAULT 0,
  mcap_usd REAL NOT NULL DEFAULT 0,
  ath_usd REAL NOT NULL DEFAULT 0,
  start_mcap INTEGER NOT NULL DEFAULT 0,
  last_trade_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  graduated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_coins_created ON coins(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coins_mcap ON coins(mcap_usd DESC);
CREATE INDEX IF NOT EXISTS idx_coins_creator ON coins(creator_id);
CREATE INDEX IF NOT EXISTS idx_coins_symbol ON coins(symbol COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS holdings (
  coin_id TEXT NOT NULL REFERENCES coins(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL DEFAULT 0,
  snapshot REAL NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  claimed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (coin_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_holdings_user ON holdings(user_id);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coin_id TEXT NOT NULL REFERENCES coins(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  side TEXT NOT NULL,
  quote INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,
  price REAL NOT NULL,
  usd REAL NOT NULL,
  mcap_usd REAL NOT NULL DEFAULT 0,
  sig TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_coin ON trades(coin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_time ON trades(created_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coin_id TEXT NOT NULL REFERENCES coins(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_coin ON comments(coin_id, created_at DESC);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_events (
  key TEXT PRIMARY KEY
);
`);

// additive column migrations (SQLite has no ADD COLUMN IF NOT EXISTS)
function addColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
addColumn('coins', 'metadata_uri', 'TEXT');
addColumn('coins', 'meta_state', "TEXT NOT NULL DEFAULT 'none'"); // none | pending | done | failed
addColumn('coins', 'meta_tries', 'INTEGER NOT NULL DEFAULT 0');
addColumn('coins', 'chain_ref', 'TEXT'); // on-chain identifier: EVM coin id or Solana mint

export interface UserRow {
  id: number;
  address: string;
  created_at: number;
}

export interface CoinRow {
  id: string;
  launch_id: string | null;
  chain: 'sol' | 'hyp';
  address: string;
  name: string;
  symbol: string;
  description: string;
  image: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  creator_id: number;
  fee_mode: 'creator' | 'holders';
  status: 'live' | 'graduated';
  model: 'curve' | 'amm' | 'pool';
  vq: number;
  vt: number;
  real_quote: number;
  real_tokens: number;
  sold: number;
  reward_index: number;
  creator_fees: number;
  holder_fees_total: number;
  protocol_fees: number;
  volume_quote: number;
  volume_usd: number;
  trades: number;
  holders: number;
  mcap_usd: number;
  ath_usd: number;
  start_mcap: number;
  last_trade_at: number;
  created_at: number;
  graduated_at: number | null;
}

export interface HoldingRow {
  coin_id: string;
  user_id: number;
  amount: number;
  snapshot: number;
  pending: number;
  claimed: number;
}

export function getKv(key: string): string | undefined {
  const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | undefined;
  return r?.v;
}
export function setKv(key: string, value: string) {
  db.prepare('INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, value);
}
