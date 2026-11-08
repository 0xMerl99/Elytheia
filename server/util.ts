import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
export function shortId(len = 10): string {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Tiny fixed-window in-memory rate limiter keyed by ip + bucket. */
export function rateLimit(bucket: string, max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
  }, windowMs).unref();
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = `${bucket}:${req.ip}`;
    const t = Date.now();
    const cur = hits.get(key);
    if (!cur || cur.reset < t) {
      hits.set(key, { n: 1, reset: t + windowMs });
      return next();
    }
    cur.n++;
    if (cur.n > max) return next(new ApiError(429, 'Too many requests, slow down'));
    next();
  };
}

export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** "@handle" or a link -> a full URL on `base` (or the link itself). Throws ApiError on junk. */
export function normalizeSocialLink(raw: string, base: string, label: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (isHttpUrl(v)) return v;
  const handle = v.replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,40}$/.test(handle)) throw new ApiError(400, `${label} must be a handle or a link`);
  return base + handle;
}
