import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { useNow, useStream } from '../lib/stream';
import type { Coin, GlobalTrade, Stats } from '../lib/types';
import { clsx, fmtNum, fmtPct, fmtUsd, shortAddr } from '../lib/format';
import { ChainBadge, CoinAvatar } from '../components/Brand';
import { CoinCard, CoinCardSkeleton } from '../components/CoinCard';
import { IBolt, ILock, IRocket, IShield } from '../components/Icons';
import { CtaArt, glowPointer, HeroArt, Laurel, Reveal, useOlympusTheme } from '../components/Olympus';
import '../styles/olympus.css';

const SORTS: [string, string][] = [
  ['hot', '🔥 Hot'],
  ['new', 'New'],
  ['mcap', 'Top market cap'],
  ['volume', 'Volume'],
  ['live', 'Live'],
  ['graduated', 'Graduated'],
];
const PAGE = 24;

export default function Home() {
  const [params, setParams] = useSearchParams();
  const sort = SORTS.some(([k]) => k === params.get('sort')) ? params.get('sort')! : 'hot';
  const q = params.get('q') ?? '';
  const chain = params.get('chain') ?? '';
  const nav = useNavigate();
  const { me, openConnect, evmCfg, evmName } = useApp();
  const now = useNow(15_000);
  useOlympusTheme(); // visual theme only: scopes the Olympus styling to this page

  const [stats, setStats] = useState<Stats | null>(null);
  const [ticker, setTicker] = useState<GlobalTrade[]>([]);
  const [king, setKing] = useState<Coin[]>([]);
  const [coins, setCoins] = useState<Coin[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState(q);
  const reqSeq = useRef(0);

  useEffect(() => {
    document.title = 'Elytheia | One launch. Every chain.';
  }, []);

  const loadCoins = useCallback(
    async (silent = false) => {
      const my = ++reqSeq.current;
      if (!silent) setCoins(null);
      setError(null);
      try {
        const qs = new URLSearchParams({ sort, limit: String(PAGE), offset: '0' });
        if (q) qs.set('q', q);
        if (chain) qs.set('chain', chain);
        const r = await api<{ coins: Coin[]; total: number }>(`/coins?${qs}`);
        if (my !== reqSeq.current) return;
        setCoins(r.coins);
        setTotal(r.total);
      } catch (e: any) {
        if (my === reqSeq.current) setError(e.message);
      }
    },
    [sort, q, chain],
  );

  useEffect(() => {
    void loadCoins();
  }, [loadCoins]);

  useEffect(() => setSearch(q), [q]);

  const loadSide = useCallback(async () => {
    try {
      const [s, t, k] = await Promise.all([
        api<Stats>('/stats'),
        api<{ trades: GlobalTrade[] }>('/trades/recent?limit=24'),
        api<{ coins: Coin[] }>('/coins?sort=mcap&limit=3'),
      ]);
      setStats(s);
      setTicker(t.trades);
      setKing(k.coins);
    } catch {
      /* hero still renders */
    }
  }, []);
  useEffect(() => {
    void loadSide();
    const t = setInterval(loadSide, 30_000);
    return () => clearInterval(t);
  }, [loadSide]);

  // live updates (throttled)
  const lastSide = useRef(0);
  const lastList = useRef(0);
  useStream((e) => {
    const t = Date.now();
    if (e.type === 'launch') {
      setFresh((f) => new Set([...f, ...e.coins.map((c) => c.id)]));
      void loadSide();
      if (sort === 'new' && !q && !chain) setCoins((cur) => (cur ? [...e.coins, ...cur].slice(0, PAGE * 4) : cur));
      setTimeout(() => setFresh(new Set()), 4000);
    } else if (e.type === 'trade') {
      if (t - lastSide.current > 4000) {
        lastSide.current = t;
        void loadSide();
      }
      if (t - lastList.current > 12_000) {
        lastList.current = t;
        void loadCoins(true);
      }
    }
  });

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const loadMore = async () => {
    if (!coins) return;
    setLoadingMore(true);
    try {
      const qs = new URLSearchParams({ sort, limit: String(PAGE), offset: String(coins.length) });
      if (q) qs.set('q', q);
      if (chain) qs.set('chain', chain);
      const r = await api<{ coins: Coin[]; total: number }>(`/coins?${qs}`);
      setCoins((cur) => {
        const seen = new Set((cur ?? []).map((c) => c.id));
        return [...(cur ?? []), ...r.coins.filter((c) => !seen.has(c.id))];
      });
      setTotal(r.total);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  };

  // scroll to #coins when the URL asks for it
  useEffect(() => {
    if (window.location.hash === '#coins') document.getElementById('coins')?.scrollIntoView({ behavior: 'smooth' });
  }, [sort, q]);

  const spotlight = king[0];
  const doubled = [...ticker, ...ticker];

  return (
    <div className="oly" onPointerMove={glowPointer}>
      <section className="hero" aria-labelledby="hero-title">
        <HeroArt />
        <div className="hero-inner">
          <span className="eyebrow"><IBolt size={13} /> Multichain launchpad</span>
          <h1 id="hero-title">One launch.<br /><em>Every chain.</em></h1>
          <p className="lead">
            Create a coin once from a single form and launch it on a Solana bonding curve (pump.fun){evmCfg ? ` and a locked-liquidity ${evmName} pool` : ''}.
            Trade straight from your own wallet.
          </p>
          <div className="hero-actions">
            <Link to="/create" className="btn gold lg"><IRocket size={18} /> Launch a coin</Link>
            <a href="#coins" className="btn outline-gold lg" onClick={(e) => { e.preventDefault(); document.getElementById('coins')?.scrollIntoView({ behavior: 'smooth' }); }}>
              Explore coins
            </a>
          </div>
        </div>
        <div className="stats-row">
          <div className="stat"><b>{stats ? fmtNum(stats.coins, 0) : '–'}</b><span>Coins launched</span></div>
          <div className="stat"><b>{stats ? fmtUsd(stats.volume24Usd) : '–'}</b><span>24h volume</span></div>
          <div className="stat"><b>{stats ? fmtNum(stats.graduated, 0) : '–'}</b><span>Graduated</span></div>
          <div className="stat"><b>{stats ? fmtNum(stats.traders24, 0) : '–'}</b><span>Traders 24h</span></div>
        </div>
      </section>

      {ticker.length > 0 && (
        <div className="ticker" aria-label="Live trades">
          <div className="ticker-track">
            {doubled.map((t, i) => (
              <span className="tick" key={`${t.id}-${i}`} aria-hidden={i >= ticker.length}>
                <span className={t.side === 'buy' ? 'b' : 's'}>{t.side === 'buy' ? 'BUY' : 'SELL'}</span>
                <span>{fmtNum(t.quote, 3)} {t.quoteSymbol}</span>
                <span style={{ opacity: 0.6 }}>of</span>
                <Link to={`/coin/${t.coin.id}`}>${t.coin.symbol}</Link>
                <span style={{ opacity: 0.55 }}>by {shortAddr(t.user)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="page">
        {spotlight && !q && (
          <Reveal as="section" aria-label="Top coins">
            <div className="king">
              <div className="king-main">
                <Laurel className="king-laurel" />
                <Link to={`/coin/${spotlight.id}`} className="cover" aria-label={`Open ${spotlight.name}`} />
                <div className="crown">♛ King of the hill</div>
                <div className="row gap" style={{ marginTop: 12 }}>
                  <CoinAvatar coin={spotlight} size={64} />
                  <div>
                    <div className="big">{spotlight.name}</div>
                    <div className="row gap-sm"><span style={{ opacity: 0.7 }}>${spotlight.symbol}</span><ChainBadge chain={spotlight.chain} /></div>
                  </div>
                </div>
                <div className="row gap" style={{ marginTop: 16, gap: 28 }}>
                  <div><div className="xs" style={{ opacity: 0.6 }}>MARKET CAP</div><b style={{ fontSize: 22, fontFamily: 'var(--serif)' }}>{fmtUsd(spotlight.mcapUsd)}</b></div>
                  <div><div className="xs" style={{ opacity: 0.6 }}>24H</div><b style={{ fontSize: 22, fontFamily: 'var(--serif)', color: spotlight.change24 >= 0 ? '#5fe0a8' : '#ff8e96' }}>{fmtPct(spotlight.change24)}</b></div>
                  <div className="hide-mobile"><div className="xs" style={{ opacity: 0.6 }}>HOLDERS</div><b style={{ fontSize: 22, fontFamily: 'var(--serif)' }}>{fmtNum(spotlight.holders, 0)}</b></div>
                </div>
              </div>
              {king.slice(1).map((c, i) => (
                <CoinCard key={c.id} coin={c} now={now} />
              ))}
            </div>
          </Reveal>
        )}

        <Reveal as="section" className="section" id="coins">
          <div className="section-head">
            <div>
              <h2>Launches</h2>
              <div className="muted small">{coins ? `${fmtNum(total, 0)} coin${total === 1 ? '' : 's'}${q ? ` matching “${q}”` : ''}` : 'Loading…'}</div>
            </div>
          </div>
          <div className="toolbar">
            {SORTS.map(([k, label]) => (
              <button key={k} className={clsx('chip', sort === k && 'on')} onClick={() => setParam('sort', k === 'hot' ? '' : k)}>
                {label}
              </button>
            ))}
            <span className="spacer" />
            <select className="select" value={chain} onChange={(e) => setParam('chain', e.target.value)} aria-label="Filter by chain">
              <option value="">All chains</option>
              <option value="sol">Solana</option>
              <option value="hyp">{evmName}</option>
            </select>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setParam('q', search.trim());
              }}
            >
              <input className="input" placeholder="Filter by name or ticker" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Filter coins" />
            </form>
            {(q || chain) && (
              <button className="btn ghost sm" onClick={() => nav('/home#coins')}>Clear</button>
            )}
          </div>

          {error && (
            <div className="notice red">
              Couldn't load coins: {error} <button className="linkish" onClick={() => loadCoins()}>Retry</button>
            </div>
          )}
          {!coins && !error && (
            <div className="coin-grid">{Array.from({ length: 6 }).map((_, i) => <CoinCardSkeleton key={i} />)}</div>
          )}
          {coins && coins.length === 0 && (
            <div className="empty card">
              <h3>{q ? 'No coins match that search' : 'No coins here yet'}</h3>
              <p>{q ? 'Try a different name or ticker. Pasting a pump.fun coin address into the search bar adds it.' : 'Launch the first one, or paste any pump.fun coin address into the search bar above to add an existing coin.'}</p>
              <Link to="/create" className="btn gold">Launch a coin</Link>
            </div>
          )}
          {coins && coins.length > 0 && (
            <>
              <div className="coin-grid">
                {coins.map((c) => (
                  <CoinCard key={c.id} coin={c} fresh={fresh.has(c.id)} now={now} />
                ))}
              </div>
              {coins.length < total && (
                <div className="center mt">
                  <button className="btn ghost" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? <span className="spinner" /> : `Load more (${total - coins.length})`}
                  </button>
                </div>
              )}
            </>
          )}
        </Reveal>

        <div className="ornament" aria-hidden="true"><span /></div>

        <Reveal as="section" className="section" aria-labelledby="how">
          <div className="section-head"><h2 id="how">How it works</h2></div>
          <div className="steps">
            <div className="step">
              <div className="n"><Laurel className="n-laurel" /><span>1</span></div>
              <h3>Create once</h3>
              <p>Name, ticker, image and links. Pick Solana, {evmName} or both. Trading fees pay you; on Solana you can share them with every holder instead.</p>
            </div>
            <div className="step">
              <div className="n"><Laurel className="n-laurel" /><span>2</span></div>
              <h3>Confirm in your wallet</h3>
              <p>Launching is free. Each chain is its own transaction, signed in your own wallet and paid in that chain's currency. This site never holds your funds.</p>
            </div>
            <div className="step">
              <div className="n"><Laurel className="n-laurel" /><span>3</span></div>
              <h3>Trade everywhere</h3>
              <p>Your coin goes live on each venue instantly. Climb the curve on Solana, trade the locked pool on {evmName}, and earn fees from both.</p>
            </div>
          </div>
        </Reveal>

        <Reveal as="section" className="section" aria-labelledby="chains">
          <div className="section-head"><h2 id="chains">Where your coin launches</h2></div>
          <div className="chain-cards">
            <div className="chain-card">
              <span className="badge sol">Solana</span>
              <h3 style={{ marginTop: 10, fontFamily: 'var(--serif)', fontSize: 20 }}>Bonding curve</h3>
              <p className="muted small">Price rises along a curve as people buy. Fill it and the coin graduates into a locked AMM pool.</p>
              <ul>
                <li>Starts at ~28 SOL market cap, graduates at 85 SOL raised</li>
                <li>pump.fun's own fees: 0.95% protocol + 0.30% creator</li>
                <li>Quoted in SOL</li>
              </ul>
            </div>
            <div className="chain-card">
              <span className="badge hyp">{evmName}</span>
              <h3 style={{ marginTop: 10, fontFamily: 'var(--serif)', fontSize: 20 }}>Straight onto Uniswap v4</h3>
              <p className="muted small">Every coin gets its own Uniswap v4 pool, seeded with all 1B tokens. Nobody, including the creator, can pull the liquidity.</p>
              <ul>
                <li>Tradable on any Uniswap-compatible router</li>
                <li><IShield size={13} style={{ verticalAlign: -2 }} /> Anti-snipe fee for the first two minutes</li>
                <li>Quoted in HYPE · <ILock size={13} style={{ verticalAlign: -2 }} /> LP locked</li>
              </ul>
            </div>
          </div>
        </Reveal>

        <Reveal as="section" className="cta-band">
          <CtaArt />
          <Laurel className="cta-laurel" />
          <h2>Every legend has an origin.</h2>
          <p>Give your token a beginning. It takes under a minute and you can start with zero first buy.</p>
          {me ? (
            <Link to="/create" className="btn gold lg"><IRocket size={18} /> Launch a coin</Link>
          ) : (
            <button className="btn gold lg" onClick={() => openConnect()}>Connect wallet to start</button>
          )}
        </Reveal>
      </div>
    </div>
  );
}
