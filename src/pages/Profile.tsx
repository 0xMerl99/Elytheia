import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApp } from '../lib/app';
import { useFetch } from '../lib/useFetch';
import type { Profile } from '../lib/types';
import { clsx, copyText, fmtCompact, fmtNum, fmtPct, fmtQuote, fmtUsd, shortAddr, timeAgo } from '../lib/format';
import { BRAND, ChainBadge, CoinAvatar } from '../components/Brand';
import { CoinCard } from '../components/CoinCard';
import { ICopy, IWallet } from '../components/Icons';
import { NotFound } from './NotFound';
import { useTradeAdapter } from '../lib/trading';
import type { Coin } from '../lib/types';

/** Claims on-chain through the right wallet for this coin (the same adapter the coin page uses). */
function ClaimButton({ coin, amount, onDone }: { coin: Coin; amount: number; onDone: () => void }) {
  const ad = useTradeAdapter(coin, 0);
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn gold sm"
      disabled={busy || amount <= 0}
      onClick={async () => {
        if (!ad.ready) return ad.connect();
        setBusy(true);
        try {
          const r = await ad.claim();
          toast(`Claimed ${fmtQuote(r.claimed, r.quote, 6)}`, 'ok');
          await ad.refresh();
          onDone();
        } catch (e: any) {
          toast(e.message, 'err');
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <span className="spinner" /> : 'Claim'}
    </button>
  );
}

type Tab = 'holdings' | 'created' | 'trades';

export default function ProfilePage() {
  const params = useParams();
  const { me, booting, openConnect, toast, evmAddress, solAddress } = useApp();
  const address = params.address ?? me?.address ?? evmAddress ?? solAddress ?? null;
  // "yours" = any wallet you have connected, since rewards are claimed by the wallet that earned them
  const own = !!address && [me?.address, evmAddress, solAddress].includes(address);
  const { data, error, loading, reload } = useFetch<Profile>(address ? `/users/${address}` : null);
  const [tab, setTab] = useState<Tab>('holdings');

  useEffect(() => {
    document.title = `Portfolio | ${BRAND}`;
  }, []);

  if (!address) {
    if (booting) return <div className="page"><div className="skeleton" style={{ height: 200 }} /></div>;
    return (
      <div className="page empty-page">
        <IWallet size={44} />
        <h2 style={{ marginTop: 14 }}>Your portfolio</h2>
        <p className="muted">Connect a wallet to see your holdings, launches and rewards.</p>
        <button className="btn gold lg" onClick={() => openConnect()}>Connect wallet</button>
      </div>
    );
  }

  if (error && !data) {
    if (/no activity|not found/i.test(error)) {
      return (
        <div className="page empty-page">
          <h2>{own ? 'Nothing here yet' : 'No activity for this wallet'}</h2>
          <p className="muted">{own ? 'Make a trade or launch a token and it will show up here.' : 'This wallet has not traded or launched anything.'}</p>
          <p className="mono small muted">{address}</p>
          <Link to="/home" className="btn gold">Back to home</Link>
        </div>
      );
    }
    return <NotFound what="wallet" />;
  }
  if (!data) return <div className="page"><div className="skeleton" style={{ height: 320 }} /></div>;

  const claimableCoins = data.holdings.filter((h) => h.claimableQuote > 0);

  return (
    <div className="page">
      <div className="profile-head">
        <span className="avatar round" style={{ width: 60, height: 60, background: `linear-gradient(145deg, #e0a93a, #0f3a45)`, fontSize: 22 }}>
          {data.address.slice(0, 2)}
        </span>
        <div className="grow">
          <h2 style={{ margin: 0 }}>{own ? 'Your portfolio' : 'Wallet'}</h2>
          <div className="row gap-sm wrap small muted">
            <span className="mono">{shortAddr(data.address, 8, 8)}</span>
            <button className="copy" aria-label="Copy address" onClick={async () => toast((await copyText(data.address)) ? 'Address copied' : 'Copy failed')}><ICopy size={12} /></button>
            <span>· joined {timeAgo(data.joinedAt)}</span>
          </div>
        </div>
      </div>

      <div className="profile-stats">
        <div className="s"><small>Holdings value</small><b>{fmtUsd(data.stats.holdingsUsd)}</b></div>
        <div className="s"><small>Profit / loss</small><b className={data.stats.pnlUsd >= 0 ? 'up' : 'down'}>{data.stats.pnlUsd >= 0 ? '+' : ''}{fmtUsd(data.stats.pnlUsd)}</b></div>
        <div className="s"><small>Claimable rewards</small><b>{fmtUsd(data.stats.claimableUsd, { precise: true })}</b></div>
        <div className="s"><small>Tokens launched</small><b>{data.stats.coinsCreated}</b></div>
      </div>

      {own && claimableCoins.length > 0 && (
        <div className="notice green" style={{ marginBottom: 16 }}>
          You have rewards waiting on {claimableCoins.length} token{claimableCoins.length > 1 ? 's' : ''}. Claim them from the Holdings tab.
        </div>
      )}

      <div className="tabs" role="tablist">
        {([['holdings', `Holdings (${data.holdings.length})`], ['created', `Created (${data.created.length})`], ['trades', 'Trades']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} className={clsx('tab', tab === k && 'on')} onClick={() => setTab(k)} role="tab" aria-selected={tab === k}>{l}</button>
        ))}
      </div>

      {tab === 'holdings' && (
        data.holdings.length === 0 ? (
          <div className="empty card"><h3>No holdings</h3><p>Tokens you buy will appear here.</p><Link to="/home" className="btn gold">Back to home</Link></div>
        ) : (
          <div className="card table-wrap table-card">
            <table className="table stack">
              <thead>
                <tr><th>Token</th><th className="num">Balance</th><th className="num">Value</th><th className="num">P/L</th><th className="num">Rewards</th>{own && <th />}</tr>
              </thead>
              <tbody>
                {data.holdings.map((h) => (
                  <tr key={h.coin.id}>
                    <td data-label="" className="full">
                      <Link to={`/coin/${h.coin.id}`} className="row gap-sm">
                        <CoinAvatar coin={h.coin} size={36} />
                        <span><b>{h.coin.name}</b> <span className="muted mono">${h.coin.symbol}</span><br /><ChainBadge chain={h.coin.chain} /></span>
                      </Link>
                    </td>
                    <td data-label="Balance" className="num">{fmtCompact(h.amount)}</td>
                    <td data-label="Value" className="num">{fmtUsd(h.valueUsd, { precise: true })}</td>
                    <td data-label="P/L" className={clsx('num', h.pnlUsd >= 0 ? 'up' : 'down')}>
                      {h.pnlUsd >= 0 ? '+' : ''}{fmtUsd(h.pnlUsd, { precise: true })}
                      <div className="xs muted">{h.boughtQuote > 0 ? fmtPct((h.pnlQuote / h.boughtQuote) * 100) : ''}</div>
                    </td>
                    <td data-label="Rewards" className="num">{h.claimableQuote > 0 ? fmtQuote(h.claimableQuote, h.coin.quote, 5) : <span className="muted">–</span>}</td>
                    {own && (
                      <td data-label="" className="num full">
                        <ClaimButton coin={h.coin} amount={h.claimableQuote} onDone={() => reload(true)} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="xs muted" style={{ margin: '10px 12px 4px' }}>
              P/L is based on this wallet's trades on this site; tokens moved between wallets aren't counted.
            </p>
          </div>
        )
      )}

      {tab === 'created' && (
        data.created.length === 0 ? (
          <div className="empty card"><h3>No launches yet</h3>{own && <Link to="/create" className="btn gold">Launch a token</Link>}</div>
        ) : (
          <div className="token-grid">{data.created.map((c) => <CoinCard key={c.id} coin={c} />)}</div>
        )
      )}

      {tab === 'trades' && (
        data.trades.length === 0 ? (
          <div className="empty card"><h3>No trades yet</h3></div>
        ) : (
          <div className="card table-wrap table-card">
            <table className="table stack">
              <thead><tr><th>When</th><th>Type</th><th>Token</th><th className="num">Amount</th><th className="num">USD</th></tr></thead>
              <tbody>
                {data.trades.map((t) => (
                  <tr key={t.id}>
                    <td data-label="When" className="muted">{timeAgo(t.createdAt)}</td>
                    <td data-label="Type" className={t.side === 'buy' ? 'up' : 'down'} style={{ fontWeight: 700 }}>{t.side === 'buy' ? 'Buy' : 'Sell'}</td>
                    <td data-label="Token"><Link to={`/coin/${t.coin.id}`} className="row gap-sm"><CoinAvatar coin={t.coin} size={24} /> <span className="mono">${t.coin.symbol}</span></Link></td>
                    <td data-label="Amount" className="num">{fmtNum(t.quote, 4)} {t.quoteSymbol}</td>
                    <td data-label="USD" className="num">{fmtUsd(t.usd, { precise: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      {loading && null}
    </div>
  );
}
