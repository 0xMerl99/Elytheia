import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { useFetch } from '../lib/useFetch';
import { useNow, useStream } from '../lib/stream';
import type { Coin, CommentItem, Holder, Trade } from '../lib/types';
import { clsx, copyText, fmtCompact, fmtNum, fmtPct, fmtPrice, fmtQuote, fmtUsd, shortAddr, timeAgo } from '../lib/format';
import { ChainBadge, CoinAvatar, StatusBadge } from '../components/Brand';
import { IArrowLeft, ICheck, ICopy, IExt, IGlobe, IconTelegram, IconX, ILock } from '../components/Icons';
import { PriceChart } from '../components/PriceChart';
import { TradePanel } from '../components/TradePanel';
import { useTradeAdapter } from '../lib/trading';
import { NotFound } from './NotFound';

type Tab = 'trades' | 'holders' | 'thread' | 'about';

export default function CoinPage() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useFetch<{ coin: Coin; siblings: Coin[] }>(`/coins/${id}`);
  const [tab, setTab] = useState<Tab>('trades');
  const [tick, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const now = useNow(15_000);
  const { toast, evmName } = useApp();

  const bump = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      reload(true);
      setTick((t) => t + 1);
    }, 700);
  }, [reload]);

  useStream((e) => {
    if ((e.type === 'trade' || e.type === 'meta') && e.coinId === id) bump();
  });

  useEffect(() => {
    const t = setInterval(bump, 20_000);
    return () => {
      clearInterval(t);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [bump]);

  useEffect(() => {
    setTab('trades');
    window.scrollTo({ top: 0 });
  }, [id]);

  const coin = data?.coin;
  useEffect(() => {
    if (coin) document.title = `${coin.name} ($${coin.symbol}) | Elytheia`;
  }, [coin?.name, coin?.symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !data) {
    return /not found/i.test(error) ? <NotFound what="coin" /> : (
      <div className="page empty-page">
        <h3>Couldn't load this coin</h3>
        <p className="muted">{error}</p>
        <button className="btn ghost" onClick={() => reload()}>Try again</button>
      </div>
    );
  }
  if (!coin) {
    return (
      <div className="page">
        <div className="skeleton" style={{ height: 70, marginBottom: 16 }} />
        <div className="coin-layout">
          <div className="skeleton" style={{ height: 520 }} />
          <div className="skeleton" style={{ height: 420 }} />
        </div>
        {loading ? null : null}
      </div>
    );
  }

  const up = coin.change24 >= 0;

  return (
    <div className="page">
      <div className="crumbs">
        <Link to="/home#coins" className="row gap-sm muted"><IArrowLeft size={15} /> Back to coins</Link>
      </div>

      <div className="coin-head">
        <CoinAvatar coin={coin} size={64} />
        <div className="grow">
          <div className="row gap wrap">
            <h1>{coin.name} <span className="muted" style={{ fontWeight: 600 }}>${coin.symbol}</span></h1>
            <ChainBadge chain={coin.chain} />
            <StatusBadge status={coin.status} model={coin.model} />
          </div>
          <div className="row gap wrap small muted" style={{ marginTop: 6 }}>
            <span className="row gap-sm">
              CA <span className="mono">{shortAddr(coin.address, 6, 6)}</span>
              <CopyBtn text={coin.address} onDone={(ok) => toast(ok ? 'Contract address copied' : 'Copy failed')} />
            </span>
            <span>
              by <Link to={`/u/${coin.creator}`} className="mono accent">{shortAddr(coin.creator)}</Link>
            </span>
            <span>{timeAgo(coin.createdAt, now)}</span>
          </div>
        </div>
        <div className="links">
          {coin.website && <a className="social" href={coin.website} target="_blank" rel="noopener noreferrer nofollow" aria-label="Website"><IGlobe /></a>}
          {coin.twitter && <a className="social" href={coin.twitter} target="_blank" rel="noopener noreferrer nofollow" aria-label="X / Twitter"><IconX /></a>}
          {coin.telegram && <a className="social" href={coin.telegram} target="_blank" rel="noopener noreferrer nofollow" aria-label="Telegram"><IconTelegram /></a>}
        </div>
      </div>

      {data!.siblings.length > 0 && (
        <div className="notice blue small" style={{ marginBottom: 14 }}>
          Same launch on {data!.siblings.map((s, i) => (
            <span key={s.id}>{i > 0 && ', '}<Link to={`/coin/${s.id}`} className="accent"><b>{s.chain === 'sol' ? 'Solana' : evmName}</b> ({fmtUsd(s.mcapUsd)})</Link></span>
          ))}
        </div>
      )}

      <div className="coin-layout">
        <div>
          <div className="stat-strip">
            <div className="s"><small>Market cap</small><b>{fmtUsd(coin.mcapUsd)}</b></div>
            <div className="s"><small>Price</small><b>{fmtPrice(coin.priceUsd, '$')}</b></div>
            <div className="s"><small>24h change</small><b className={up ? 'up' : 'down'}>{fmtPct(coin.change24)}</b></div>
            <div className="s"><small>Volume 24h</small><b>{fmtUsd(coin.vol24Usd)}</b></div>
            <div className="s"><small>Holders</small><b>{fmtNum(coin.holders, 0)}</b></div>
            <div className="s"><small>All-time high</small><b>{fmtUsd(coin.athUsd)}</b></div>
          </div>

          <PriceChart coinId={coin.id} quote={coin.quote} refreshKey={tick} />

          <div className="card mt">
            <div className="tabs" role="tablist">
              {([['trades', `Trades`], ['holders', `Holders (${coin.holders})`], ['thread', 'Thread'], ['about', 'About']] as [Tab, string][]).map(([k, l]) => (
                <button key={k} className={clsx('tab', tab === k && 'on')} onClick={() => setTab(k)} role="tab" aria-selected={tab === k}>
                  {l}
                </button>
              ))}
            </div>
            {tab === 'trades' && <TradesTab coin={coin} tick={tick} now={now} />}
            {tab === 'holders' && <HoldersTab coin={coin} tick={tick} />}
            {tab === 'thread' && <ThreadTab coin={coin} />}
            {tab === 'about' && <AboutTab coin={coin} />}
          </div>
        </div>

        <div className="coin-side">
          <TradePanel coin={coin} onTraded={() => { reload(true); setTick((t) => t + 1); }} meRefreshKey={tick} />
          <CurveCard coin={coin} />
          <RewardsCard coin={coin} tick={tick} />
        </div>
      </div>
    </div>
  );
}

function CopyBtn({ text, onDone }: { text: string; onDone?: (ok: boolean) => void }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="copy"
      aria-label="Copy"
      onClick={async () => {
        const r = await copyText(text);
        onDone?.(r);
        setOk(r);
        setTimeout(() => setOk(false), 1500);
      }}
    >
      {ok ? <ICheck size={12} /> : <ICopy size={12} />}
    </button>
  );
}

/* ------------------------------------------------------------ side cards */

function CurveCard({ coin }: { coin: Coin }) {
  const { chain } = useApp();
  const info = chain(coin.chain);
  const now = useNow(1000);
  if (coin.model === 'pool') {
    const a = info.antiSnipe;
    const age = (now - coin.createdAt) / 1000;
    const left = a ? Math.max(0, a.durationSec - age) : 0;
    return (
      <div className="card">
        <h3 className="row gap-sm"><ILock size={16} /> Uniswap v4 pool · liquidity locked</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          All 1B tokens sit in one Uniswap v4 position seeded at {fmtNum(coin.startMcap, 1)} {coin.quote} market cap. Liquidity can't be pulled by anyone, and any Uniswap-compatible router can trade this pool.
        </p>
        <dl className="kv">
          <dt>Quote asset</dt><dd>{coin.quote}</dd>
          <dt>Pool liquidity</dt><dd>{fmtQuote(coin.liquidityQuote, coin.quote, 2)}</dd>
          <dt>Share sold</dt><dd>{coin.soldPct.toFixed(1)}%</dd>
        </dl>
        {a && left > 0 && (
          <div className="notice small mt-sm">
            <b>Launch protection active</b> · extra fee decays to zero in {Math.ceil(left)}s.
          </div>
        )}
      </div>
    );
  }
  const grad = coin.status === 'graduated';
  return (
    <div className="card">
      <h3>{grad ? '🎓 Graduated' : 'Bonding curve'}</h3>
      <div className={clsx('progress', grad && 'green')}>
        <i style={{ width: `${Math.max(2, coin.progress)}%` }} />
      </div>
      <div className="row between small muted" style={{ marginTop: 6 }}>
        <span>{grad ? 'Curve complete' : `${coin.progress.toFixed(1)}% filled`}</span>
        <span>{fmtNum(coin.raisedQuote, 2)} / {info.graduationQuote} {coin.quote}</span>
      </div>
      <p className="small muted" style={{ margin: '10px 0 0' }}>
        {grad
          ? `The curve filled up and liquidity moved into a locked AMM pool${coin.graduatedAt ? ` ${timeAgo(coin.graduatedAt)}` : ''}. Trading continues at the same price.`
          : `When ${info.graduationQuote} ${coin.quote} has been raised, liquidity graduates to a locked AMM pool and the curve closes.`}
      </p>
    </div>
  );
}

function RewardsCard({ coin, tick }: { coin: Coin; tick: number }) {
  const { toast } = useApp();
  const ad = useTradeAdapter(coin, tick);
  const [busy, setBusy] = useState(false);

  const claimable = (ad.claimable?.holder ?? 0) + (ad.claimable?.creator ?? 0);
  const holders = coin.feeMode === 'holders';

  const claim = async () => {
    if (!ad.ready) return ad.connect();
    setBusy(true);
    try {
      const r = await ad.claim();
      toast(`Claimed ${fmtQuote(r.claimed, r.quote, 6)}`, 'ok');
      await ad.refresh();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card reward-box">
      <h3>{holders ? 'Holder rewards' : 'Creator rewards'}</h3>
      <p className="small" style={{ marginTop: 0, color: '#5e584c' }}>
        {coin.chain === 'sol'
          ? holders
            ? `pump.fun shares this coin's creator fees with everyone holding $${coin.symbol}. It runs inside pump.fun's own program.`
            : `pump.fun pays the creator (${shortAddr(coin.creator)}) 0.30% of every trade into a creator vault shared across all of their pump.fun coins.`
          : holders
            ? `0.5% of every trade is shared across everyone holding $${coin.symbol}, pro-rata. Hold to earn; claim anytime.`
            : `Half of the 1% pool fee on every trade goes to the creator (${shortAddr(coin.creator)}); the other half funds the protocol.`}
        {coin.chain === 'hyp' && ' The creator presses Claim to collect the latest pool fees and be paid.'}
      </p>
      {holders && (
        <div className="row between small" style={{ marginBottom: 8 }}>
          <span className="muted">Paid to holders so far</span>
          <b>{fmtQuote(coin.holderFeesTotal, coin.quote, 4)}</b>
        </div>
      )}
      {ad.ready && (coin.chain === 'hyp' ? holders || ad.isCreator : ad.isCreator) ? (
        <>
          <div className="row between small">
            <span className="muted">Your claimable</span>
            <b>{fmtQuote(claimable, coin.quote, 6)}</b>
          </div>
          {!!ad.claimable?.claimed && ad.claimable.claimed > 0 && (
            <div className="row between xs muted" style={{ marginTop: 3 }}>
              <span>Claimed before</span>
              <span>{fmtQuote(ad.claimable.claimed, coin.quote, 6)}</span>
            </div>
          )}
          <button className="btn gold full mt-sm" disabled={busy || claimable <= 0} onClick={claim}>
            {busy ? <span className="spinner" /> : claimable > 0 ? 'Claim rewards' : 'Nothing to claim yet'}
          </button>
        </>
      ) : (
        !ad.ready && <button className="btn ghost full" onClick={ad.connect}>Connect to see your rewards</button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ tabs */

function TradesTab({ coin, tick, now }: { coin: Coin; tick: number; now: number }) {
  const { data, loading } = useFetch<{ trades: Trade[] }>(`/coins/${coin.id}/trades?limit=50`, [tick]);
  const seen = useRef<Set<number>>(new Set());
  const first = useRef(true);
  const trades = data?.trades ?? [];
  const fresh = new Set<number>();
  if (!first.current) trades.forEach((t) => !seen.current.has(t.id) && fresh.add(t.id));
  useEffect(() => {
    if (data) {
      trades.forEach((t) => seen.current.add(t.id));
      first.current = false;
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !data) return <div className="skeleton" style={{ height: 200 }} />;
  if (!trades.length) return <div className="empty">No trades yet. Be the first to buy.</div>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>Time</th><th>Type</th><th className="num">{coin.quote}</th><th className="num">Tokens</th><th className="num">USD</th><th>Trader</th></tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id} className={clsx(fresh.has(t.id) && 'flash-row')}>
              <td className="muted">{timeAgo(t.createdAt, now)}</td>
              <td className={t.side === 'buy' ? 'up' : 'down'} style={{ fontWeight: 700 }}>{t.side === 'buy' ? 'Buy' : 'Sell'}</td>
              <td className="num">{fmtNum(t.quote, 4)}</td>
              <td className="num">{fmtCompact(t.tokens)}</td>
              <td className="num">{fmtUsd(t.usd, { precise: true })}</td>
              <td><Link to={`/u/${t.user}`} className="mono">{shortAddr(t.user)}</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HoldersTab({ coin, tick }: { coin: Coin; tick: number }) {
  const { data, loading } = useFetch<{ holders: Holder[] }>(`/coins/${coin.id}/holders`, [tick]);
  if (loading && !data) return <div className="skeleton" style={{ height: 200 }} />;
  const list = data?.holders ?? [];
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>#</th><th>Holder</th><th className="num">Tokens</th><th className="num">% supply</th></tr>
        </thead>
        <tbody>
          {list.map((h, i) => (
            <tr key={h.address + i}>
              <td className="muted">{i + 1}</td>
              <td>
                {h.kind === 'pool' ? (
                  <span className="badge lock">{h.address}</span>
                ) : (
                  <>
                    <Link to={`/u/${h.address}`} className="mono">{shortAddr(h.address, 5, 5)}</Link>{' '}
                    {h.kind === 'creator' && <span className="tag">creator</span>}
                  </>
                )}
              </td>
              <td className="num">{fmtCompact(h.amount)}</td>
              <td className="num">{h.pct.toFixed(2)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ThreadTab({ coin }: { coin: Coin }) {
  const { me, ensureAuth, toast } = useApp();
  const { data, setData, loading } = useFetch<{ comments: CommentItem[] }>(`/coins/${coin.id}/comments`);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const now = useNow(30_000);

  const post = async () => {
    if (!ensureAuth()) return;
    setBusy(true);
    try {
      const r = await api<{ comments: CommentItem[] }>(`/coins/${coin.id}/comments`, { body: { text } });
      setData(r);
      setText('');
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="field" style={{ marginBottom: 10 }}>
        <textarea
          className="textarea"
          style={{ minHeight: 64 }}
          maxLength={300}
          placeholder={me ? 'Say something about this coin…' : 'Connect your wallet to post'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="row between">
          <span className="counter">{text.length}/300</span>
          <button className="btn primary sm" disabled={busy || !text.trim()} onClick={post}>{me ? 'Post reply' : 'Connect to reply'}</button>
        </div>
      </div>
      {loading && !data ? (
        <div className="skeleton" style={{ height: 120 }} />
      ) : (data?.comments.length ?? 0) === 0 ? (
        <div className="empty">No replies yet.</div>
      ) : (
        data!.comments.map((c) => (
          <div className="comment" key={c.id}>
            <div className="grow">
              <div className="who">
                <Link to={`/u/${c.user}`} className="mono accent">{shortAddr(c.user)}</Link>
                {c.user === coin.creator && <span className="tag">dev</span>}
                {c.holdingPct > 0.01 && <span className="tag">holds {c.holdingPct.toFixed(2)}%</span>}
                <span>{timeAgo(c.createdAt, now)}</span>
              </div>
              <p>{c.text}</p>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function AboutTab({ coin }: { coin: Coin }) {
  const { chain } = useApp();
  const info = chain(coin.chain);
  return (
    <div>
      <p style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{coin.description || 'The creator has not added a description.'}</p>
      <dl className="kv">
        <dt>Contract</dt><dd className="mono">{shortAddr(coin.address, 10, 8)}</dd>
        <dt>Network</dt><dd>{info.name} · {info.venue}</dd>
        <dt>Total supply</dt><dd>1,000,000,000</dd>
        <dt>Creator</dt><dd><Link to={`/u/${coin.creator}`} className="mono accent">{shortAddr(coin.creator, 6, 6)}</Link></dd>
        <dt>Fee</dt><dd>{coin.chain === 'sol' ? '0.95% protocol + 0.30% creator (pump.fun)' : `${(info.baseFeeBps / 100).toFixed(1)}% per trade · ${coin.feeMode === 'holders' ? '0.5% to holders' : '0.5% to creator'}`}</dd>
        <dt>Liquidity</dt><dd>Locked</dd>
        <dt>Launched</dt><dd>{new Date(coin.createdAt).toLocaleString()}</dd>
        <dt>Trades</dt><dd>{fmtNum(coin.trades, 0)}</dd>
        <dt>Total volume</dt><dd>{fmtUsd(coin.volumeUsd)}</dd>
      </dl>
      <p className="xs muted mt-sm"><IExt size={12} style={{ verticalAlign: -1 }} /> Verify this coin on-chain: {coin.chain === 'sol' ? <a className="accent" href={`https://solscan.io/token/${coin.address}`} target="_blank" rel="noopener noreferrer">Solscan</a> : info.name} · contract <span className="mono">{shortAddr(coin.address, 6, 6)}</span></p>
    </div>
  );
}
