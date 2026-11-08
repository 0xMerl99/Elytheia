export function shortAddr(a: string, left = 4, right = 4): string {
  if (!a) return '';
  if (a.length <= left + right + 1) return a;
  return `${a.slice(0, left)}…${a.slice(-right)}`;
}

/** USD value of `amount` at `price`, or null when no real price is known yet (fmtUsd shows that as an en dash). */
export const usdOf = (amount: number, price: number): number | null => (price > 0 ? amount * price : null);

export function fmtUsd(n: number | null | undefined, opts: { precise?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  if (n < 0) return `-${fmtUsd(-n, opts)}`;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `$${(n / 1e3).toFixed(1)}K`;
  if (abs >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: opts.precise ? 2 : 0 })}`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  if (abs === 0) return '$0';
  return `$${n.toPrecision(2)}`;
}

/** Tiny prices need subscript-style compaction: 0.0000123 -> 0.0₄123 */
export function fmtPrice(n: number | null | undefined, symbol = ''): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const prefix = symbol === '$' ? '$' : '';
  const suffix = symbol && symbol !== '$' ? ` ${symbol}` : '';
  if (n === 0) return `${prefix}0${suffix}`;
  if (n >= 1) return `${prefix}${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}`;
  const exp = Math.floor(Math.log10(n));
  if (exp >= -3) return `${prefix}${n.toFixed(Math.min(8, -exp + 3))}${suffix}`;
  const zeros = -exp - 1;
  const digits = Math.round(n * 10 ** (zeros + 4))
    .toString()
    .padStart(4, '0')
    .slice(0, 4);
  const sub = String(zeros)
    .split('')
    .map((d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)])
    .join('');
  return `${prefix}0.0${sub}${digits}${suffix}`;
}

export function fmtNum(n: number | null | undefined, max = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return n.toLocaleString('en-US', { maximumFractionDigits: max });
}

export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  if (abs >= 1) return n.toFixed(2);
  return n.toPrecision(2);
}

export function fmtQuote(n: number | null | undefined, symbol: string, max = 4): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : max;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: digits })} ${symbol}`;
}

export function fmtPct(n: number | null | undefined, signed = true): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const s = Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(Math.abs(n) >= 100 ? 0 : 1);
  return `${signed && n > 0 ? '+' : ''}${s}%`;
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function timeShort(ts: number, now = Date.now()): string {
  return timeAgo(ts, now).replace(' ago', '');
}

export function clsx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Deterministic hue from a string, used for generated coin avatars. */
export function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function parseAmount(v: string): number {
  const n = Number(v.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
