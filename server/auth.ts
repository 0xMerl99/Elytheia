import crypto from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { NextFunction, Request, Response } from 'express';
import { db, type UserRow } from './db.js';
import { getAddress, isAddress, recoverMessageAddress } from 'viem';
import { SESSION_TTL_MS } from './config.js';
import { ApiError } from './util.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
    }
  }
}

export function isValidSolAddress(addr: unknown): addr is string {
  if (typeof addr !== 'string' || addr.length < 32 || addr.length > 44) return false;
  try {
    return bs58.decode(addr).length === 32;
  } catch {
    return false;
  }
}

export function isValidEvmAddress(addr: unknown): addr is `0x${string}` {
  return typeof addr === 'string' && isAddress(addr, { strict: false });
}

/** Canonical form used as the user identity: checksummed for EVM, as-is for Solana. */
export function normalizeAddress(addr: string): string {
  return isValidEvmAddress(addr) ? getAddress(addr) : addr;
}

export function loginMessage(address: string, nonce: string, issuedAt: string): string {
  return [
    'Sign in to ELYONPAD',
    '',
    'This signature proves you own this wallet. It does not trigger a transaction or cost anything.',
    '',
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt}`,
  ].join('\n');
}

export function createNonce(address: string) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const issuedAt = new Date().toISOString();
  const message = loginMessage(address, nonce, issuedAt);
  db.prepare('DELETE FROM nonces WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO nonces(nonce, address, message, expires_at) VALUES(?,?,?,?)').run(
    nonce,
    address,
    message,
    Date.now() + 5 * 60 * 1000,
  );
  return { nonce, message };
}

export function getOrCreateUser(address: string): UserRow {
  const existing = db.prepare('SELECT * FROM users WHERE address = ?').get(address) as UserRow | undefined;
  if (existing) return existing;
  const info = db.prepare('INSERT INTO users(address, created_at) VALUES(?, ?)').run(address, Date.now());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid) as UserRow;
}

export async function verifyLogin(
  rawAddress: string,
  nonce: string,
  signature: string,
): Promise<{ token: string; user: UserRow }> {
  const evm = isValidEvmAddress(rawAddress);
  if (!evm && !isValidSolAddress(rawAddress)) throw new ApiError(400, 'Invalid wallet address');
  const address = normalizeAddress(rawAddress);

  const row = db.prepare('SELECT * FROM nonces WHERE nonce = ? AND address = ?').get(nonce, address) as
    | { message: string; expires_at: number }
    | undefined;
  if (!row || row.expires_at < Date.now()) throw new ApiError(401, 'Sign-in request expired. Try again.');
  // single use
  db.prepare('DELETE FROM nonces WHERE nonce = ?').run(nonce);

  if (evm) {
    // EIP-191 personal_sign: recover the signer and compare
    let recovered: string;
    try {
      recovered = await recoverMessageAddress({ message: row.message, signature: signature as `0x${string}` });
    } catch {
      throw new ApiError(400, 'Malformed signature');
    }
    if (recovered.toLowerCase() !== address.toLowerCase()) throw new ApiError(401, 'Signature does not match this wallet');
  } else {
    let sig: Uint8Array;
    try {
      sig = bs58.decode(signature);
    } catch {
      throw new ApiError(400, 'Malformed signature');
    }
    const ok = nacl.sign.detached.verify(new TextEncoder().encode(row.message), sig, bs58.decode(address));
    if (!ok) throw new ApiError(401, 'Signature does not match this wallet');
  }

  const user = getOrCreateUser(address);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)').run(
    token,
    user.id,
    Date.now() + SESSION_TTL_MS,
  );
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return { token, user };
}

export function userForToken(token: string | undefined): UserRow | undefined {
  if (!token) return undefined;
  return db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`,
    )
    .get(token, Date.now()) as UserRow | undefined;
}

function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7).trim();
  return undefined;
}

/** Attaches req.user when a valid session token is present (never rejects). */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  req.user = userForToken(bearer(req));
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const user = userForToken(bearer(req));
  if (!user) return next(new ApiError(401, 'Connect your wallet to continue', 'auth'));
  req.user = user;
  next();
}

export function logout(req: Request) {
  const t = bearer(req);
  if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
}
