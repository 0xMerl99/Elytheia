import { Link } from 'react-router-dom';
import type { Coin } from '../lib/types';
import { fmtPct, fmtUsd, shortAddr, timeShort, clsx } from '../lib/format';
import { ChainBadge, CoinAvatar, StatusBadge } from './Brand';

export function CoinCard({ coin, fresh = false, now }: { coin: Coin; fresh?: boolean; now?: number }) {
  const up = coin.change24 >= 0;
  return (
    <Link to={`/coin/${coin.id}`} className={clsx('coin-card', fresh && 'fresh')}>
      <div className="top">
        <CoinAvatar coin={coin} size={52} />
        <div className="grow">
          <div className="row between">
            <div className="trunc">
              <span className="name">{coin.name}</span> <span className="sym">${coin.symbol}</span>
            </div>
            <span className="xs muted">{timeShort(coin.createdAt, now)}</span>
          </div>
          <div className="row gap-sm wrap" style={{ marginTop: 4 }}>
            <ChainBadge chain={coin.chain} />
            <StatusBadge status={coin.status} model={coin.model} />
            {coin.feeMode === 'holders' && <span className="badge neutral">Holder rewards</span>}
          </div>
        </div>
      </div>
      <p className="desc" style={{ margin: 0 }}>
        {coin.description || 'No description.'}
      </p>
      <div className="meta">
        <div>
          <small>Mcap</small>
          <b>{fmtUsd(coin.mcapUsd)}</b>
        </div>
        <div>
          <small>24h</small>
          <b className={up ? 'up' : 'down'}>{fmtPct(coin.change24)}</b>
        </div>
        <div>
          <small>Vol 24h</small>
          <b>{fmtUsd(coin.vol24Usd)}</b>
        </div>
      </div>
      {coin.model === 'curve' || coin.status === 'graduated' ? (
        <div>
          <div className={clsx('progress', coin.status === 'graduated' && 'green')}>
            <i style={{ width: `${Math.max(2, coin.progress)}%` }} />
          </div>
          <div className="row between xs muted" style={{ marginTop: 4 }}>
            <span>{coin.status === 'graduated' ? 'Graduated to AMM' : `Bonding curve ${coin.progress.toFixed(0)}%`}</span>
            <span>by {shortAddr(coin.creator)}</span>
          </div>
        </div>
      ) : (
        <div className="row between xs muted">
          <span>Uniswap v4 pool · liquidity locked</span>
          <span>by {shortAddr(coin.creator)}</span>
        </div>
      )}
    </Link>
  );
}

export function CoinCardSkeleton() {
  return <div className="skeleton" style={{ height: 232 }} />;
}
