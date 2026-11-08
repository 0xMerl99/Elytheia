import { Link } from 'react-router-dom';
import { hueOf, clsx } from '../lib/format';
import type { ChainId } from '../lib/types';
import { useApp } from '../lib/app';
import { ILock } from './Icons';

export const BRAND = 'Elytheia';

/** The Elytheia emblem (public/brand/logo.png): replace that file to change the logo everywhere. */
export function LogoMark({ size = 32 }: { size?: number }) {
  return <img className="logo-mark" src="/brand/logo.png" width={size} height={size} alt="" decoding="async" draggable={false} />;
}

export function Logo() {
  return (
    <Link to="/home" className="logo" aria-label={`${BRAND} home`}>
      <LogoMark />
      <span>{BRAND.toUpperCase()}</span>
    </Link>
  );
}

export function CoinAvatar({
  coin,
  size = 48,
  round = false,
}: {
  coin: { symbol: string; image: string | null };
  size?: number;
  round?: boolean;
}) {
  const hue = hueOf(coin.symbol);
  if (coin.image) {
    return (
      <span className={clsx('avatar', round && 'round')} style={{ width: size, height: size }}>
        <img src={coin.image} alt="" loading="lazy" />
      </span>
    );
  }
  return (
    <span
      className={clsx('avatar', round && 'round')}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `linear-gradient(145deg, hsl(${hue} 70% 52%), hsl(${(hue + 48) % 360} 68% 36%))`,
      }}
      aria-hidden="true"
    >
      {coin.symbol.slice(0, 2).toUpperCase()}
    </span>
  );
}

export function ChainBadge({ chain, name }: { chain: ChainId; name?: string }) {
  const { evmName } = useApp();
  return <span className={clsx('badge', chain)}>{name ?? (chain === 'sol' ? 'Solana' : evmName)}</span>;
}

export function StatusBadge({ status, model }: { status: 'live' | 'graduated'; model: 'curve' | 'amm' | 'pool' }) {
  if (status === 'graduated') return <span className="badge grad">Graduated</span>;
  if (model === 'pool')
    return (
      <span className="badge lock">
        <ILock size={11} /> Locked pool
      </span>
    );
  return (
    <span className="badge live">
      <span className="dot pulse" /> Live
    </span>
  );
}
