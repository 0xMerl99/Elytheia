import { Link } from 'react-router-dom';
import type { Coin } from '../lib/types';
import { fmtPct, fmtUsd, shortAddr, timeShort, clsx } from '../lib/format';
import { ChainBadge, CoinAvatar, StatusBadge } from './Brand';

/** A token in the explorer grid: identity, headline numbers and where it sits on its curve or pool. */
export function CoinCard({ coin, fresh = false, now }: { coin: Coin; fresh?: boolean; now?: number }) {
  const up = coin.change24 >= 0;
  const onCurve = coin.model === 'curve' || coin.status === 'graduated';
  return (
    <Link to={`/coin/${coin.id}`} className={clsx('token-card', fresh && 'fresh')}>
      <div className="tc-top">
        <CoinAvatar coin={coin} size={52} />
        <div className="tc-id">
          <div className="tc-name trunc">{coin.name}</div>
          <div className="tc-sub">
            <span className="mono">${coin.symbol}</span>
            <span aria-hidden="true">·</span>
            <span>{timeShort(coin.createdAt, now)}</span>
          </div>
        </div>
        <ChainBadge chain={coin.chain} />
      </div>

      <p className="tc-desc">{coin.description || 'No description yet.'}</p>

      <dl className="tc-metrics">
        <div>
          <dt>Market cap</dt>
          <dd>{fmtUsd(coin.mcapUsd)}</dd>
        </div>
        <div>
          <dt>24h</dt>
          <dd className={up ? 'up' : 'down'}>{fmtPct(coin.change24)}</dd>
        </div>
        <div>
          <dt>Volume</dt>
          <dd>{fmtUsd(coin.vol24Usd)}</dd>
        </div>
      </dl>

      {onCurve ? (
        <div className="tc-curve">
          <div className={clsx('progress', coin.status === 'graduated' && 'green')}>
            <i style={{ width: `${Math.max(2, coin.progress)}%` }} />
          </div>
          <div className="row between xs muted">
            <span>{coin.status === 'graduated' ? 'Graduated to AMM' : `Bonding curve ${coin.progress.toFixed(0)}%`}</span>
          </div>
        </div>
      ) : (
        <div className="tc-curve xs muted">Uniswap v4 pool · liquidity locked</div>
      )}

      <div className="tc-foot">
        <div className="row gap-sm wrap">
          <StatusBadge status={coin.status} model={coin.model} />
          {coin.feeMode === 'holders' && <span className="badge neutral">Holder rewards</span>}
        </div>
        <span className="xs muted mono">by {shortAddr(coin.creator)}</span>
      </div>
    </Link>
  );
}
