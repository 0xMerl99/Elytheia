import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useApp, type LoginId } from '../lib/app';
import type { Coin } from '../lib/types';
import { clsx, copyText, fmtNum, fmtUsd, shortAddr, usdOf } from '../lib/format';
import { listWallets } from '../lib/wallet';
import { hasEvmWallet } from '../lib/evm';
import { ChainBadge, CoinAvatar, Logo } from './Brand';
import { IChevDown, ICopy, ISearch, IUser, IWallet, IX, IDownload } from './Icons';

/* ---------------------------------------------------------------- search */

const LOOKS_LIKE_SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function SearchBox() {
  const nav = useNavigate();
  const loc = useLocation();
  const { toast } = useApp();
  const [q, setQ] = useState('');
  const [coins, setCoins] = useState<Coin[]>([]);
  const [users, setUsers] = useState<{ address: string }[]>([]);
  const [searched, setSearched] = useState(false);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(-1);
  const [importing, setImporting] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    setSearched(false);
    if (!term) {
      setCoins([]);
      setUsers([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api<{ coins: Coin[]; users: { address: string }[] }>(`/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal })
        .then((r) => {
          setCoins(r.coins);
          setUsers(r.users);
          setSel(-1);
          setSearched(true);
        })
        .catch(() => {});
    }, 180);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [loc.pathname]);

  const term = q.trim();
  // A pasted Solana address that isn't listed yet can be added straight from the chain.
  const canImport = searched && coins.length === 0 && users.length === 0 && LOOKS_LIKE_SOLANA_ADDRESS.test(term);

  const results: { to: string }[] = [
    ...coins.map((c) => ({ to: `/coin/${c.id}` })),
    ...users.map((u) => ({ to: `/u/${u.address}` })),
  ];

  const go = (to: string) => {
    setOpen(false);
    setQ('');
    nav(to);
  };

  const importCoin = async () => {
    setImporting(true);
    try {
      const r = await api<{ id: string }>('/chain/solana/import', { body: { mint: term } });
      go(`/coin/${r.id}`);
    } catch (e: any) {
      toast(e.message || 'Could not import that coin', 'err');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="hsearch" ref={box} role="search">
      <ISearch />
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => Math.min(results.length - 1, s + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => Math.max(-1, s - 1));
          } else if (e.key === 'Escape') {
            setOpen(false);
          } else if (e.key === 'Enter') {
            if (sel >= 0 && results[sel]) go(results[sel].to);
            else if (canImport) void importCoin();
            else if (term) go(`/home?q=${encodeURIComponent(term)}#coins`);
          }
        }}
        placeholder="Search coins, tickers, or paste an address"
        aria-label="Search coins"
      />
      {open && term && (
        <div className="search-pop">
          {coins.length === 0 && users.length === 0 && !canImport && searched && (
            <div className="muted small" style={{ padding: 12 }}>No matches for “{term}”.</div>
          )}
          {canImport && (
            <button className="search-import" onClick={importCoin} disabled={importing}>
              <span className="ico"><IDownload size={18} /></span>
              <span className="grow">
                <b>{importing ? 'Finding this coin on Solana…' : 'Import this pump.fun coin'}</b>
                <small className="muted" style={{ display: 'block' }}>
                  <span className="mono">{shortAddr(term, 8, 8)}</span> is not listed yet. We'll read it from the chain.
                </small>
              </span>
              {importing && <span className="spinner" />}
            </button>
          )}
          {coins.length > 0 && <div className="group">Coins</div>}
          {coins.map((c, i) => (
            <Link key={c.id} to={`/coin/${c.id}`} className={clsx(sel === i && 'sel')} onClick={() => go(`/coin/${c.id}`)}>
              <CoinAvatar coin={c} size={32} />
              <span className="grow trunc">
                <b>{c.name}</b> <span className="muted">${c.symbol}</span>
              </span>
              <ChainBadge chain={c.chain} />
              <span className="small muted">{fmtUsd(c.mcapUsd)}</span>
            </Link>
          ))}
          {users.length > 0 && <div className="group">Wallets</div>}
          {users.map((u, i) => (
            <Link key={u.address} to={`/u/${u.address}`} className={clsx(sel === coins.length + i && 'sel')} onClick={() => go(`/u/${u.address}`)}>
              <IUser size={18} /> <span className="mono">{shortAddr(u.address, 6, 6)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- header */

export function Header() {
  const { me, logout, openConnect, openWallets, toast, evmCfg, evmAddress, solAddress, nativeBalances } = useApp();
  const [menu, setMenu] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const nav = useNavigate();
  const connected = !!(me || evmAddress || solAddress);
  const primary = me?.address ?? evmAddress ?? solAddress ?? '';

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <header className="header">
      <Logo />
      <nav aria-label="Main">
        <NavLink to="/home" end className={({ isActive }) => (isActive ? 'on' : '')}>Home</NavLink>
        <a href="/home?sort=hot#coins" onClick={(e) => { e.preventDefault(); nav('/home?sort=hot#coins'); }}>Launches</a>
        <NavLink to="/create" className={({ isActive }) => (isActive ? 'on' : '')}>Launch a coin</NavLink>
        <NavLink to="/docs" className={({ isActive }) => (isActive ? 'on' : '')}>Docs</NavLink>
      </nav>
      <div className="right">
        <SearchBox />
        <Link to="/create" className="btn gold sm hide-mobile">Launch a coin</Link>
        {connected ? (
          <>
            <button className="balance-chip" onClick={openWallets} title="Wallets" aria-label="Open wallet balances">
              <IWallet size={15} />
              {evmAddress && <span>{nativeBalances.hype === null ? '…' : fmtNum(nativeBalances.hype, 3)} HYPE</span>}
              {evmAddress && solAddress && <span style={{ opacity: 0.6 }}>·</span>}
              {solAddress && <span>{nativeBalances.sol === null ? '…' : fmtNum(nativeBalances.sol, 3)} SOL</span>}
            </button>
            <span className="connect-wrap" ref={wrap}>
              <button className="btn dark sm" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
                <span className="mono">{shortAddr(primary)}</span> <IChevDown size={14} />
              </button>
              {menu && (
                <div className="menu" role="menu">
                  <div className="menu-note small">
                    <div className="muted xs">Connected wallets</div>
                    {evmAddress && (
                      <div className="row gap-sm">
                        <span className="badge hyp">EVM</span>
                        <span className="mono trunc">{shortAddr(evmAddress, 8, 6)}</span>
                        <button className="copy" onClick={async () => toast((await copyText(evmAddress)) ? 'Address copied' : 'Copy failed', 'info')}><ICopy size={12} /></button>
                      </div>
                    )}
                    {solAddress && (
                      <div className="row gap-sm" style={{ marginTop: 4 }}>
                        <span className="badge sol">Solana</span>
                        <span className="mono trunc">{shortAddr(solAddress, 8, 6)}</span>
                        <button className="copy" onClick={async () => toast((await copyText(solAddress)) ? 'Address copied' : 'Copy failed', 'info')}><ICopy size={12} /></button>
                      </div>
                    )}
                    {!(evmAddress && solAddress) && (evmCfg || !evmAddress) && (
                      <button className="linkish xs" style={{ marginTop: 6 }} onClick={() => { setMenu(false); openConnect(evmAddress ? 'sol' : evmCfg ? 'hyp' : 'sol'); }}>
                        + Connect {evmAddress ? 'a Solana' : evmCfg ? 'an EVM' : 'a Solana'} wallet
                      </button>
                    )}
                  </div>
                  <button onClick={() => { setMenu(false); openWallets(); }}><IWallet size={16} /> Wallet details</button>
                  <button onClick={() => { setMenu(false); nav(`/u/${primary}`); }}><IUser size={16} /> Portfolio &amp; rewards</button>
                  <button onClick={() => { setMenu(false); void logout(); }}><IX size={16} /> Disconnect</button>
                </div>
              )}
            </span>
          </>
        ) : (
          <button className="btn dark sm" onClick={() => openConnect()}>
            <IWallet size={15} /> Connect wallet
          </button>
        )}
      </div>
    </header>
  );
}

/* ----------------------------------------------------------------- modal */

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={clsx('modal', wide && 'wide')} role="dialog" aria-modal="true" aria-label={title} style={{ position: 'relative' }}>
        <button className="icon-btn modal-x" onClick={onClose} aria-label="Close">
          <IX size={18} />
        </button>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- connect modal */

const WALLET_COLORS: Record<string, string> = { phantom: '#ab9ff2', solflare: '#fc8c1c', backpack: '#e33e3f' };

export function ConnectModal() {
  const { connectOpen, closeConnect, login, connectFor, evmCfg, evmName, config } = useApp();
  const [busy, setBusy] = useState<LoginId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (connectOpen) setError(null);
  }, [connectOpen]);

  if (!connectOpen) return null;
  const wallets = listWallets();
  // when opened for a specific chain only show wallets that can trade it
  const showEvm = connectFor !== 'sol';
  const showSol = connectFor !== 'hyp';

  const go = async (id: LoginId) => {
    setBusy(id);
    setError(null);
    try {
      await login(id);
    } catch (e: any) {
      setError(e?.message || 'Could not connect');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="Connect a wallet" onClose={closeConnect}>
      <div className="notice small" style={{ margin: '8px 0 0' }}>
        <b>Live networks.</b> Your wallet signs real transactions. Signing in only asks for a free message signature; every trade is a
        separate transaction you approve. Coins are permissionless and the {evmName} contracts are unaudited, so only use funds you can afford to lose.
      </div>
      <div className="wallet-list">
        {showEvm && (
          <button
            className="wallet-btn"
            disabled={!!busy || !evmCfg}
            onClick={() => (hasEvmWallet() ? go('evm') : window.open('https://metamask.io/download/', '_blank', 'noopener'))}
          >
            <span className="ico" style={{ background: '#11795a' }}>E</span>
            <span className="grow">
              EVM wallet
              <small>
                {!evmCfg
                  ? `${evmName} launchpad is not deployed on this site yet`
                  : hasEvmWallet()
                    ? `Detected · connects to ${config?.evm?.name}`
                    : 'MetaMask, Rabby, Coinbase… · none detected, get one'}
              </small>
            </span>
            {busy === 'evm' && <span className="spinner" />}
          </button>
        )}
        {showSol &&
          wallets.map((w) => (
            <button
              key={w.id}
              className="wallet-btn"
              disabled={!!busy}
              onClick={() => (w.installed ? go(w.id) : window.open(w.installUrl, '_blank', 'noopener'))}
            >
              <span className="ico" style={{ background: WALLET_COLORS[w.id] }}>{w.name[0]}</span>
              <span className="grow">
                {w.name}
                <small>{w.installed ? 'Detected · click to connect' : 'Not installed · get it'}</small>
              </span>
              {busy === w.id && <span className="spinner" />}
            </button>
          ))}
      </div>
      {error && <div className="err small">{error}</div>}
    </Modal>
  );
}

/* ----------------------------------------------------------- wallet modal */

export function WalletModal() {
  const { walletsOpen, closeWallets, evmAddress, solAddress, nativeBalances, prices, config, evmCfg, evmName, toast, refreshNativeBalances, openConnect } = useApp();
  if (!walletsOpen) return null;
  return (
    <Modal title="Your wallets" onClose={closeWallets} wide>
      <p className="muted small" style={{ margin: '0 0 12px' }}>
        You trade straight from your own wallets. There is no deposit, no custody and no in-app swap here: every transaction is signed by
        you and cannot be undone.
      </p>
      <div className="col" style={{ gap: 10 }}>
        <div className="card flat">
          <div className="row between">
            <div>
              <span className="badge hyp">{evmName}</span> {evmCfg && <span className="xs muted">chain {evmCfg.chainId}</span>}
              <div className="mono small" style={{ marginTop: 6 }}>{evmAddress ?? (evmCfg ? 'Not connected' : 'Launchpad not deployed yet')}</div>
            </div>
            {evmAddress ? (
              <div style={{ textAlign: 'right' }}>
                <b style={{ fontSize: 20 }}>{nativeBalances.hype === null ? '…' : fmtNum(nativeBalances.hype, 4)}</b> <span className="muted">HYPE</span>
                <div className="xs muted">{fmtUsd(usdOf(nativeBalances.hype ?? 0, prices.HYPE))}</div>
              </div>
            ) : (
              evmCfg && <button className="btn gold sm" onClick={() => { closeWallets(); openConnect('hyp'); }}>Connect</button>
            )}
          </div>
        </div>
        <div className="card flat">
          <div className="row between">
            <div>
              <span className="badge sol">Solana</span> <span className="xs muted">{config?.solana?.cluster}</span>
              <div className="mono small" style={{ marginTop: 6 }}>{solAddress ?? 'Not connected'}</div>
            </div>
            {solAddress ? (
              <div style={{ textAlign: 'right' }}>
                <b style={{ fontSize: 20 }}>{nativeBalances.sol === null ? '…' : fmtNum(nativeBalances.sol, 4)}</b> <span className="muted">SOL</span>
                <div className="xs muted">{fmtUsd(usdOf(nativeBalances.sol ?? 0, prices.SOL))}</div>
              </div>
            ) : (
              <button className="btn gold sm" onClick={() => { closeWallets(); openConnect('sol'); }}>Connect</button>
            )}
          </div>
        </div>
      </div>
      <div className="row between mt-sm">
        <span className="xs muted">Balances refresh every 15 seconds.</span>
        <button className="linkish small" onClick={() => { void refreshNativeBalances(); toast('Balances refreshed'); }}>Refresh now</button>
      </div>
    </Modal>
  );
}
